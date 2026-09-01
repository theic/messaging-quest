// The panel: one card, dealt by the local server, and the whole interface.
// There is no list to pick from and no landing screen — opening the panel
// shows the next action, answering it shows the following one. The rule
// inherited from the predecessor and kept on purpose: whatever state things
// are in, there is one obvious thing to press.
//
// Everything is the server's decision. This file renders the deck, sends the
// pressed button's id back, and handles the two things only a browser can do:
// typing a draft into Reddit's real composer (insert.js — the human still
// presses Reddit's own button), and talking to the strategist.

import { renderCard } from "./card.js";
import { relayPass, RELAY_ORIGINS } from "./relay.js";

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
const cardHost = $("card"), jobsLine = $("jobs"), errorLine = $("error"), answerBox = $("answer");

let current = null;      // the card on screen
let pollTimer = null;

/* ------------------------------------------------------------------- deck */

async function load() {
  try {
    const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const { cards, jobs, relay } = await res.json();
    showJobs(jobs, relay);
    show(cards?.[0] ?? null);
    schedule(cards?.[0], jobs);
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

function showJobs(jobs, relay) {
  const parts = (jobs ?? []).map((j) => `${j.label}${j.note ? ` — ${j.note}` : ""}`);
  if (relay?.pending > 0) parts.push(`${relay.pending} read${relay.pending === 1 ? "" : "s"} waiting on this browser`);
  jobsLine.textContent = parts.join(" · ");
  updateRelayHint(relay);
}

/**
 * The lane is dark for exactly one fixable reason: the reddit.com site grant.
 * When reads are queued and the grant is missing, say so with a button —
 * chrome.permissions.request only works inside the click that asked.
 */
async function updateRelayHint(relay) {
  if (!ext || !relay || relay.pending === 0) return;
  const has = await ext.permissions.contains({ origins: RELAY_ORIGINS }).catch(() => false);
  if (has) return;
  errorLine.hidden = false;
  errorLine.replaceChildren();
  errorLine.append("The engine has reads waiting for this browser, and this browser has no reddit.com permission yet. ");
  const b = document.createElement("button");
  b.textContent = "Grant it";
  b.type = "button";
  b.addEventListener("click", async () => {
    const ok = await ext.permissions.request({ origins: RELAY_ORIGINS }).catch(() => false);
    if (ok) { errorLine.hidden = true; relayPass(base).catch(() => {}); }
  });
  errorLine.append(b);
}

/** While the panel is open it IS the fast path: one long-poll at a time,
 *  each holding on the server until a read arrives or 20s pass. */
async function relayLoop() {
  if (!ext) return;
  for (;;) {
    try { await relayPass(base, { wait: 20000 }); }
    catch { /* server gone; the deck poller shows the down card */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

/** Waits poll themselves; everything else refreshes on act or on the alarm. */
function schedule(card, jobs) {
  clearTimeout(pollTimer);
  const waiting = /wait|probing/.test(card?.kind ?? "") || (jobs ?? []).length > 0;
  if (waiting) pollTimer = setTimeout(load, 4000);
}

/* -------------------------------------------------------------------- act */

async function act({ action, choice, choices, text }) {
  if (!current) return;

  // The two client-side actions; the server hears about them at "posted".
  if (action === "insert" && current.data?.url) return insertFlow(current, text);
  if (action === "open" && current.links?.[0]) {
    openTab(absolute(current.links[0].href));
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

/* ----------------------------------------------------- open thread & type */

/**
 * The posting flow, with the click order that matters: copy first (opening the
 * tab takes the panel's focus, and if Chrome refuses the injection the text is
 * already on the clipboard), then the visible per-site permission, then the
 * tab, then ESInsert. The human reads the draft in Reddit's own composer and
 * presses Reddit's own button — nothing here can submit, by construction.
 */
async function insertFlow(card, editedText) {
  const draft = (editedText ?? "").trim() || card.data.draft;
  errorLine.hidden = true;

  try { await navigator.clipboard.writeText(draft); } catch { /* still worth trying to type it in */ }

  if (!ext) {
    openTab(card.data.url);
    note("Copied to your clipboard — paste it into the reply box. (Typing it in only works from the installed extension.)", card);
    return;
  }

  const granted = await ext.permissions.request({
    origins: ["https://www.reddit.com/*", "https://old.reddit.com/*"],
  }).catch(() => false);

  const tab = await ext.tabs.create({ url: card.data.url, active: true });

  if (!granted) {
    note("Copied to your clipboard — paste it into the reply box. (Typing it in needs the reddit.com permission.)", card);
    return;
  }

  await loaded(tab.id);
  await new Promise((r) => setTimeout(r, 800)); // the SPA settles after "load"
  let ok = false;
  try {
    const [res] = await ext.scripting.executeScript({
      target: { tabId: tab.id },
      func: ESInsert,             // the global from insert.js, serialized into the page
      args: [draft],
    });
    ok = Boolean(res?.result?.ok);
  } catch { ok = false; }

  note(ok
    ? "Typed into the composer. Read it there, press Reddit's own button — then tell me:"
    : "Could not find the composer — the draft is on your clipboard, paste it in. Then tell me:", card);
}

/** After the thread opens, the card becomes the confirm: posted, or not. */
function note(text, card) {
  renderCard(cardHost, {
    id: card.id, kind: "panel.confirm",
    eyebrow: card.eyebrow,
    question: "Did it go up?",
    help: text,
    primary: { id: "posted", label: "I posted it" },
    secondary: { id: "skip", label: "I didn't" },
  }, ({ action }) => {
    current = card;
    act({ action: action === "skip" ? "skip" : "posted", choice: null, choices: [], text: "" });
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
    load();
  });
  line.append(a);
  load();
  relayLoop();
});
