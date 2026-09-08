// The service worker does five small things and nothing else: the toolbar
// icon opens the side panel; a once-a-minute alarm asks how many cards are
// waiting so the badge can say so; it keeps the control lane's claim loop
// alive (control.js) — the toolkit every read in this tool goes through, on
// tabs a task or a verb leased; it is the one owner of the debugger, so the
// panel's Insert button asks it to put a draft into a composer (insertDraft)
// rather than attaching a second session of its own; and, from 0.10.0, it
// HOSTS THE ENGINE (engine.js) — the deck, the verbs, the models, the
// broker — when there is no server, which is the store install's whole
// backend. There is no background read of any page here (the relay pass is
// gone, 0.6.0): a page is read in a tab a person can watch, or not at all.
// The pace stays the broker's — navigations are spaced per site, and the
// alarm only ever asks how many cards are waiting.
//
// Two modes, one setting (chrome.storage.local `mode`):
//   hosted   the engine in this worker, the panel talking to it over
//            chrome.runtime messages, the lane in-process. The default for
//            a new install.
//   local    a `mq serve` on this machine — the dashboard, the CMO. The
//            panel talks to it over HTTP; this worker long-polls its lane.
//            An install from before 0.10.0 saved a server address and no
//            mode: it stays local, so an upgrade does not hide the data
//            its server holds.
//
// On keeping the worker alive: MV3 kills an idle worker after ~30s, and the
// control loop is the most common way a thing like this silently stops. The
// loop makes an extension API call on every pass (that resets the timer), and
// the alarm restarts the loop once Chrome has killed the worker anyway.
// Neither alone is enough (the predecessor's bridge learned this the hard way).

import { ensureControlLoop, httpLane, insertDraft, instanceId } from "./control.js";
import { booted, parts, onFileChange } from "./engine.js";
import { account, SITE } from "./account.js";

const DEFAULT_BASE = "http://127.0.0.1:8787";

/** The account (account.js): the session in this browser, the files
 *  mirrored under it. Bound to the engine's memory host once it is up. */
const ACCOUNT = account({ storage: { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) } });
let synced = false;
async function engineSynced() {
  const E = await booted();
  if (!synced) {
    synced = true;
    const { host } = parts();
    const s = await ACCOUNT.attach(host);
    onFileChange((path) => s.changed(path));
    ACCOUNT.syncNow().catch(() => {});
  }
  return E;
}

/** The mode and the server address, as saved. */
export async function settings() {
  const s = await chrome.storage.local.get({ mode: null, base: null });
  const mode = s.mode === "local" || s.mode === "hosted" ? s.mode : s.base ? "local" : "hosted";
  return { mode, base: s.base ?? DEFAULT_BASE };
}

/** The lane for the claim loop: the server's over HTTP, or the engine's own
 *  broker in this worker. */
async function laneFor() {
  const { mode, base } = await settings();
  if (mode === "local") return httpLane(base);
  const E = await engineSynced();
  return {
    jobs: (instance) => E.CONTROL.claim(15_000, instance),
    answer: async (id, out) => { E.CONTROL.answer(id, out); },
  };
}
const start = () => laneFor().then(ensureControlLoop).catch((e) => console.error("lane:", e?.message ?? e));

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("deck", { periodInMinutes: 1 });
  chrome.alarms.create("sync", { periodInMinutes: 1 });
  start();
});
chrome.runtime.onStartup.addListener(start);

/** The deck's cards, from wherever the engine is. */
async function cardsNow() {
  const { mode, base } = await settings();
  if (mode === "local") {
    const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()).cards ?? [];
  }
  return (await engineSynced()).deck().cards ?? [];
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Once a minute, what another browser wrote under the account.
  if (alarm.name === "sync") { const { mode } = await settings(); if (mode === "hosted" && synced) ACCOUNT.syncNow().catch(() => {}); return; }
  if (alarm.name !== "deck") return;
  start();                             // brings the loop back if the worker was killed
  try {
    const cards = await cardsNow();
    // Waits and the quiet card are not asks; everything else is.
    const asks = cards.filter((c) => !/^(onboard\.wait|onboard\.probing|work\.quiet|task\.running)$|\.wait$/.test(c.kind ?? c.id)).length;
    chrome.action.setBadgeText({ text: asks ? String(asks) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  } catch {
    // Server down = badge off. The panel says how to start it; the badge nagging
    // about a machine that is not running would be noise.
    chrome.action.setBadgeText({ text: "" });
  }
});

