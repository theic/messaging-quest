// The panel: the deck, dealt by the local server, on the first tab — and,
// from 0.8.0, three more tabs beside it so the panel stands on its own:
// Campaigns (what you are trying, each with its numbers, a focus for the
// deck, a room to search under it), Rooms (what is watched, what is due,
// a room to try), Settings (where the models run, the key, the seats, the
// account, the project). The rule inherited from the predecessor and kept on
// purpose: whatever state things are in, there is one obvious thing to
// press — and now, one obvious place to look for the rest.
//
// Everything is the server's decision. This file renders what it is told,
// sends the pressed button back, and handles the three things only a
// browser can do: putting a draft into the platform's real composer (the
// service worker does it through Chrome's own input pipeline; the human
// still presses the platform's own button), bringing a task's tab to the
// front, and talking to the strategist. Every label on screen is text set
// with textContent — some of it was written by strangers.

import { renderCard } from "./card.js";
import { suggestionsFor } from "./suggest.js";

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
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null && text !== "") node.textContent = text;
  return node;
};
const btn = (label, onClick, className = "es-small") => {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
};
const ago = (iso) => {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const h = (Date.now() - d) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const cardHost = $("card"), statusBox = $("status"), errorLine = $("error"), answerBox = $("answer"), focusLine = $("focus-line"), suggestBox = $("suggest");
const VIEWS = { deck: $("view-deck"), campaigns: $("view-campaigns"), rooms: $("view-rooms"), settings: $("view-settings") };

let current = null;      // the card on screen
let shownSig = null;     // the card as drawn — redrawn only when the deck's first card changes
let INSTANCE = null;     // this profile's worker on the lane; the deck poll carries it so new tabs open where the panel is
let deckCards = [];      // every card dealt, the one on screen first
let pollTimer = null;
let projectShown = null; // the project key the picker was last drawn for
let state = null;        // /api/panel — what the other tabs show
let view = "deck";

/* ------------------------------------------------------------------ fetch */

const getJSON = async (path) => {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`server said ${res.status}`);
  return res.json();
};
const postJSON = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let out = null;
  try { out = await res.json(); } catch { out = { error: `server said ${res.status}` }; }
  return out ?? {};
};

/* ------------------------------------------------------------------- deck */

async function load() {
  try {
    const [deck, st] = await Promise.all([getJSON(INSTANCE ? `/api/cards?instance=${encodeURIComponent(INSTANCE)}` : "/api/cards"), getJSON("/api/panel").catch(() => null)]);
    const { cards, jobs, control, tasks, project, brain, recent } = deck;
    if (st) state = st;
    deckCards = cards ?? [];
    // The card first: show() clears the notice line, and the hints that
    // follow are allowed to fill it again. Redrawn only when it CHANGED —
    // the panel now polls while idle too, and a poll must never wipe the
    // words the operator is editing in the card's field.
    const first = cards?.[0] ?? null;
    const sig = JSON.stringify(first);
    if (sig !== shownSig) { show(first); shownSig = sig; }
    showStatus(jobs, control, tasks, recent);
    showProject(project);
    showFocus();
    showBadges(cards);
    showSuggestions(cards?.[0] ?? null, brain !== false);
    if (view !== "deck") drawView();
    schedule(cards?.[0], jobs, tasks);
  } catch {
    showDown();
  }
}

