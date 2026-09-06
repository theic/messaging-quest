// The panel: one card, dealt by the local server, and the whole interface.
// There is no list to pick from and no landing screen — opening the panel
// shows the next action, answering it shows the following one. The rule
// inherited from the predecessor and kept on purpose: whatever state things
// are in, there is one obvious thing to press.
//
// Everything is the server's decision. This file renders the deck, sends the
// pressed button's id back, and handles the three things only a browser can
// do: putting a draft into the platform's real composer (the service worker
// does it through Chrome's own input pipeline; the human still presses the
// platform's own button), bringing a task's tab to the front, and talking to
// the strategist. From 0.6.0 it also shows which PROJECT the deck belongs to
// and lets the operator switch or start one — the deck of a fresh project
// begins at the first setup card, same as a fresh install.

import { renderCard } from "./card.js";

// In the extension the server is looked up in storage (8787 unless changed);
// served as a page (/panel/ on the server itself), the server is by definition
// the origin that served it.
const DEFAULT_BASE = location.protocol.startsWith("http") ? location.origin : "http://127.0.0.1:8787";
let base = DEFAULT_BASE;

// The panel also opens as a plain page (development, and the server's own
// smoke tests). Everything chrome-only degrades: storage falls back to the
// default base, opening tabs falls back to window.open, and the insert flow
// says copy-paste instead of typing it in.
const ext = typeof chrome !== "undefined" && chrome.storage ? chrome : null;

const $ = (id) => document.getElementById(id);
const cardHost = $("card"), jobsLine = $("jobs"), errorLine = $("error"), answerBox = $("answer"), projectLine = $("project-line");

let current = null;      // the card on screen
let pollTimer = null;
let projectShown = null; // the project id the line was last drawn for

/* ------------------------------------------------------------------- deck */

async function load() {
  try {
    const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const { cards, jobs, control, tasks, project } = await res.json();
    // The card first: show() clears the notice line, and the hints that
    // follow are allowed to fill it again.
    show(cards?.[0] ?? null);
    showJobs(jobs, control, tasks);
    showProject(project);
    schedule(cards?.[0], jobs, tasks);
  } catch {
    showDown();
  }
}

function show(card) {
  errorLine.hidden = true;
  current = card;
  if (!card) {
    cardHost.replaceChildren();
    const p = document.createElement("p");
    p.className = "es-help";
    p.textContent = "Nothing to show — the deck is empty.";
    cardHost.append(p);
    return;
  }
  // A screenshot rides as a server path; the panel knows which server.
  if (card.image && !/^(https?:|data:)/i.test(card.image)) card = { ...card, image: absolute(card.image) };
  renderCard(cardHost, card, act);
  cardHost.firstChild?.classList.toggle("es-waiting", /wait|probing/.test(card.kind ?? ""));
}

/** The server being down is a card too — the honest one, with the command. */
function showDown() {
  current = null;
  renderCard(cardHost, {
    id: "panel.down", kind: "panel.down",
    question: "The Messaging Quest server is not running.",
    help: `In the folder that holds .mq/:\n\n  npm run serve\n\nThe panel talks only to ${base} — your own machine, nothing else.`,
    primary: { id: "retry", label: "Try again" },
  }, () => load());
}

function showJobs(jobs, control, tasks) {
  const parts = (jobs ?? []).map((j) => `${j.label}${j.note ? ` — ${j.note}` : ""}`);
  // Colleagues at work: silence means working; a question is a card. The
  // tab each holds is one click away in the "Messaging Quest" group.
  for (const t of tasks ?? []) parts.push(`${t.title} — ${t.status === "blocked" ? "needs you" : "working"}${t.tabId ? " in its tab" : ""}`);
  if (!(tasks ?? []).length) for (const l of control?.leases ?? []) parts.push(`${l.task || "a task"} holds ${l.tabs.length === 1 ? "a tab" : `${l.tabs.length} tabs`}`);
  jobsLine.textContent = parts.join(" · ");
  updateGrantHint(control);
}

/**
 * A task's tab is on a site this extension may not read yet. Chrome only
 * grants inside a click, so the ask is a button here — never a dialog from a
 * worker nobody is looking at.
 */
function updateGrantHint(control) {
  const origins = control?.grants ?? [];
  if (!ext || !origins.length || current?.kind === "grant.ask") return;   // the card on screen IS the ask
  errorLine.hidden = false;
  errorLine.replaceChildren();
  errorLine.append(`A task opened ${origins.map((o) => o.replace(/^https?:\/\//, "")).join(", ")} and this browser has not allowed the extension there yet. `);
  for (const origin of origins) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `Allow ${origin.replace(/^https?:\/\//, "")}`;
    b.addEventListener("click", async () => {
      const ok = await ext.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
      if (!ok) return;
      await fetch(`${base}/api/control/granted`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }),
      }).catch(() => {});
      errorLine.hidden = true;
      load();
    });
    errorLine.append(b);
  }
}