// Messages from the panel — only the panel: runtime messages come from this
// extension's own pages.
//   instance   the worker's name on the lane, which the panel puts on its
//              deck poll so the engine opens its tabs in this profile.
//   settings   the mode and the server address.
//   mode       switch modes; the extension reloads itself to start clean —
//              Chrome closes the panel with it, the person opens it again.
//   api        a request for the engine in this worker (hosted mode): the
//              same method, path, query and body the server would take.
//   insert     the panel's Insert button: the human pressed it, this puts
//              the draft into the composer of the tab the panel just opened,
//              the human presses the platform's own button. The composer's
//              words are the platform's and ride on the card, with where the
//              reply belongs; `clipboard` says the panel managed to put the
//              draft on the clipboard, which is the only case a Ctrl+V may
//              be sent.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "instance") { instanceId().then((instance) => reply({ instance }), () => reply({ instance: null })); return true; }
  if (msg?.type === "settings") { settings().then(reply, () => reply({ mode: "hosted", base: DEFAULT_BASE })); return true; }
  if (msg?.type === "mode") {
    const mode = msg.mode === "local" ? "local" : "hosted";
    const patch = { mode, ...(msg.base ? { base: String(msg.base) } : {}) };
    chrome.storage.local.set(patch).then(() => { reply({ ok: true, ...patch }); setTimeout(() => chrome.runtime.reload(), 300); }, (e) => reply({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (msg?.type === "api") {
    settings()
      .then(async ({ mode }) => {
        if (mode === "local") return { status: 503, body: { error: "this browser runs against a local server — the panel talks to it directly" } };
        const E = await engineSynced();
        return E.handle(String(msg.method ?? "GET"), String(msg.path ?? ""), msg.query ?? {}, msg.body ?? null);
      })
      .then(reply, (e) => reply({ status: 500, body: { error: String(e?.message ?? e) } }));
    return true;
  }
  // The account (account.js): who is signed in, the two steps of the code
  // sign-in, out, and a sync on demand. Hosted only — a local install's
  // files are its server's.
  if (typeof msg?.type === "string" && msg.type.startsWith("account.")) {
    const step = msg.type.slice("account.".length);
    (async () => {
      if (step === "status") return ACCOUNT.status();
      if (step === "start") return ACCOUNT.signInStart(msg.email);
      if (step === "verify") { const out = await ACCOUNT.signInVerify(msg.email, msg.code); if (out.ok) { await engineSynced(); ACCOUNT.syncNow().catch(() => {}); } return out; }
      if (step === "out") return ACCOUNT.signOut();
      if (step === "sync") { await engineSynced(); return ACCOUNT.syncNow(); }
      return { error: `not an account step: ${step}` };
    })().then(reply, (e) => reply({ error: String(e?.message ?? e) }));
    return true;
  }
  if (msg?.type !== "insert") return false;
  insertDraft(Number(msg.tabId), String(msg.text ?? ""), msg.spec ?? {}, { clipboard: Boolean(msg.clipboard) })
    .then(reply, (e) => reply({ ok: false, reason: String(e?.message ?? e) }));
  return true;
});

// The website's door (manifest externally_connectable: messaging.quest
// only). `ping` says the extension is installed; `connect` hands in the
// one-time token hash the site minted for its signed-in user, and this
// browser gets a session of its own — "Connect this browser", one click.
chrome.runtime.onMessageExternal?.addListener((msg, sender, reply) => {
  const from = String(sender?.origin ?? sender?.url ?? "");
  if (!/^https:\/\/(www\.)?messaging\.quest(\/|$)/.test(from)) { reply({ error: "not the site" }); return false; }
  if (msg?.type === "ping") { reply({ ok: true, version: chrome.runtime.getManifest().version }); return false; }
  if (msg?.type === "connect") {
    ACCOUNT.connect(msg.token_hash)
      .then(async (out) => { if (out.ok) { await chrome.storage.local.set({ mode: "hosted" }); await engineSynced(); ACCOUNT.syncNow().catch(() => {}); } return out; })
      .then(reply, (e) => reply({ error: String(e?.message ?? e) }));
    return true;
  }
  reply({ error: "not a thing the site can ask" });
  return false;
});

// The worker was just started by something — an event, the panel, Chrome
// itself. Whatever it was, the lane should be listening.
start();