function show(card) {
  errorLine.hidden = true;
  current = card;
  if (!card) {
    cardHost.replaceChildren(el("p", "es-help", "Nothing to show — the deck is empty."));
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
  shownSig = null;
  state = null;
  suggestBox.hidden = true;
  LOCAL.clear();
  showStatus([], null, [], []);
  renderCard(cardHost, {
    id: "panel.down", kind: "panel.down",
    question: "The Messaging Quest server is not running.",
    help: `In the folder that holds .mq/:\n\n  node bin/mq.mjs serve\n\nThe panel talks only to ${base} — your own machine, nothing else.`,
    primary: { id: "retry", label: "Try again" },
  }, () => load());
  for (const [k, node] of Object.entries(VIEWS)) if (k !== "deck") node.replaceChildren(el("p", "es-help", "The server is not running — the Next tab says how to start it."));
}

/* -------------------------------------------------------------- the strip */

/**
 * One place, at the top, on every tab, for everything that is happening
 * (0.9.1): the server's jobs — the judge, the writer, a read — with their
 * progress and how long they have run; the colleagues in their tabs; the
 * panel's own work, a question in flight or a thread being opened; and,
 * when nothing runs, what last finished and how it went. Silence is never
 * left to mean "working": a thing that runs is named while it runs, and a
 * thing that failed says so here rather than nowhere.
 */
const LOCAL = new Map();     // the panel's own work: key → { label, at }
let served = { jobs: [], control: null, tasks: [], recent: [] };
let ticker = null;

const working = (key, label) => { LOCAL.set(key, { label, at: Date.now() }); drawStatus(); };
const finished = (key) => { LOCAL.delete(key); drawStatus(); };

function showStatus(jobs, control, tasks, recent) {
  served = { jobs: jobs ?? [], control, tasks: tasks ?? [], recent: recent ?? [] };
  drawStatus();
  updateGrantHint(control);
}

const elapsed = (since) => {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function drawStatus() {
  const lines = [];
  for (const w of LOCAL.values()) lines.push({ text: w.label, since: w.at, live: true });
  for (const j of served.jobs) {
    const count = j.total ? ` ${j.done}/${j.total}` : "";
    lines.push({ text: `${j.label}${count}${j.note && j.note !== "starting" ? ` — ${j.note}` : ""}`, since: Date.parse(j.startedAt) || null, live: true });
  }
  // Colleagues at work: a question is a card; the rest is said here. The
  // tab each holds is one click away in the "Messaging Quest" group.
  for (const t of served.tasks) lines.push({ text: `${t.title} — ${t.status === "blocked" ? "needs you on the card" : "reading in its tab"}`, since: null, live: t.status !== "blocked" });
  if (!served.tasks.length) for (const l of served.control?.leases ?? []) lines.push({ text: `${l.task || "a task"} holds ${l.tabs.length === 1 ? "a tab" : `${l.tabs.length} tabs`}`, since: null, live: true });
  // The extension loaded in more than one Chrome profile: every worker is on
  // the lane, and a tab is reachable only from the profile that opened it.
  // The engine opens its tabs where the panel is; this says so, in both.
  const profiles = served.control?.instances ?? 0;
  if (profiles > 1) lines.push({ text: `The extension is loaded in ${profiles} Chrome profiles — tabs open in the one whose panel is open (the first, when both are). Load it in one.`, since: null, live: false, warn: true });
  const busy = lines.some((l) => l.live);
  if (!busy) {
    const r = served.recent[0];
    if (r) lines.push({ text: `${r.status === "ok" ? "Done" : "Failed"}: ${r.label.toLowerCase()}${r.error ? ` — ${r.error}` : r.note && r.note !== "done" ? ` — ${r.note}` : ""} · ${ago(r.finishedAt)}`, since: null, live: false, failed: r.status !== "ok" });
    else lines.push({ text: "Nothing running.", since: null, live: false, quiet: true });
  }
  statusBox.replaceChildren();
  statusBox.classList.toggle("es-status-busy", busy);
  for (const l of lines) {
    const line = el("div", `es-status-line${l.failed ? " es-status-failed" : ""}${l.quiet ? " es-status-quiet" : ""}${l.warn ? " es-status-warn" : ""}`);
    const dot = el("span", `es-status-dot${l.live ? " es-live" : ""}`);
    dot.setAttribute("aria-hidden", "true");
    line.append(dot, el("span", "es-status-text", l.text));
    if (l.since) line.append(el("span", "es-status-time", elapsed(l.since)));
    statusBox.append(line);
  }
  statusBox.hidden = false;
  // The clock runs while anything does: a count that moves is the plainest
  // sign that something is happening.
  if (busy && !ticker) ticker = setInterval(drawStatus, 1000);
  if (!busy && ticker) { clearInterval(ticker); ticker = null; }
}

/** The counts on the tabs: cards that ask, campaigns, reads due, and a dot
 *  on Settings while no model can be filled. A wait of any kind is not an ask. */
function showBadges(cards) {
  const asks = (cards ?? []).filter((c) => !/^(onboard\.wait|onboard\.probing|work\.quiet)$|\.wait$/.test(c.kind ?? c.id)).length;
  badge("badge-deck", asks > 1 ? asks : 0);
  badge("badge-campaigns", state?.campaigns?.filter((c) => c.status === "active").length ?? 0);
  badge("badge-rooms", state?.sources?.filter((s) => s.due).length ?? 0);
  const noModel = state && state.settings.plan !== "local" && !state.settings.key.set;
  badge("badge-settings", noModel ? "!" : 0);
}
const badge = (id, n) => { const b = $(id); if (!b) return; b.hidden = !n; b.textContent = n ? String(n) : ""; };

/** What people typically ask, under the card: a question goes to the
 *  specialist through the same box as a typed one; a place goes to its tab.
 *  Drawn from the state, so the campaign is named and the waiting counted. */
function showSuggestions(card, brain) {
  const chips = state ? suggestionsFor({ state, card, brain }) : [];
  suggestBox.replaceChildren();
  suggestBox.hidden = !chips.length;
  if (!chips.length) return;
  suggestBox.append(el("p", "es-suggest-label", brain ? "Ask your specialist" : "Where to go"));
  const strip = el("div", "es-chips");
  for (const c of chips) {
    strip.append(c.ask
      ? btn(c.label, () => ask(c.ask), "es-chip")
      : btn(c.label, () => showView(c.view), "es-chip es-chip-go"));
  }
  suggestBox.append(strip);
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
    const b = el("button", null, `Allow ${origin.replace(/^https?:\/\//, "")}`);
    b.type = "button";
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
 * Which project this deck is: the picker in the header. Switching writes
 * the pointer on the server, so the dashboard, the CLI and this panel move
 * together; a new one is made on the Settings tab.
 */
function showProject(project) {
  const sel = $("project");
  if (!sel || !project) return;
  const key = `${project.id}:${(project.all ?? []).map((p) => `${p.id}=${p.name}`).join(",")}`;
  if (projectShown === key) return;
  projectShown = key;
  sel.replaceChildren();
  for (const p of project.all ?? [{ id: project.id, name: project.name }]) {
    const o = el("option", null, p.name || p.id);
    o.value = p.id;
    if (p.id === project.id) o.selected = true;
    sel.append(o);
  }
  sel.onchange = async () => { if (sel.value !== project.id) await switchProject({ action: "use", id: sel.value }); };
}

async function switchProject(body) {
  try {
    const out = await postJSON("/api/projects", body);
    if (out.error) { sayError(out.error); return; }
    projectShown = null;
    answerBox.hidden = true;
    state = null;
    load();
  } catch {
    showDown();
  }
}

/** The deck's focus (0.8.0): everything, one campaign, or the people who
 *  came in under none. Shown only once there is a campaign to focus on. */
function showFocus() {
  const camps = state?.campaigns ?? [];
  if (!camps.length) { focusLine.hidden = true; return; }
  focusLine.hidden = false;
  focusLine.replaceChildren();
  const label = el("label", "es-focus-label", "showing");
  const sel = el("select");
  sel.setAttribute("aria-label", "which campaign the deck shows");
  const opts = [["", "everything"], ...camps.map((c) => [c.id, `${c.name}${c.status !== "active" ? ` (${c.status})` : ""}`]), ["none", "no campaign"]];
  for (const [v, t] of opts) { const o = el("option", null, t); o.value = v; if ((state.focus ?? "") === v) o.selected = true; sel.append(o); }
  sel.addEventListener("change", async () => { await panelDo({ do: "campaign.focus", id: sel.value }); load(); });
  label.append(sel);
  focusLine.append(label);
}

/** Waits poll themselves, quickly; an idle panel still looks every quarter
 *  minute, because work now starts on the server's own clock too (the
 *  judge, 0.9.1) and a colleague's question or result is the next card,
 *  arriving on the runtime's clock rather than on a click. The card is
 *  only redrawn when it changed, so the polling costs the operator nothing. */
function schedule(card, jobs, tasks) {
  clearTimeout(pollTimer);
  const waiting = /wait|probing/.test(card?.kind ?? "") || (jobs ?? []).length > 0 || (tasks ?? []).some((t) => t.status === "running");
  pollTimer = setTimeout(load, waiting ? 2500 : 15_000);
}

const sayError = (msg) => { errorLine.textContent = msg; errorLine.hidden = false; };

/* -------------------------------------------------------------------- act */

async function act({ action, choice, choices, text, tab }) {
  if (!current) return;

  // The client-side actions; the server hears about them at "posted".
  if (action === "insert" && current.data?.url) return insertFlow(current, text, tab);
  // A site the extension may not read yet: Chrome grants only inside the
  // click that asked, so the card's own button is where the asking happens.
  if (action === "allow" && current.data?.origin) {
    if (!ext) { sayError("Open the Messaging Quest side panel in Chrome and press Allow there — Chrome asks for a site permission only from the extension itself."); return; }
    const origin = current.data.origin;
    const ok = await ext.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!ok) { sayError(`Chrome did not grant ${origin.replace(/^https?:\/\//, "")} — the task stays paused until it is allowed.`); return; }
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
    if (!ext) { sayError("The tab is in the Chrome window where the extension runs — look for the Messaging Quest tab group."); return; }
    try {
      const t = await ext.tabs.get(current.data.tabId);
      await ext.windows.update(t.windowId, { focused: true });
      await ext.tabs.update(t.id, { active: true });
    } catch {
      sayError("That tab is gone — the task will open another when it needs one.");
    }
    return;
  }

  try {
    const out = await postJSON("/api/cards/act", { card: current.id, action, choice, choices, text, tab });
    if (out.error) { sayError(out.error); return; }
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
 *
 * Where it goes rides on the card (0.9.1): a comment on the post into the
 * thread's own box, never under the first comment; a reply to a person's
 * comment under theirs. The strip at the top says what is being done while
 * it is done, and the card waits in the meantime.
 */
async function insertFlow(card, editedText, tab) {
  const draft = (editedText ?? "").trim() || card.data.draft;
  const button = card.data.submit || "the platform's own button";
  const spec = card.data.insert ?? {};
  const where = spec.target === "comment" ? "the reply box under their comment" : "the thread's own comment box";
  errorLine.hidden = true;

  let onClipboard = false;
  try { await navigator.clipboard.writeText(draft); onClipboard = true; } catch { /* still worth trying to type it in */ }

  if (!ext) {
    openTab(card.data.url);
    note(`Copied to your clipboard — paste it into ${where}. (Typing it in only works from the installed extension.)`, card, draft, tab);
    return;
  }

  const origin = originOf(card.data.url);
  const granted = origin ? await ext.permissions.request({ origins: [`${origin}/*`] }).catch(() => false) : false;

  working("insert", "Opening the thread…");
  showWait("Opening the thread.", `In a tab of your own. Then the draft goes into ${where} the way you would put it there — a click on the box, then the words — and you press ${button}.`);
  const tabOpened = await ext.tabs.create({ url: card.data.url, active: true });

  if (!granted) {
    finished("insert");
    note(`Copied to your clipboard — paste it into ${where}. (Typing it in needs the ${origin ? origin.replace(/^https?:\/\//, "") : "site"} permission.)`, card, draft, tab);
    return;
  }

  await loaded(tabOpened.id);
  await new Promise((r) => setTimeout(r, 800)); // the SPA settles after "load"
  working("insert", `Putting the draft into ${where}…`);
  // The service worker holds the one debugger session and does it the way a
  // person does: a real click on the opener if the box is closed, a real
  // click into the box, the draft as one piece — and Ctrl+V, with what this
  // just put on the clipboard, when the editor ignored that (control.js
  // insertDraft). It reads back whether the words landed before it says so.
  let res = null;
  try { res = await ext.runtime.sendMessage({ type: "insert", tabId: tabOpened.id, text: draft, spec, clipboard: onClipboard }); } catch { res = null; }
  finished("insert");

  const Where = where[0].toUpperCase() + where.slice(1);
  const said = res?.ok
    ? `${res.how === "pasted" ? "Pasted" : "Typed"} into ${where}. Read it there, press ${button} — then tell me:`
    : res?.reason === "not_granted"
      ? `Copied to your clipboard — paste it into ${where}. (Putting it there needs the site permission.) Then tell me:`
      : res?.reason === "not_taken"
        ? `${Where} is open but did not take the words — paste them in yourself, they are on your clipboard. Then tell me:`
        : `Could not find ${where} on that page — the draft is on your clipboard, paste it in. Then tell me:`;
  note(said, card, draft, tab);
}

/** The panel's own wait card: what it is doing right now, while it does it. */
function showWait(question, help) {
  shownSig = null;
  renderCard(cardHost, { id: "panel.wait", kind: "panel.wait", question, help, primary: { id: "wait", label: "Working…" } }, () => {});
  cardHost.firstChild?.classList.add("es-waiting");
}

/** After the thread opens, the card becomes the confirm: posted, or not.
 *  What went up rides with it — the words as edited, and which tab. */
function note(text, card, posted = "", tab = null) {
  shownSig = null;
  renderCard(cardHost, {
    id: card.id, kind: "panel.confirm",
    eyebrow: card.eyebrow,
    question: "Did it go up?",
    help: text,
    primary: { id: "posted", label: "I posted it" },
    secondary: { id: "skip", label: "I didn't" },
  }, ({ action }) => {
    current = card;
    act({ action: action === "skip" ? "skip" : "posted", choice: null, choices: [], text: action === "skip" ? "" : posted, tab });
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

/** The specialist is told to answer in plain text; when a model bolds or
 *  bullets anyway, the marks become what they meant rather than asterisks.
 *  Text nodes only — nothing here is ever parsed as HTML. */
function said(text) {
  const out = [];
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  lines.forEach((line, i) => {
    const l = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, (m) => (/^\s*\d/.test(m) ? m : "• ")).replace(/^#{1,6}\s+/, "");
    l.split(/\*\*/).forEach((part, j) => { if (!part) return; out.push(j % 2 ? el("b", null, part) : part); });
    if (i < lines.length - 1) out.push("\n");
  });
  return out;
}

async function ask(preset) {
  const box = $("ask");
  const q = (preset ?? box.value).trim();
  if (!q) return;
  box.value = "";
  showView("deck");
  const before = new Set(deckCards.map((c) => c.id));
  answerBox.hidden = false;
  answerBox.replaceChildren(el("b", null, q), "\n\n…");
  answerBox.scrollIntoView({ block: "nearest" });
  working("ask", "Your specialist is thinking…");
  // A turn that reads a page or runs the writer takes a minute or more on
  // a free seat; after a while the wait says so rather than looking stuck.
  const slow = setTimeout(() => { if (/…$/.test(answerBox.textContent)) answerBox.append("\n\nStill working — a turn that reads a page or writes drafts takes a minute or two on the free plan."); }, 20_000);
  try {
    const out = await postJSON("/api/agent", { message: q, thread: "panel" });
    clearTimeout(slow);
    finished("ask");
    const reply = out.reply ?? (out.how ? `${out.error}.\n${out.how}` : out.error ?? "no answer");
    answerBox.replaceChildren(el("b", null, q), "\n\n", ...said(reply));
    // A turn may have dealt a card — a proposal, a campaign, a question.
    // When it did, the card is the next action and the answer says where:
    // on top, or behind the card already on screen, which stays first.
    await load();
    const dealt = deckCards.filter((c) => !before.has(c.id));
    if (dealt.length && dealt[0].id === current?.id) answerBox.append("\n\nA new card is on the deck above.");
    else if (dealt.length) answerBox.append(`\n\nA new card is on the deck, behind the one on screen: “${dealt[0].question}”.`);
    answerBox.scrollIntoView({ block: "nearest" });
  } catch {
    clearTimeout(slow);
    finished("ask");
    answerBox.textContent = "The server is not running.";
  }
}

/* ------------------------------------------------------------- the tabs */

function showView(name) {
  if (!VIEWS[name]) return;
  view = name;
  for (const [k, node] of Object.entries(VIEWS)) node.hidden = k !== name;
  for (const b of document.querySelectorAll(".es-tabs button")) b.setAttribute("aria-selected", String(b.dataset.view === name));
  if (name !== "deck") refreshState();
}

async function refreshState() {
  try { state = await getJSON("/api/panel"); drawView(); }
  catch { showDown(); }
}

function drawView() {
  if (!state) return;
  if (view === "campaigns") drawCampaigns();
  else if (view === "rooms") drawRooms();
  else if (view === "settings") drawSettings();
  showFocus();
}

/** One button on a tab. Errors land in the tab's own line; success redraws
 *  the tab — and the deck, since most of these deal a card. */
async function panelDo(body, { then = "state" } = {}) {
  let out;
  try { out = await postJSON("/api/panel/act", body); } catch { showDown(); return { error: "down" }; }
  if (out.error) { tabError(out.error); return out; }
  tabError("");
  if (then === "deck") { showView("deck"); load(); }
  else { await refreshState(); load(); }
  return out;
}
function tabError(msg) {
  for (const node of document.querySelectorAll(".es-tab-error")) { node.textContent = msg; node.hidden = !msg; }
}

const section = (title, sub) => {
  const s = el("section", "es-sec");
  if (title) s.append(el("h3", "es-sec-title", title));
  if (sub) s.append(el("p", "es-sub", sub));
  return s;
};
const item = () => el("article", "es-item");
const row = (...nodes) => { const r = el("div", "es-row"); r.append(...nodes); return r; };
const tag = (text, tone = "") => el("span", `es-tag${tone ? ` ${tone}` : ""}`, text);
const input = (placeholder, value = "", type = "text") => { const i = el("input"); i.type = type; i.placeholder = placeholder; i.value = value; i.autocomplete = "off"; return i; };
const textarea = (value, rows = 3, placeholder = "") => { const t = el("textarea"); t.rows = rows; t.value = value ?? ""; t.placeholder = placeholder; return t; };
const fieldOf = (label, node) => { const f = el("label", "es-fieldof"); f.append(el("span", "es-fieldof-label", label), node); return f; };
const errLine = () => { const e = el("p", "es-error es-tab-error"); e.hidden = true; return e; };

/* ---- Campaigns */

function drawCampaigns() {
  const host = VIEWS.campaigns;
  host.replaceChildren();
  const camps = state.campaigns ?? [];
  const numbers = (n) => n ? `${n.found} found · ${n.fit} fit${n.fitRate != null ? ` (${Math.round(n.fitRate * 100)}%)` : ""} · ${n.sent} sent · ${n.replies} replied · ${n.waiting} waiting on you${n.crowd != null ? ` · crowding ${n.crowd}` : ""}` : "nothing found under it yet";

  const top = section("Campaigns", camps.length ? "What you are trying, each a direction the writer applies in its own words — never a template. Focus the deck on one, pause a saturated one, search a room under it." : "A campaign is what you are trying — an angle, a room, a rule about naming what you built. Start one here, or tell your specialist below and it proposes one as cards.");
  top.append(errLine());
  const nameBox = input("Name the campaign — e.g. Launch posts in r/sideproject");
  const start = btn("Start it on the deck", async () => {
    const name = nameBox.value.trim();
    if (!name) { tabError("a campaign needs a name"); return; }
    const out = await panelDo({ do: "campaign.new", name }, { then: "deck" });
    if (!out.error) nameBox.value = "";
  }, "es-primary es-small");
  top.append(row(nameBox, start));
  const hint = el("p", "es-sub");
  hint.append("Or ask: ");
  hint.append(btn("“What campaign should I try next?”", () => ask("Given what has been found and what is waiting, what campaign should I try next, aimed at a different kind of person? Propose it."), "es-linkish"));
  top.append(hint);
  host.append(top);

  if (state.general && state.general.found > 0) {
    const g = item();
    g.append(row(el("b", null, "No campaign"), tag("the general fit")));
    g.append(el("p", "es-sub", numbers(state.general)));
    host.append(g);
  }

  for (const c of camps) {
    const it = item();
    it.append(row(el("b", null, c.name), tag(c.status, c.status === "active" ? "ok" : "dim"), tag(c.mention === "disclosed" ? "may name it, disclosed" : "help only", c.mention === "disclosed" ? "sig" : "dim")));
    it.append(el("p", "es-sub", numbers(c.numbers)));
    it.append(el("p", "es-sub", c.sources.length ? `watching ${c.sources.join(", ")}` : "no room watched under it yet"));
    const ideaP = el("p", "es-idea", c.idea.length > 240 ? `${c.idea.slice(0, 239).trimEnd()}…` : c.idea);
    it.append(ideaP);

    const actions = el("div", "es-item-actions");
    const focused = state.focus === c.id;
    actions.append(btn(focused ? "Show everything" : "Focus the deck on it", () => panelDo({ do: "campaign.focus", id: focused ? "" : c.id }, { then: "deck" }), focused ? "es-small es-on" : "es-small"));
    if (c.status === "active") actions.append(btn("Pause", () => panelDo({ do: "campaign.status", id: c.id, status: "paused" })));
    else if (c.status === "paused") actions.append(btn("Resume", () => panelDo({ do: "campaign.status", id: c.id, status: "active" })));
    if (c.status !== "done") actions.append(btn("Mark done", () => panelDo({ do: "campaign.status", id: c.id, status: "done" })));
    else actions.append(btn("Reopen", () => panelDo({ do: "campaign.status", id: c.id, status: "active" })));
    const editBtn = btn("Edit", () => { edit.hidden = !edit.hidden; search.hidden = true; });
    const searchBtn = btn("Search a room under it", () => { search.hidden = !search.hidden; edit.hidden = true; });
    actions.append(editBtn, searchBtn);
    it.append(actions);

    const edit = el("div", "es-form");
    edit.hidden = true;
    const idea = textarea(c.idea, 5, "What to say, and why it is honest to say it");
    const fit = textarea(c.fit, 2, "Who it fits — narrows the rule; empty means the rule is enough");
    const never = textarea(c.never, 2, "What this campaign never does");
    const voice = textarea(c.voice, 2, "How it sounds under this campaign — a tone laid over your measured voice");
    const mention = el("select");
    for (const m of state.mentions ?? []) { const o = el("option", null, `${m.label} — ${m.note}`); o.value = m.id; if (m.id === c.mention) o.selected = true; mention.append(o); }
    edit.append(fieldOf("The idea — a direction, never a template", idea), fieldOf("Who it fits", fit), fieldOf("Never", never), fieldOf("Voice", voice), fieldOf("May a first message name what you built?", mention));
    edit.append(row(btn("Save", () => panelDo({ do: "campaign.save", id: c.id, idea: idea.value, fit: fit.value, never: never.value, voice: voice.value, mention: mention.value }), "es-primary es-small"), btn("Cancel", () => { edit.hidden = true; })));
    it.append(edit);

    const search = el("div", "es-form");
    search.hidden = true;
    const place = input(`a room — e.g. ${state.settings.platform.id === "reddit" ? "sideproject" : "a-room"}`);
    const q = input("the phrase somebody types when they have the problem");
    search.append(el("p", "es-sub", "One read in a tab of your own browser, then the judge. Its cards deal on Next: the rules once, then watch it or try another."));
    search.append(fieldOf("Room", place), fieldOf("Phrase (empty: its new posts)", q));
    search.append(row(btn("Probe it", () => panelDo({ do: "campaign.probe", id: c.id, place: place.value, q: q.value }, { then: "deck" }), "es-primary es-small"), btn("Cancel", () => { search.hidden = true; })));
    it.append(search);

    host.append(it);
  }
}

/* ---- Rooms */

function drawRooms() {
  const host = VIEWS.rooms;
  host.replaceChildren();
  const srcs = state.sources ?? [];
  const due = srcs.filter((s) => s.due).length;
  const running = (state.running ?? []).map((r) => r.label);

  const top = section("Rooms", "What is watched, read in a tab of your own browser at a person's pace — and a room to try. Nothing is watched until its rules were recorded and a probe cleared the floor.");
  top.append(errLine());
  const acts = el("div", "es-item-actions");
  const tickBtn = btn(due ? `Read what is due (${due})` : "Read what is due", () => panelDo({ do: "tick" }, { then: "deck" }), due ? "es-primary es-small" : "es-small");
  acts.append(tickBtn);
  if (state.pending > 0) acts.append(btn(`Judge ${state.pending} waiting`, () => panelDo({ do: "judge" }, { then: "deck" }), "es-small"));
  if (state.account) acts.append(btn("Read my profile", () => panelDo({ do: "sync" }, { then: "deck" })));
  top.append(acts);
  if (running.length) top.append(el("p", "es-sub", `Now: ${running.join(" · ")}`));
  host.append(top);

  if (srcs.length) {
    const watched = section("Watched");
    for (const s of srcs) {
      const it = item();
      it.append(row(el("b", null, s.label), s.q ? tag(`“${s.q}”`) : tag("new posts", "dim"), s.due ? tag("due", "sig") : tag(`every ${s.cadence_min}m`, "dim")));
      const last = !s.last ? "never read" : s.last.ok ? `last read ${ago(s.last.at)}` : `last read failed: ${s.last.err ?? "error"}`;
      it.append(el("p", "es-sub", `${s.found} found · ${last}${s.campaign ? ` · campaign ${s.campaign}` : ""}`));
      const a = el("div", "es-item-actions");
      const stop = btn("Stop watching", () => {
        if (stop.dataset.sure !== "1") { stop.dataset.sure = "1"; stop.textContent = "Sure? Stop watching"; return; }
        panelDo({ do: "unwatch", id: s.id });
      });
      a.append(stop);
      it.append(a);
      watched.append(it);
    }
    host.append(watched);
  }

  const unanswered = (state.rooms ?? []).filter((r) => r.state === "unanswered");
  if (unanswered.length) {
    const rules = section("Rules to record", "A room's rules are not readable by a machine here. Read them once and say whether they allow a disclosed, on-topic mention — until then nothing is drafted for it.");
    for (const r of unanswered) {
      const it = item();
      it.append(row(el("b", null, r.label), r.watched ? tag("watched") : tag("probed", "dim")));
      const a = el("div", "es-item-actions");
      if (r.rulesUrl) { const l = el("a", "es-link", "Open its rules ↗"); l.href = r.rulesUrl; l.target = "_blank"; l.rel = "noreferrer noopener"; a.append(l); }
      a.append(btn("Promotion is tolerated", () => panelDo({ do: "room.rules", place: r.place, answer: "yes" })), btn("Its rules forbid it", () => panelDo({ do: "room.rules", place: r.place, answer: "no" })));
      it.append(a);
      rules.append(it);
    }
    host.append(rules);
  }

  const tryIt = section("Try a room", "One read, no commitment. A scoped search runs 42% fit against 29% for just new posts, so the phrase is worth writing. Its cards deal on Next.");
  const place = input(state.settings.platform.id === "reddit" ? "a subreddit — e.g. smallbusiness" : "a room");
  const q = input("the phrase somebody types when they have the problem");
  tryIt.append(fieldOf("Room", place), fieldOf("Phrase (empty: its new posts)", q));
  tryIt.append(row(btn("Probe it", () => panelDo({ do: "probe", place: place.value, q: q.value }, { then: "deck" }), "es-primary es-small")));
  host.append(tryIt);
}

/* ---- Settings */

function drawSettings() {
  const host = VIEWS.settings;
  host.replaceChildren();
  const st = state.settings;

  const models = section("Where the models run", "The scout, the judge and the writer need a model. Free is the default: a free OpenRouter key, no card, nothing ever charged. Everything that reads the platform needs none of this.");
  models.append(errLine());
  const plans = el("div", "es-plans");
  for (const p of st.plans) {
    const b = btn(p.title, () => panelDo({ do: "settings.plan", plan: p.key }), `es-plan${p.key === st.plan ? " es-on" : ""}`);
    b.setAttribute("aria-pressed", String(p.key === st.plan));
    plans.append(b);
  }
  models.append(plans);
  models.append(el("p", "es-sub", st.plans.find((p) => p.key === st.plan)?.what ?? ""));

  if (st.plan !== "local") {
    const keyRow = el("div", "es-form");
    const status = st.key.source === "env" ? "set in this server's environment (OPENROUTER_API_KEY)" : st.key.set ? "a key is saved on this machine" : "no key yet";
    keyRow.append(el("p", "es-sub", `OpenRouter key: ${status}.`));
    if (st.key.source !== "env") {
      const k = input(st.key.set ? "paste a new key to replace it" : "sk-or-…", "", "password");
      k.setAttribute("aria-label", "OpenRouter key");
      const save = btn("Save the key", async () => { const v = k.value.trim(); if (!v) { tabError("paste the key first"); return; } const out = await panelDo({ do: "settings.key", key: v }); if (!out.error) k.value = ""; }, "es-primary es-small");
      const r = row(k, save);
      if (st.key.set) r.append(btn("Remove", () => panelDo({ do: "settings.key", key: "" })));
      keyRow.append(r);
    }
    const get = el("a", "es-link", "Get a free key ↗");
    get.href = st.key.url; get.target = "_blank"; get.rel = "noreferrer noopener";
    keyRow.append(get);
    models.append(keyRow);
  } else {
    const loc = el("div", "es-form");
    const url = input("http://127.0.0.1:11434/v1", st.local.baseUrl);
    const key = input(st.local.key ? "a key is saved — leave empty to keep it" : "usually empty", "", "password");
    loc.append(fieldOf("Server address — Ollama's by default; anything that speaks chat completions", url), fieldOf("Key, only if that server checks one", key));
    loc.append(row(btn("Save", () => panelDo({ do: "settings.local", baseUrl: url.value, ...(key.value.trim() ? { key: key.value.trim() } : {}) }), "es-primary es-small")));
    models.append(loc);
  }

  const seats = section("The seats", st.plan === "local" ? "Tags on your server. The suggestions are sized for a 16 GB machine and are not measured." : st.plan === "free" ? "Picked on a measurement: every free model that takes a tool call was asked the same verdict; the notes carry the numbers." : "Balanced: the cheap fast model does the volume work and the good writer only writes.");
  for (const r of st.roles) {
    const it = item();
    it.append(row(el("b", null, r.title), tag(r.label, "dim")));
    it.append(el("p", "es-sub", r.what));
    const sel = el("select");
    sel.setAttribute("aria-label", `${r.title} model`);
    const ids = new Set(st.menu.map((m) => m.id));
    if (!ids.has(r.model)) { const o = el("option", null, r.model); o.value = r.model; o.selected = true; sel.append(o); }
    for (const m of st.menu) { const o = el("option", null, m.label); o.value = m.id; if (m.id === r.model) o.selected = true; sel.append(o); }
    const use = btn("Use", () => panelDo({ do: "settings.model", role: r.key, model: custom && custom.value.trim() ? custom.value.trim() : sel.value }));
    let custom = null;
    if (st.plan === "local") custom = input("or any tag: qwen3.5:27b");
    it.append(row(sel, ...(custom ? [custom] : []), use));
    if (r.note) it.append(el("p", "es-note", r.note));
    seats.append(it);
  }

  const you = section("You", "");
  const acc = el("div", "es-form");
  acc.append(el("p", "es-sub", state.account ? `Your ${st.platform.name} account: ${state.account}. Your own public profile is read the way a stranger reads it — nothing is posted.` : `No ${st.platform.name} account named yet. The visibility half needs one; the finding half does not.`));
  const name = input("your-username", "");
  acc.append(row(name, btn(state.account ? "Change it" : "That's me", () => panelDo({ do: "account", name: name.value }), "es-small")));
  you.append(acc);
  const setup = state.setup;
  if (setup) you.append(el("p", "es-sub", `Memory: ${setup.done} of ${setup.total} files written — what you sell, who it is for, the fit rule, what is true about you. Edit them on the dashboard's You page.`));

  const projects = section("Projects", "One brand, one isolated context each: its own memory files, store, voice, campaigns and deck. The picker at the top switches; a new one starts its setup on Next.");
  const pn = input("The other product");
  projects.append(row(pn, btn("Make it and switch", async () => { const n = pn.value.trim(); if (!n) { tabError("name the project"); return; } const out = await switchProjectJSON(n); if (out?.error) tabError(out.error); }, "es-small")));

  const browser = section("This browser", "");
  const srv = el("div", "es-form");
  srv.append(el("p", "es-sub", `Server: ${base} — your own machine, nothing else.`));
  if (ext) {
    const addr = input("http://127.0.0.1:8787", base);
    srv.append(row(addr, btn("Change", async () => { const next = addr.value.trim().replace(/\/$/, ""); if (!/^https?:\/\//.test(next)) { tabError("the address starts with http://"); return; } base = next; await ext.storage.local.set({ base }); projectShown = null; state = null; load(); }, "es-small")));
    const inc = el("p", "es-sub", "Incognito: checking…");
    srv.append(inc);
    try {
      ext.extension.isAllowedIncognitoAccess((allowed) => {
        inc.textContent = allowed
          ? "Incognito: allowed — the visibility reads (your profile as a stranger sees it, the return pass) can take the stranger's seat."
          : "Incognito: not allowed yet. The visibility reads need it: open the extension's details and tick “Allow in Incognito”.";
        if (!allowed) srv.append(row(btn("Open the extension's details", () => ext.tabs.create({ url: `chrome://extensions/?id=${ext.runtime.id}` }), "es-small")));
      });
    } catch { inc.textContent = ""; }
  } else {
    srv.append(el("p", "es-sub", "This is the panel served as a page. In Chrome, load the extension (chrome://extensions → Load unpacked → the repo's extension/ folder) to type drafts into the composer and to read pages."));
  }
  browser.append(srv);
  const dash = el("a", "es-link", "Open the dashboard ↗");
  dash.href = `${base}/`; dash.target = "_blank"; dash.rel = "noreferrer noopener";
  browser.append(dash);

  host.append(models, seats, you, projects, browser);
}

async function switchProjectJSON(name) {
  try {
    const out = await postJSON("/api/projects", { action: "new", name });
    if (out.error) return out;
    projectShown = null; state = null; answerBox.hidden = true;
    showView("deck"); load();
    return out;
  } catch { showDown(); return { error: "down" }; }
}

/* ------------------------------------------------------------------- boot */

$("send").addEventListener("click", () => ask());
$("ask").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
for (const b of document.querySelectorAll(".es-tabs button")) b.addEventListener("click", () => showView(b.dataset.view));

const savedBase = ext ? ext.storage.local.get({ base: DEFAULT_BASE }) : Promise.resolve({ base: DEFAULT_BASE });
savedBase.then(async ({ base: saved }) => {
  base = saved;
  const dash = $("dash");
  dash.href = `${base}/`;
  dash.addEventListener("click", (e) => { e.preventDefault(); openTab(`${base}/`); });
  // The worker's name on the lane: while this panel is the one open, the
  // engine opens its tabs in THIS profile (two open: the first keeps it).
  if (ext) { try { INSTANCE = (await ext.runtime.sendMessage({ type: "instance" }))?.instance ?? null; } catch { INSTANCE = null; } }
  load();
});