/* --------------------------------------------------------------- project */

/**
 * Which project this deck is: a line under the card with a picker. Switching
 * writes the pointer on the server, so the dashboard, the CLI and this panel
 * move together; "new project…" asks for a name and starts its setup here.
 */
function showProject(project) {
  if (!projectLine || !project) return;
  const key = `${project.id}:${(project.all ?? []).map((p) => p.id).join(",")}`;
  if (projectShown === key) return;
  projectShown = key;
  projectLine.replaceChildren();
  projectLine.append("project: ");
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "project");
  for (const p of project.all ?? [{ id: project.id, name: project.name }]) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name || p.id;
    if (p.id === project.id) o.selected = true;
    sel.append(o);
  }
  const make = document.createElement("option");
  make.value = "__new";
  make.textContent = "＋ new project…";
  sel.append(make);
  sel.addEventListener("change", async () => {
    if (sel.value === "__new") {
      const name = prompt("Name the project (a brand, a product):", "");
      sel.value = project.id;
      if (!name || !name.trim()) return;
      await switchProject({ action: "new", name: name.trim() });
      return;
    }
    if (sel.value !== project.id) await switchProject({ action: "use", id: sel.value });
  });
  projectLine.append(sel);
}

async function switchProject(body) {
  try {
    const res = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json();
    if (out.error) { errorLine.textContent = out.error; errorLine.hidden = false; return; }
    projectShown = null;
    answerBox.hidden = true;
    load();
  } catch {
    showDown();
  }
}

/** Waits poll themselves; everything else refreshes on act or on the alarm.
 *  A colleague at work is a wait too — its question or its result is the
 *  next card, and it arrives on the runtime's clock, not on a click. */
function schedule(card, jobs, tasks) {
  clearTimeout(pollTimer);
  const waiting = /wait|probing/.test(card?.kind ?? "") || (jobs ?? []).length > 0 || (tasks ?? []).some((t) => t.status === "running");
  if (waiting) pollTimer = setTimeout(load, 4000);
}

/* -------------------------------------------------------------------- act */

async function act({ action, choice, choices, text }) {
  if (!current) return;

  // The client-side actions; the server hears about them at "posted".
  if (action === "insert" && current.data?.url) return insertFlow(current, text);
  // A site the extension may not read yet: Chrome grants only inside the
  // click that asked, so the card's own button is where the asking happens.
  if (action === "allow" && current.data?.origin) {
    if (!ext) { errorLine.textContent = "Open the Messaging Quest side panel in Chrome and press Allow there — Chrome asks for a site permission only from the extension itself."; errorLine.hidden = false; return; }
    const origin = current.data.origin;
    const ok = await ext.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!ok) { errorLine.textContent = `Chrome did not grant ${origin.replace(/^https?:\/\//, "")} — the task stays paused until it is allowed.`; errorLine.hidden = false; return; }
    await fetch(`${base}/api/control/granted`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }),
    }).catch(() => {});
    load();
    return;
  }
  if (action === "open" && current.links?.[0]) {
    openTab(absolute(current.links[0].href));
    return;
  }
  // A paused worker's tab, brought to the front — only a browser can do it,
  // and only this one holds the tab. Served as a page, the note is honest.
  if (action === "show" && current.data?.tabId) {
    if (!ext) { errorLine.textContent = "The tab is in the Chrome window where the extension runs — look for the Messaging Quest tab group."; errorLine.hidden = false; return; }
    try {
      const t = await ext.tabs.get(current.data.tabId);
      await ext.windows.update(t.windowId, { focused: true });
      await ext.tabs.update(t.id, { active: true });
    } catch {
      errorLine.textContent = "That tab is gone — the task will open another when it needs one.";
      errorLine.hidden = false;
    }
    return;
  }

  try {
    const res = await fetch(`${base}/api/cards/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: current.id, action, choice, choices, text }),
    });
    const out = await res.json();
    if (out.error) { errorLine.textContent = out.error; errorLine.hidden = false; return; }
    load();
  } catch {
    showDown();
  }
}

const absolute = (href) => (/^https?:\/\//i.test(href) ? href : base + href);
const openTab = (url) => (ext ? ext.tabs.create({ url }) : window.open(url, "_blank", "noopener"));
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/* ----------------------------------------------------- open thread & type */

/**
 * The posting flow, with the click order that matters: copy first (opening the
 * tab takes the panel's focus, and if Chrome refuses the injection the text is
 * already on the clipboard), then the visible per-site permission, then the
 * tab, then asks the service worker to put the draft in (insertDraft). The
 * human reads the draft in the platform's own composer and presses the
 * platform's own button — nothing here can submit, by construction.
 */
async function insertFlow(card, editedText) {
  const draft = (editedText ?? "").trim() || card.data.draft;
  const button = card.data.submit || "the platform's own button";
  errorLine.hidden = true;

  try { await navigator.clipboard.writeText(draft); } catch { /* still worth trying to type it in */ }

  if (!ext) {
    openTab(card.data.url);
    note("Copied to your clipboard — paste it into the reply box. (Typing it in only works from the installed extension.)", card, draft);
    return;
  }

  const origin = originOf(card.data.url);
  const granted = origin ? await ext.permissions.request({ origins: [`${origin}/*`] }).catch(() => false) : false;

  const tab = await ext.tabs.create({ url: card.data.url, active: true });

  if (!granted) {
    note(`Copied to your clipboard — paste it into the reply box. (Typing it in needs the ${origin ? origin.replace(/^https?:\/\//, "") : "site"} permission.)`, card, draft);
    return;
  }

  await loaded(tab.id);
  await new Promise((r) => setTimeout(r, 800)); // the SPA settles after "load"
  // The service worker holds the one debugger session and does it the way a
  // person does: a real click on the opener if the box is closed, a real
  // click into the box, the draft pasted as one piece (control.js
  // insertDraft). The composer's words are the platform's, off the card.
  let res = null;
  try { res = await ext.runtime.sendMessage({ type: "insert", tabId: tab.id, text: draft, spec: card.data.insert ?? {} }); } catch { res = null; }
  const ok = Boolean(res?.ok);

  note(ok
    ? `Pasted into the composer. Read it there, press ${button} — then tell me:`
    : res?.reason === "not_granted"
      ? "Copied to your clipboard — paste it into the reply box. (Putting it there needs the site permission.) Then tell me:"
      : "Could not find the composer — the draft is on your clipboard, paste it in. Then tell me:", card, draft);
}

/** After the thread opens, the card becomes the confirm: posted, or not. */
function note(text, card, posted = "") {
  renderCard(cardHost, {
    id: card.id, kind: "panel.confirm",
    eyebrow: card.eyebrow,
    question: "Did it go up?",
    help: text,
    primary: { id: "posted", label: "I posted it" },
    secondary: { id: "skip", label: "I didn't" },
  }, ({ action }) => {
    current = card;
    act({ action: action === "skip" ? "skip" : "posted", choice: null, choices: [], text: action === "skip" ? "" : posted });
  });
}

const loaded = (tabId) =>
  new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") { ext.tabs.onUpdated.removeListener(done); resolve(); }
    };
    ext.tabs.onUpdated.addListener(done);
    setTimeout(() => { ext.tabs.onUpdated.removeListener(done); resolve(); }, 15000);
  });

/* ------------------------------------------------------------- strategist */

async function ask() {
  const box = $("ask");
  const q = box.value.trim();
  if (!q) return;
  box.value = "";
  answerBox.hidden = false;
  answerBox.textContent = "…";
  try {
    const res = await fetch(`${base}/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: q, thread: "panel" }),
    });
    const out = await res.json();
    answerBox.textContent = out.reply ?? (out.how ? `${out.error}.\n${out.how}` : out.error ?? "no answer");
    // A turn may have dealt a card — a proposal, a campaign, a question.
    load();
  } catch {
    answerBox.textContent = "The server is not running.";
  }
}

/* ------------------------------------------------------------------- boot */

$("send").addEventListener("click", ask);
$("ask").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });

const savedBase = ext ? ext.storage.local.get({ base: DEFAULT_BASE }) : Promise.resolve({ base: DEFAULT_BASE });
savedBase.then(({ base: saved }) => {
  base = saved;
  const line = $("server-line");
  line.textContent = `server: ${base} · `;
  const a = document.createElement("a");
  a.href = "#";
  a.textContent = "change";
  a.addEventListener("click", async (e) => {
    e.preventDefault();
    const next = prompt("Messaging Quest server address", base);
    if (!next) return;
    base = next.replace(/\/$/, "");
    if (ext) await ext.storage.local.set({ base });
    line.firstChild.textContent = `server: ${base} · `;
    projectShown = null;
    load();
  });
  line.append(a);
  load();
});
