// The control lane, browser half: the extension as a pair of hands on tabs a
// task leased. lib/control.mjs is the broker and holds the law of the lane;
// this file is the toolkit — the same names and conventions as Claude in
// Chrome, so a model's habits transfer — built on the primitives Chrome
// already has:
//
//   chrome.tabs / chrome.tabGroups   leases: a tab under the "Messaging Quest"
//                                    group in the machine's own window
//   chrome.scripting.executeScript   READING: the accessibility tree, find,
//                                    text, where a control is — plain functions
//                                    injected by reference into the extension's
//                                    isolated world, arguments as data, no eval.
//                                    They write nothing into the page: no
//                                    attribute, no element, no synthetic event.
//   chrome.debugger                  DOING: every scroll, mouse move, click and
//                                    key is a real input event through Chrome's
//                                    own input pipeline (isTrusted: true), the
//                                    way a hand on a mouse produces it. The
//                                    session stays attached while a task is
//                                    using the tab and detaches after a minute
//                                    idle — Chrome shows its bar while attached.
//
// The tempo is a person's, on purpose. Every job waits a little before it
// runs, unevenly; a page gets looked at for a few seconds after it loads; the
// mouse travels to a control along a curve and rests before it presses; a
// scroll is wheel ticks of uneven size; typing is one key at a time at an
// uneven rate. Nothing here is a fingerprint a person would not leave, and
// nothing is a request a tab would not make on its own — there is no fetch
// of a page anywhere in this file.
//
// What this file refuses, by construction:
//   * A click whose target's label matches screen.js (post, comment, reply,
//     send, submit …) is refused IN THE PAGE, before any event is dispatched —
//     whatever the caller was granted. The broker already screened the
//     caller's grants; this is the second screen, one layer down. Enter and
//     Space on a focused control go through the same screen; ctrl+Enter is
//     refused outright as the chord that submits a composer.
//   * Nothing types into a composer — a control labelled comment, reply,
//     post, message or chat — on an agent's behalf. The one thing that ever
//     writes into a composer is insertDraft, and only the panel's Insert
//     button calls it: the human pressed it, and the human presses the
//     platform's own button after.
//   * Nothing runs in a page without the visible per-site permission the
//     operator granted. A missing grant is answered as `not_granted` with the
//     origin, and the panel asks for it — a permission dialog nobody is
//     looking at is not a read.
//   * No JavaScript-eval tool. The page-side vocabulary is the functions in
//     this file, and adding to it means editing the extension. A platform's
//     knowledge of a page is a declared spec (read_dom: a selector and a
//     field map) that domExtract runs — never platform code in the page.
//   * From 0.6.0 this is the only way anything reads a platform: there is no
//     background fetch in the extension (the relay pass is gone) and none in
//     the engine. A page is read in a tab a person can watch, or not at all.
//     The visibility verbs read in an Incognito tab (strangerTab) — the
//     stranger's seat — which Chrome allows only once the operator has
//     allowed the extension there.
//   * The console reader enables the Log domain only. Runtime.enable is the
//     one CDP call sites are known to test for, and nothing here makes it.
//
// Runs in the service worker, which the long-poll keeps awake: every pass
// makes an extension API call, and MV3 resets the idle timer on each one.
// The once-a-minute alarm in sw.js restarts the loop if Chrome killed the
// worker anyway — neither alone is enough (the predecessor's bridge, sw.js).

import { CLICK_SCREEN } from "./screen.js";
import { composerState, wordsSource, OPENS_DEFAULT, REPLIES_DEFAULT, NEVER } from "./insert.js";

export const GROUP_TITLE = "Messaging Quest";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const pause = (min, max) => sleep(rand(min, max));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const originOf = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };
const isMac = /mac/i.test(globalThis.navigator?.platform ?? "");

/** The think-time before a job: a read is a glance, an action is a decision,
 *  a fresh page gets looked at. Ranges, not values — the point is unevenness.
 *  Guesses at a person's tempo (2026-09-04), not measurements; the first
 *  measurement of what a site treats as human replaces them. */
const THINK = { read: [250, 900], act: [500, 1600], look: [1200, 3200], batch: [300, 1200] };
const think = (kind) => pause(...THINK[kind]);

/* ------------------------------------------------------------------- loop */

let looping = false;

/** Start the claim loop if it is not running. Idempotent, so the alarm, the
 *  install hook and the worker's own start can all call it. */
export function ensureControlLoop(base) {
  if (looping) return;
  looping = true;
  loop(base).catch(() => {}).finally(() => { looping = false; });
}

async function loop(base) {
  for (;;) {
    let jobs = [];
    try {
      const res = await fetch(`${base}/api/control/jobs?wait=15000`, { signal: AbortSignal.timeout(23_000) });
      if (!res.ok) throw new Error(String(res.status));
      jobs = (await res.json()).jobs ?? [];
    } catch {
      await sleep(4000);   // the server is down or restarting; keep the loop, back off
      continue;
    }
    // The keepalive: an extension API call per pass. Storage is the cheapest.
    try { await chrome.storage.session.set({ controlAt: Date.now() }); } catch { /* fine */ }
    sweepSessions();
    for (const job of jobs) {
      const answer = await run(job).catch((e) => ({ error: String(e?.message ?? e) }));
      try {
        await fetch(`${base}/api/control/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: job.id, ...answer }),
          signal: AbortSignal.timeout(8000),
        });
      } catch { /* the job times out server-side; a lost answer is just late */ }
      if (job.tool === "reload") { await sleep(300); chrome.runtime.reload(); }
    }
  }
}

/* -------------------------------------------------------------------- jobs */

async function run(job) {
  const input = job.input ?? {};
  const tabId = Number(input.tabId ?? job.tabId);
  switch (job.tool) {
    case "lease": return openTab(input.url, null, { stranger: Boolean(input.stranger) });
    case "release": {
      for (const t of input.tabIds ?? []) { await detach(Number(t)); try { await chrome.tabs.remove(Number(t)); } catch { /* already gone */ } }
      return { ok: true };
    }
    case "reload": return { ok: true, reloading: true };   // the loop reloads after answering
    case "tabs_context": return tabsContext(input.tabIds ?? [tabId]);
    case "tabs_create": await think("act"); return openTab(input.url, tabId);
    case "tabs_close": { await detach(tabId); try { await chrome.tabs.remove(tabId); } catch { /* gone */ } return { ok: true }; }
    case "navigate": await think("act"); return navigate(tabId, String(input.url ?? ""));
    case "read_page": { const no = await shown(tabId); if (no) return no; await think("read"); return inPage(tabId, pageTree, [String(input.filter ?? "all"), Number(input.depth) || 15, Number(input.max_chars) || 50_000, input.ref_id ?? null]); }
    case "read_dom": { const no = await shown(tabId); if (no) return no; await think("read"); return inPage(tabId, domExtract, [input.spec && typeof input.spec === "object" ? input.spec : {}]); }
    case "find": { const no = await shown(tabId); if (no) return no; await think("read"); return inPage(tabId, findInPage, [String(input.query ?? "")]); }
    case "get_page_text": { const no = await shown(tabId); if (no) return no; await think("read"); return inPage(tabId, pageText, [Number(input.max_chars) || 50_000]); }
    case "form_input": await think("act"); return formInput(tabId, input);
    case "computer": await think(/^(screenshot|zoom|wait)$/.test(String(input.action)) ? "read" : "act"); return computer(tabId, input);
    case "read_console_messages": await think("read"); return consoleMessages(tabId, input);
    case "read_network_requests": await think("read"); return inPage(tabId, networkRequests, [Number(input.limit) || 50, String(input.urlPattern ?? "")]);
    case "batch": {
      const results = [];
      let first = true;
      for (const a of input.actions ?? []) {
        if (!first) await think("batch");
        first = false;
        const r = await run({ tool: a.name, input: { ...(a.input ?? {}), tabId: a.input?.tabId ?? tabId }, tabId }).catch((e) => ({ error: String(e?.message ?? e) }));
        results.push({ name: a.name, result: r });
        if (r?.error) break;   // stop on the first error, like the original
      }
      return { results };
    }
    default: return { error: `unknown tool ${job.tool}` };
  }
}

/* ------------------------------------------------------------------ leases */

/** The "Messaging Quest" group in the tab's window — found by title, made
 *  when absent — so every leased tab sits together and is recognisably the
 *  machine's, not the person's. */
async function groupTab(tabId, windowId) {
  try {
    const [g] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId });
    if (g) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: g.id });
      // A tab moved into a COLLAPSED group is hidden and Chrome activates a
      // neighbour instead — measured 2026-09-04: every leased tab came up
      // inactive, and Reddit's feed never loaded in it. The group opens and
      // the tab comes back to the front.
      try { if (g.collapsed) await chrome.tabGroups.update(g.id, { collapsed: false }); } catch { /* fine */ }
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      return g.id;
    }
    const id = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(id, { title: GROUP_TITLE, color: "green" });
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    return id;
  } catch {
    return null;   // a window that cannot group (an app window) still gets its tab
  }
}

/** A read needs the tab drawn as much as a click does: a page a person is
 *  not looking at may never finish loading (Reddit's feed does not). The
 *  same probe-and-raise as before input, and a look-pause when the page was
 *  hidden until now, so what loads on becoming visible has loaded. Null
 *  when the tab is on screen; the reason when it cannot be. */
async function shown(tabId) {
  try {
    const { raised } = await front(tabId);
    if (raised) { await think("look"); }
    return null;
  } catch (e) {
    return { error: e.message };
  }
}

/** The machine's own window: wherever the "Messaging Quest" group already
 *  is (that survives a worker restart), else a sibling's window, else none —
 *  and then a new one is opened, unfocused, so the operator's own window
 *  keeps the keyboard. A tab must be VISIBLE for Chrome to process input
 *  events on it: a mouse in a background tab of the operator's window would
 *  either stall or steal their view, and Claude in Chrome works in its own
 *  window for the same reason. */
async function machineWindow(siblingTabId) {
  try {
    const [g] = await chrome.tabGroups.query({ title: GROUP_TITLE });
    if (g) { await chrome.windows.get(g.windowId); return g.windowId; }
  } catch { /* no group yet, or its window closed */ }
  if (siblingTabId) { try { return (await chrome.tabs.get(siblingTabId)).windowId; } catch { /* fall through */ } }
  return null;
}

async function openTab(url, siblingTabId, { stranger = false } = {}) {
  if (!/^https?:\/\//i.test(String(url ?? ""))) return { error: "a tab opens on an http(s) url" };
  if (stranger) return strangerTab(url);
  const windowId = await machineWindow(siblingTabId);
  let tab;
  if (windowId !== null) {
    tab = await chrome.tabs.create({ url, active: true, windowId });
  } else {
    const w = await chrome.windows.create({ url, focused: false, type: "normal" });
    tab = w.tabs?.[0] ?? (await chrome.tabs.query({ windowId: w.id }))[0];
  }
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  const groupId = await groupTab(tab.id, tab.windowId);
  await loaded(tab.id, 20_000);
  await think("look");
  const t = await chrome.tabs.get(tab.id).catch(() => tab);
  return { tabId: tab.id, groupId, windowId: tab.windowId, url: t.url ?? url, title: t.title ?? "" };
}

/**
 * The STRANGER's seat: an Incognito window, for the visibility verbs. What
 * became of a comment is only measurable logged out — Reddit shows an
 * author their own shadow-removed comment as if nothing happened — so
 * sync/check/back lease their tab here. Chrome lets an extension into
 * Incognito only once the operator has allowed it (chrome://extensions →
 * Details → Allow in Incognito); until then the lease says so, and the verb
 * refuses rather than answering from the wrong seat. The window is the
 * machine's own, like the other one: kept unfocused, its tabs grouped, its
 * id remembered for the session so one window serves every stranger read.
 */
async function strangerTab(url) {
  let allowed = false;
  try { allowed = await chrome.extension.isAllowedIncognitoAccess(); } catch { allowed = false; }
  if (!allowed) return { error: "incognito_not_allowed" };
  let windowId = null;
  try {
    const { strangerWindow } = await chrome.storage.session.get({ strangerWindow: null });
    if (strangerWindow !== null) { const w = await chrome.windows.get(strangerWindow); if (w?.incognito) windowId = w.id; }
  } catch { windowId = null; }
  let tab;
  try {
    if (windowId !== null) {
      tab = await chrome.tabs.create({ url, active: true, windowId });
    } else {
      const w = await chrome.windows.create({ url, focused: false, type: "normal", incognito: true });
      tab = w.tabs?.[0] ?? (await chrome.tabs.query({ windowId: w.id }))[0];
      try { await chrome.storage.session.set({ strangerWindow: w.id }); } catch { /* fine */ }
    }
  } catch (e) {
    return { error: `could not open an Incognito tab: ${e.message}` };
  }
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  const groupId = await groupTab(tab.id, tab.windowId);
  await loaded(tab.id, 20_000);
  await think("look");
  const t = await chrome.tabs.get(tab.id).catch(() => tab);
  return { tabId: tab.id, groupId, windowId: tab.windowId, url: t.url ?? url, title: t.title ?? "", stranger: true };
}

async function tabsContext(tabIds) {
  const tabs = [];
  for (const id of tabIds) {
    try { const t = await chrome.tabs.get(Number(id)); tabs.push({ tabId: t.id, url: t.url, title: t.title, status: t.status, active: t.active, groupId: t.groupId }); }
    catch { tabs.push({ tabId: Number(id), gone: true }); }
  }
  return { tabs };
}

async function navigate(tabId, url) {
  try {
    if (url === "back") await chrome.tabs.goBack(tabId);
    else if (url === "forward") await chrome.tabs.goForward(tabId);
    else if (/^https?:\/\//i.test(url)) await chrome.tabs.update(tabId, { url });
    else return { error: "navigate takes an http(s) url, \"back\" or \"forward\"" };
  } catch (e) {
    return { error: `could not navigate: ${e.message}` };
  }
  await loaded(tabId, 20_000);
  await think("look");
  const t = await chrome.tabs.get(tabId).catch(() => null);
  return t ? { url: t.url, title: t.title, status: t.status } : { error: "that tab is gone" };
}

const loaded = (tabId, ms) =>
  new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); clearTimeout(t); resolve(true); }
    };
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(false); }, ms);
    chrome.tabs.onUpdated.addListener(done);
    // It may already be complete — a race that otherwise costs the timeout.
    chrome.tabs.get(tabId).then((tab) => { if (tab?.status === "complete") done(tabId, { status: "complete" }); }).catch(() => {});
  });

/* --------------------------------------------------------------- in page */

/** Inject one of the page-side functions below. Refuses, with the origin,
 *  when the operator has not granted this site — the panel asks; this never
 *  prompts from a worker nobody is looking at. */
async function inPage(tabId, func, args) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { error: "that tab is gone" };
  const origin = originOf(tab.url);
  if (!origin) return { error: `no page to read at ${tab.url ?? "(blank)"}` };
  const has = await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
  if (!has) return { error: "not_granted", origin };
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return r?.result ?? { error: "the page answered nothing" };
  } catch (e) {
    return { error: `could not run in the page: ${e.message}` };
  }
}

/* ---------------------------------------------------------- the debugger */

/** One session per tab, kept while the tab is being worked and dropped after
 *  a minute idle, on release, or when the operator dismisses Chrome's bar.
 *  A tab with DevTools already open refuses a second debugger; that is
 *  reported, not retried. */
const SESSION_IDLE_MS = 60_000;
const sessions = new Map();   // tabId → { lastAt }

try {
  chrome.debugger.onDetach.addListener((source) => { if (source?.tabId !== undefined) sessions.delete(source.tabId); });
} catch { /* not in a context with the debugger API */ }

async function attach(tabId) {
  const s = sessions.get(tabId);
  if (s) { s.lastAt = Date.now(); return null; }
  try { await chrome.debugger.attach({ tabId }, "1.3"); }
  catch (e) { return `could not attach the debugger: ${e.message}`; }
  sessions.set(tabId, { lastAt: Date.now() });
  return null;
}

async function detach(tabId) {
  if (!sessions.has(tabId)) return;
  sessions.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

function sweepSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [t, s] of [...sessions]) if (s.lastAt < cutoff) detach(t);
}

/** The tab in front of its window, the window not minimised — and drawn.
 *  Chrome hands input only to a tab it is drawing: a minimised or fully
 *  covered window gets none — the events are acknowledged into the void, or
 *  wait for a frame that never comes. The page's own visibilityState says
 *  which it is, so this asks the page (a read, in the isolated world) and,
 *  when it is hidden, raises the window: the machine's window comes up when
 *  the machine acts, which is what a watchable tab means. Windows lets only
 *  the foreground application raise a window, so failing that the tab moves
 *  to a fresh unfocused window, which is shown on top without taking the
 *  person's focus (the old window closes when it empties). Still hidden
 *  after all that is an error the caller sees, not a click nobody saw. */
async function front(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return { raised: false };
  let raised = false;
  if (!t.active) { raised = true; await chrome.tabs.update(tabId, { active: true }).catch(() => {}); }
  try {
    // The group it sits in may be collapsed — an active tab cannot be.
    if (t.groupId !== undefined && t.groupId >= 0) { const g = await chrome.tabGroups.get(t.groupId); if (g?.collapsed) { raised = true; await chrome.tabGroups.update(g.id, { collapsed: false }); } }
  } catch { /* not in a group, or no group API */ }
  try {
    const w = await chrome.windows.get(t.windowId);
    if (w.state === "minimized") await chrome.windows.update(t.windowId, { state: "normal" });
  } catch { /* the window is what it is */ }
  const drawn = async (ms = 0) => {
    for (const until = Date.now() + ms; ; ) {
      const r = await inPage(tabId, () => document.visibilityState, []);
      if (typeof r !== "string") return true;   // a page it may not read is not one it can wait on
      if (r === "visible") return true;
      if (Date.now() >= until) return false;
      await sleep(200);
    }
  };
  if (await drawn()) return { raised };
  raised = true;
  try { await chrome.windows.update(t.windowId, { focused: true }); } catch { /* raised or not */ }
  if (await drawn(1500)) return { raised };
  try {
    const w = await chrome.windows.create({ tabId, focused: false, type: "normal" });
    const moved = w.tabs?.[0] ?? (await chrome.tabs.query({ windowId: w.id }))[0];
    if (moved) await groupTab(moved.id, w.id);
  } catch { /* could not move it; the check below says so */ }
  if (await drawn(1500)) return { raised };
  const tab = await chrome.tabs.get(tabId).catch(() => t);
  const wins = await chrome.windows.getAll().catch(() => []);
  const where = wins.map((w) => `${w.id}${w.id === tab.windowId ? " (ours)" : ""}${w.focused ? " focused" : ""} ${w.state} ${w.width}×${w.height} at ${w.left},${w.top}`).join("; ");
  try { await chrome.windows.update(tab.windowId, { drawAttention: true }); } catch { /* fine */ }
  throw new Error(`the Messaging Quest window is not on screen — Chrome gives input only to a tab it is drawing. Bring that window into view (it is minimised or covered) and try again. Chrome's windows: ${where}`);
}

async function withDebugger(tabId, fn, { keep = true } = {}) {
  try { await front(tabId); } catch (e) { return { error: e.message }; }
  const err = await attach(tabId);
  if (err) return { error: err };
  const target = { tabId };
  // A command that never comes back is a tab Chrome is not drawing (a
  // covered or minimised window): say so, rather than hang the lane.
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} got no answer from the tab in 15s — its window may be covered or minimised; input needs the Messaging Quest window visible`)), 15_000);
    chrome.debugger.sendCommand(target, method, params).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
  try { return await fn(send, target); }
  catch (e) { return { error: `${e.message ?? e}` }; }
  finally {
    const s = sessions.get(tabId);
    if (s) s.lastAt = Date.now();
    if (!keep) await detach(tabId);
  }
}

/* ------------------------------------------------------------- the hands */

/** Where the mouse is on each tab, in CSS pixels. A person's pointer is
 *  somewhere on the page before they do anything; ours starts at a random
 *  spot in the middle third and moves from wherever it last was. */
const cursor = new Map();

async function viewport(send) {
  const m = await send("Page.getLayoutMetrics");
  const vp = m.cssVisualViewport ?? m.visualViewport;
  return { w: vp?.clientWidth ?? 1024, h: vp?.clientHeight ?? 768 };
}

const cursorOf = (tabId, vp) => {
  let c = cursor.get(tabId);
  if (!c) { c = { x: rand(vp.w * 0.3, vp.w * 0.7), y: rand(vp.h * 0.3, vp.h * 0.7) }; cursor.set(tabId, c); }
  return c;
};

/** Move along a curve — one control point off the straight line, eased at
 *  both ends, a pixel of jitter on the way — in steps sized to the distance. */
async function moveTo(send, tabId, to) {
  const vp = await viewport(send);
  const from = cursorOf(tabId, vp);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 0.5) return;
  const steps = clamp(Math.round(dist / 18) + Math.floor(rand(3, 8)), 6, 42);
  const bend = Math.min(140, dist * rand(0.08, 0.3)) * (Math.random() < 0.5 ? -1 : 1);
  const ux = (to.x - from.x) / dist, uy = (to.y - from.y) / dist;
  const mx = (from.x + to.x) / 2 - uy * bend, my = (from.y + to.y) / 2 + ux * bend;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const last = i === steps;
    const x = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * mx + e * e * to.x + (last ? 0 : rand(-1, 1));
    const y = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * my + e * e * to.y + (last ? 0 : rand(-1, 1));
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(rand(6, 22));
  }
  cursor.set(tabId, { x: to.x, y: to.y });
}

/** A point inside a box, off-centre the way a finger lands. */
const pointIn = (r) => ({ x: r.x + r.w * rand(0.28, 0.72), y: r.y + r.h * rand(0.32, 0.68) });

async function clickAt(send, tabId, pt, { button = "left", clicks = 1, modifiers = 0 } = {}) {
  await moveTo(send, tabId, pt);
  await pause(70, 240);
  for (let i = 1; i <= clicks; i++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button, clickCount: i, modifiers });
    await sleep(rand(45, 130));
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button, clickCount: i, modifiers });
    if (i < clicks) await sleep(rand(60, 120));
  }
}

/** Wheel ticks of uneven size with uneven gaps, at the pointer. */
async function wheel(send, at, dx, dy) {
  const total = Math.abs(dy || dx);
  let done = 0;
  while (done < total) {
    const tick = Math.min(total - done, Math.round(rand(70, 140)));
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: at.x, y: at.y,
      deltaX: dx ? Math.sign(dx) * tick : 0, deltaY: dy ? Math.sign(dy) * tick : 0,
    });
    done += tick;
    await sleep(rand(35, 110));
  }
}

/** Scroll until something is in the middle band of the viewport, a chunk at
 *  a time with a look between chunks. `rectOf` re-reads where it is now —
 *  from the page, after each scroll — and returns null when it is gone. */
async function bringIntoView(send, tabId, rectOf) {
  let lastY = null, stuck = 0;
  for (let i = 0; i < 30; i++) {
    const r = await rectOf();
    if (!r) return { error: "lost the element while scrolling to it — read_page or find again" };
    const cy = r.y + r.h / 2;
    if (cy >= r.vh * 0.15 && cy <= r.vh * 0.85 && r.x + r.w > 0 && r.x < r.vw) return { ok: true, rect: r, inView: true };
    if (lastY === r.scrollY && ++stuck >= 2) return { ok: true, rect: r, inView: false, note: "the page does not scroll any further" };
    lastY = r.scrollY;
    const want = cy - r.vh / 2;
    const chunk = Math.sign(want) * Math.min(Math.abs(want) + rand(0, 60), rand(240, 640));
    const at = { x: clamp(r.x + r.w / 2, 8, r.vw - 8), y: clamp(cy, 8, r.vh - 8) };
    await moveTo(send, tabId, at);
    await wheel(send, at, 0, chunk);
    await pause(110, 320);
  }
  return { ok: true, inView: false, note: "gave up after thirty scrolls" };
}

const rectOfRef = (tabId, ref) => async () => { const r = await inPage(tabId, refRect, [ref]); return r?.error ? null : r; };

/** One key, down and up, with the gap a finger leaves. */
async function press(send, token) {
  const k = keyStroke(token);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
  await send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await sleep(rand(30, 90));
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Text one key at a time, at a person's uneven rate, slower after
 *  punctuation. Printable ASCII goes as key events; anything else is inserted
 *  as a character — an IME would do the same. Never a newline into a
 *  single-line field: that is Enter, and Enter in a form submits. */
async function typeText(send, text, { kind = "textarea" } = {}) {
  let n = 0;
  for (const ch of text) {
    if (ch === "\n") {
      if (kind === "input") continue;
      await press(send, "enter");
    } else if (/^[\x20-\x7e]$/.test(ch)) {
      const [vk, code, shift] = keyOf(ch);
      const base = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: ch, unmodifiedText: ch });
      await sleep(rand(18, 60));
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    } else {
      await send("Input.insertText", { text: ch });
    }
    n++;
    await sleep(rand(45, 140) + (/[.,!?;:\n]/.test(ch) ? rand(80, 260) : 0));
  }
  return n;
}

/** The key a printable character sits on, US layout: [virtual key, code,
 *  shifted]. A character's own code point is NOT its key (46 is "." and also
 *  Delete — the first live run lost every full stop that way). */
const PUNCT = {
  ";": [186, "Semicolon", 0], ":": [186, "Semicolon", 1], "=": [187, "Equal", 0], "+": [187, "Equal", 1],
  ",": [188, "Comma", 0], "<": [188, "Comma", 1], "-": [189, "Minus", 0], "_": [189, "Minus", 1],
  ".": [190, "Period", 0], ">": [190, "Period", 1], "/": [191, "Slash", 0], "?": [191, "Slash", 1],
  "`": [192, "Backquote", 0], "~": [192, "Backquote", 1], "[": [219, "BracketLeft", 0], "{": [219, "BracketLeft", 1],
  "\\": [220, "Backslash", 0], "|": [220, "Backslash", 1], "]": [221, "BracketRight", 0], "}": [221, "BracketRight", 1],
  "'": [222, "Quote", 0], "\"": [222, "Quote", 1],
  "!": [49, "Digit1", 1], "@": [50, "Digit2", 1], "#": [51, "Digit3", 1], "$": [52, "Digit4", 1], "%": [53, "Digit5", 1],
  "^": [54, "Digit6", 1], "&": [55, "Digit7", 1], "*": [56, "Digit8", 1], "(": [57, "Digit9", 1], ")": [48, "Digit0", 1],
  " ": [32, "Space", 0],
};
function keyOf(ch) {
  if (PUNCT[ch]) return PUNCT[ch];
  const upper = ch.toUpperCase();
  if (/[A-Z]/.test(upper)) return [upper.charCodeAt(0), `Key${upper}`, ch === upper ? 1 : 0];
  if (/[0-9]/.test(ch)) return [ch.charCodeAt(0), `Digit${ch}`, 0];
  return [0, "", 0];
}

const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, shift: 8 };
const KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 }, escape: { key: "Escape", code: "Escape", vk: 27 }, esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }, delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 }, pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

function keyStroke(token) {
  const parts = token.split("+").filter(Boolean);
  const name = parts.pop() ?? "";
  let modifiers = 0;
  for (const m of parts) modifiers |= MODS[m.toLowerCase()] ?? 0;
  const known = KEYS[name.toLowerCase()];
  if (known) return { ...known, modifiers, text: modifiers & 6 ? undefined : known.text };
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : "";
    return { key: name, code, vk: upper.charCodeAt(0), modifiers, text: modifiers & 6 ? undefined : name };
  }
  return { key: name, code: name, vk: 0, modifiers };
}

/* ------------------------------------------------------------ the tools */

/** Where a click lands: a ref resolved in the page (screened there, scrolled
 *  into view by the wheel if it is off-screen), or a coordinate off the last
 *  screenshot, screened at that point in the page. */
async function target(tabId, input) {
  if (input.ref) {
    let r = await inPage(tabId, resolveRef, [String(input.ref), CLICK_SCREEN]);
    if (r.error) return r;
    if (r.refused) return { refused: true, error: r.why };
    if (!r.inView) {
      const s = await withDebugger(tabId, (send) => bringIntoView(send, tabId, rectOfRef(tabId, input.ref)));
      if (s.error) return s;
      r = await inPage(tabId, resolveRef, [String(input.ref), CLICK_SCREEN]);
      if (r.error) return r;
      if (r.refused) return { refused: true, error: r.why };
    }
    return pointIn(r);
  }
  const c = input.coordinate;
  if (!Array.isArray(c) || c.length !== 2) return { error: "a click takes a ref or a [x, y] coordinate from the most recent screenshot" };
  const s = shotScale.get(tabId) || 1;
  const x = Number(c[0]) / s + rand(-1.5, 1.5), y = Number(c[1]) / s + rand(-1.5, 1.5);
  const r = await inPage(tabId, screenAt, [x, y, CLICK_SCREEN]);
  if (r.error) return r;
  if (r.refused) return { refused: true, error: r.why };
  return { x, y };
}

/** Image pixels per CSS pixel of the last screenshot of each tab, so a
 *  coordinate read off that image lands where the model meant. */
const shotScale = new Map();

async function screenshot(tabId, clip = null) {
  const shot = async (send) => {
    const metrics = await send("Page.getLayoutMetrics");
    const vp = metrics.cssVisualViewport ?? metrics.visualViewport;
    const params = { format: "png", captureBeyondViewport: false };
    if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
    const { data } = await send("Page.captureScreenshot", params);
    let width = null, height = null;
    try {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const bmp = await createImageBitmap(blob);
      width = bmp.width; height = bmp.height; bmp.close();
    } catch { /* dimensions are a nicety */ }
    const scale = width && vp?.clientWidth ? width / (clip ? clip.width : vp.clientWidth) : 1;
    if (!clip) shotScale.set(tabId, scale);
    return { screenshot: `data:image/png;base64,${data}`, width, height, scale, viewport: { width: vp?.clientWidth, height: vp?.clientHeight } };
  };
  return withDebugger(tabId, shot);   // front() inside puts the tab where it can be drawn
}

async function computer(tabId, input) {
  const action = String(input.action ?? "");
  switch (action) {
    case "screenshot": return screenshot(tabId);
    case "zoom": {
      const g = input.region;
      if (!Array.isArray(g) || g.length !== 4) return { error: "zoom takes a [x0, y0, x1, y1] region" };
      const s = shotScale.get(tabId) || 1;
      return screenshot(tabId, { x: g[0] / s, y: g[1] / s, width: (g[2] - g[0]) / s, height: (g[3] - g[1]) / s });
    }
    case "wait": { await sleep(Math.min(10, Math.max(0, Number(input.duration) || 1)) * 1000); return { ok: true }; }
    case "scroll_to": {
      const ref = String(input.ref ?? "");
      const probe = await inPage(tabId, refRect, [ref]);
      if (probe.error) return probe;
      const out = await withDebugger(tabId, (send) => bringIntoView(send, tabId, rectOfRef(tabId, ref)));
      if (out.error) return out;
      const st = await inPage(tabId, scrollState, []);
      return { ok: true, inView: out.inView, note: out.note, ...(st.error ? {} : st) };
    }
    case "scroll": {
      const dir = String(input.scroll_direction ?? "down");
      const px = clamp(Number(input.scroll_amount) || 3, 1, 10) * 100 * rand(0.9, 1.15);
      const dx = dir === "left" ? -px : dir === "right" ? px : 0;
      const dy = dir === "up" ? -px : dir === "down" ? px : 0;
      const out = await withDebugger(tabId, async (send) => {
        const vp = await viewport(send);
        let at;
        if (Array.isArray(input.coordinate) && input.coordinate.length === 2) {
          const s = shotScale.get(tabId) || 1;
          at = { x: clamp(Number(input.coordinate[0]) / s, 4, vp.w - 4), y: clamp(Number(input.coordinate[1]) / s, 4, vp.h - 4) };
        } else {
          const c = cursorOf(tabId, vp);
          at = { x: clamp(c.x, 4, vp.w - 4), y: clamp(c.y, 4, vp.h - 4) };
        }
        await moveTo(send, tabId, at);
        await pause(40, 160);
        await wheel(send, at, dx, dy);
        return { ok: true };
      });
      if (out.error) return out;
      await pause(80, 200);
      const st = await inPage(tabId, scrollState, []);
      return { ok: true, ...(st.error ? {} : st) };
    }
    case "hover": {
      const t = await target(tabId, input);
      if (t.error) return t;
      return withDebugger(tabId, async (send) => { await moveTo(send, tabId, t); return { ok: true, x: t.x, y: t.y }; });
    }
    case "left_click": case "right_click": case "double_click": case "triple_click": {
      // The screen runs INSIDE target(): a refused label never reaches here.
      const t = await target(tabId, input);
      if (t.error) return t;
      const button = action === "right_click" ? "right" : "left";
      const clicks = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      let modifiers = 0;
      for (const m of String(input.modifiers ?? "").split("+")) modifiers |= MODS[m.trim().toLowerCase()] ?? 0;
      return withDebugger(tabId, async (send) => {
        await clickAt(send, tabId, t, { button, clicks, modifiers });
        return { ok: true, x: t.x, y: t.y };
      });
    }
    case "type": {
      const text = String(input.text ?? "");
      const gate = await inPage(tabId, screenActive, [CLICK_SCREEN, "type", ""]);
      if (gate.error) return gate;
      if (gate.refused) return { refused: true, error: gate.why };
      return withDebugger(tabId, async (send) => ({ ok: true, typed: await typeText(send, text, { kind: gate.kind }) }));
    }
    case "key": {
      const tokens = String(input.text ?? "").split(/\s+/).filter(Boolean);
      const repeat = Math.min(100, Math.max(1, Number(input.repeat) || 1));
      return withDebugger(tabId, async (send) => {
        for (let n = 0; n < repeat; n++) {
          for (const token of tokens) {
            // Enter and Space act on whatever has focus, so they go through
            // the same screen a click does — checked right before each one,
            // because a Tab in between moves the focus.
            if (/(^|\+)(enter|return|space)$/i.test(token)) {
              const gate = await inPage(tabId, screenActive, [CLICK_SCREEN, "key", token]);
              if (gate.error) return gate;
              if (gate.refused) return { refused: true, error: gate.why };
            }
            await press(send, token);
            await sleep(rand(40, 140));
          }
        }
        return { ok: true };
      });
    }
    default: return { error: `${action} is not a computer action` };
  }
}

/** Set a form control the way a person does: click into it, select what is
 *  there, type the new value; a checkbox gets a click when its state
 *  differs. A <select> is refused — its options are a native popup — and a
 *  composer is refused the way it is everywhere else. */
async function formInput(tabId, input) {
  const ref = String(input.ref ?? "");
  let info = await inPage(tabId, formTarget, [ref, CLICK_SCREEN]);
  if (info.error) return info;
  if (info.refused) return { refused: true, error: info.why };
  if (info.kind === "select") return { error: `form_input does not drive a <select> (options: ${(info.options ?? []).join(" | ")}) — click it and use the arrow keys, the way a person does` };
  if (!info.rect.inView) {
    const s = await withDebugger(tabId, (send) => bringIntoView(send, tabId, async () => { const r = await inPage(tabId, formTarget, [ref, CLICK_SCREEN]); return r?.rect ?? null; }));
    if (s.error) return s;
    info = await inPage(tabId, formTarget, [ref, CLICK_SCREEN]);
    if (info.error) return info;
  }
  const value = input.value;
  if (info.kind === "checkbox" || info.kind === "radio") {
    const want = typeof value === "boolean" ? value : /^(true|on|yes|1)$/i.test(String(value));
    if (info.checked === want) return { ok: true, checked: info.checked };
    const out = await withDebugger(tabId, async (send) => { await clickAt(send, tabId, pointIn(info.rect)); return { ok: true }; });
    if (out.error) return out;
    await pause(80, 200);
    const after = await inPage(tabId, formTarget, [ref, CLICK_SCREEN]);
    return { ok: true, checked: after.checked ?? want };
  }
  return withDebugger(tabId, async (send) => {
    await clickAt(send, tabId, pointIn(info.rect));
    await pause(90, 220);
    await press(send, isMac ? "cmd+a" : "ctrl+a");
    await pause(40, 120);
    const text = String(value ?? "");
    if (!text) await press(send, "backspace");
    else await typeText(send, text, { kind: info.kind });
    await pause(60, 160);
    const after = await inPage(tabId, formTarget, [ref, CLICK_SCREEN]);
    return { ok: true, value: after.value ?? text };
  });
}

/** What the browser itself logged for this page — errors, network, security,
 *  deprecation — via the Log domain, which replays its buffer on enable.
 *  Page console.log calls are not in it: reading those needs Runtime.enable,
 *  the one CDP call sites test for, and this file does not make it. */
async function consoleMessages(tabId, input) {
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
  const onlyErrors = Boolean(input.onlyErrors);
  const pattern = String(input.pattern ?? "");
  const messages = [];
  const listener = (source, method, params) => {
    if (source.tabId !== tabId || method !== "Log.entryAdded") return;
    const e = params.entry ?? {};
    messages.push({ level: e.level, source: e.source, text: String(e.text ?? "").slice(0, 2000), url: e.url, at: e.timestamp });
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    const out = await withDebugger(tabId, async (send) => {
      await send("Log.enable");
      await sleep(400);
      await send("Log.disable").catch(() => {});
      return { ok: true };
    });
    if (out.error) return out;
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }
  let list = messages;
  if (onlyErrors) list = list.filter((m) => m.level === "error");
  if (pattern) list = list.filter((m) => m.text.includes(pattern));
  return { messages: list.slice(-limit), total: messages.length, note: "the browser's own log — errors, network, security. Page console.log calls are not captured." };
}

/* ------------------------------------------------------------- the insert */

/**
 * The one thing that ever writes into a composer, and only the panel's
 * Insert button calls it — the human pressed Insert, and the human presses
 * the platform's own button after. Done the way a person does it: the
 * composer's opener ("Add a comment", "Reply" — never anything that could
 * submit) gets a real click if the box is closed, the box gets a real click,
 * the caret goes to the end, and the draft is pasted as one piece of text
 * (Input.insertText: the same event a paste produces). Nothing synthetic
 * touches the page.
 */
export async function insertDraft(tabId, message, spec = {}) {
  const text = String(message ?? "").trim();
  if (!text) return { ok: false, reason: "nothing to insert" };
  // The platform's words, off the reply card (lib/platform.mjs composerOf):
  // which labels open a composer, which sit on a reply box, which custom
  // elements host one. The words that may never be pressed are ours.
  const opens = wordsSource(spec?.opens, OPENS_DEFAULT);
  const replies = wordsSource(spec?.replies, REPLIES_DEFAULT);
  const hosts = (Array.isArray(spec?.hosts) ? spec.hosts : []).map((h) => String(h).trim()).filter((h) => /^[a-z][a-z0-9-]*$/i.test(h)).join(", ");
  const state = async () => {
    const s = await inPage(tabId, composerState, [opens, replies, NEVER.source, hosts]);
    return s?.error ? { error: s.error === "not_granted" ? "not_granted" : s.error } : s;
  };
  let st = await state();
  if (st.error) return { ok: false, reason: st.error };
  const out = await withDebugger(tabId, async (send) => {
    let opened = false;
    if (!st.box && st.opener) {
      const seen = await bringIntoView(send, tabId, async () => (await state()).opener?.rect ?? null);
      if (seen.error) return { ok: false, reason: seen.error };
      st = await state();
      if (!st.opener) return { ok: false, reason: "no_composer" };
      await clickAt(send, tabId, pointIn(st.opener.rect));
      opened = true;
      const deadline = Date.now() + 5000;
      while (!st.box && Date.now() < deadline) { await pause(150, 320); st = await state(); if (st.error) return { ok: false, reason: st.error }; }
    }
    if (!st.box) return { ok: false, reason: "no_composer" };
    const seen = await bringIntoView(send, tabId, async () => (await state()).box?.rect ?? null);
    if (seen.error) return { ok: false, reason: seen.error };
    st = await state();
    if (!st.box) return { ok: false, reason: "no_composer" };
    await clickAt(send, tabId, pointIn(st.box.rect));
    await pause(120, 300);
    await press(send, isMac ? "cmd+down" : "ctrl+end");
    if (!st.box.empty && st.box.kind !== "input") { await press(send, "enter"); await sleep(rand(60, 140)); await press(send, "enter"); }
    await pause(60, 160);
    await send("Input.insertText", { text });
    return { ok: true, opened };
  }, { keep: false });
  return out.error ? { ok: false, reason: out.error } : out;
}

/* ================================================================ in-page */
/* Everything below is SERIALIZED into the page by chrome.scripting — each
 * function is self-contained, gets its arguments as data, and shares one
 * scratch object (globalThis.__mq, in the extension's isolated world, which
 * page scripts cannot see) so a ref from read_page or find is still there
 * for the click that follows. None of them writes to the page: no attribute,
 * no element, no synthetic event, no scroll. The walk goes through open
 * shadow roots because Reddit builds its whole page out of them. */

function pageTree(filter, maxDepth, maxChars, refId) {
  const W = globalThis;
  W.__mq = W.__mq || { refs: [], byEl: new Map() };
  const refOf = (el) => {
    let n = W.__mq.byEl.get(el);
    if (!n) { n = W.__mq.refs.push(el); W.__mq.byEl.set(el, n); }
    return `ref_${n}`;
  };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|LINK|META|HEAD)$/;
  const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=checkbox], [role=radio], [role=switch], [role=textbox], [role=searchbox], [role=combobox], [role=option], [role=slider], [contenteditable=''], [contenteditable=true], [contenteditable=plaintext-only], [tabindex]:not([tabindex='-1'])";
  const TAGROLE = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    LI: "listitem", UL: "list", OL: "list", NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", FORM: "form", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader",
    ARTICLE: "article", SECTION: "region", ASIDE: "complementary", SUMMARY: "button", DETAILS: "group", LABEL: "label", P: "paragraph", DIALOG: "dialog", TIME: "time", BLOCKQUOTE: "blockquote", HR: "separator" };
  const INPUT = { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", image: "button", search: "searchbox", range: "slider", file: "button" };
  const visible = (el) => {
    if (el.getAttribute("aria-hidden") === "true" || el.hidden) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    if (el.tagName === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (el.tagName === "INPUT") return INPUT[el.type] || "textbox";
    if (el.isContentEditable) return "textbox";
    return TAGROLE[el.tagName] || "generic";
  };
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const nameOf = (el) => clean(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") ||
    (el.tagName === "INPUT" && !/^(password)$/.test(el.type) ? el.value : "") || (el.tagName === "TEXTAREA" ? el.value : "") || "");
  const ownText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  const kids = (el) => [...(el.shadowRoot ? el.shadowRoot.children : []), ...el.children];
  // An icon button's label often sits inside its own shadow root, where
  // innerText does not reach: the flat text, a few levels down, is the name.
  const deepText = (el, n) => {
    const out = [];
    const w = (x, d) => {
      if (d > 6 || out.join(" ").length > n) return;
      for (const k of x.childNodes) {
        if (k.nodeType === 3) { const t = k.textContent.trim(); if (t) out.push(t); }
        else if (k instanceof Element && !SKIP.test(k.tagName)) { if (k.shadowRoot) w(k.shadowRoot, d + 1); w(k, d + 1); }
      }
    };
    w(el, 0);
    return clean(out.join(" ")).slice(0, n);
  };
  const lines = [];
  let total = 0;
  const walk = (el, depth) => {
    if (!(el instanceof Element) || SKIP.test(el.tagName)) return;
    if (!visible(el)) return;
    const role = roleOf(el);
    const interactive = el.matches(INTERACTIVE);
    const text = ownText(el);
    const name = nameOf(el) || (interactive && !text ? deepText(el, 80) : "");
    const worth = interactive || role !== "generic" || text;
    if (worth && (filter !== "interactive" || interactive)) {
      const ref = interactive ? refOf(el) : null;
      let line = `${filter === "interactive" ? "" : "  ".repeat(depth)}${role}`;
      if (name) line += ` "${name.slice(0, 160)}"`;
      if (text && text !== name) line += ` ${JSON.stringify(text.slice(0, 200))}`;
      if (el.tagName === "A" && el.href) line += ` href=${JSON.stringify(el.href.slice(0, 200))}`;
      if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) line += el.checked ? " checked" : "";
      if (ref) line += ` [${ref}]`;
      lines.push(line);
      total += line.length + 1;
    }
    if (depth >= maxDepth) return;
    const d = worth && filter !== "interactive" ? depth + 1 : depth;
    for (const k of kids(el)) walk(k, d);
  };
  let root = document.body;
  if (refId) {
    const el = W.__mq.refs[Number(String(refId).replace(/^ref_/, "")) - 1];
    if (!el || !el.isConnected) return { error: `${refId} is not on this page any more` };
    root = el;
  }
  walk(root, 0);
  let tree = lines.join("\n");
  let truncated = false;
  if (tree.length > maxChars) {
    const cut = tree.lastIndexOf("\n", maxChars);
    tree = tree.slice(0, cut > 0 ? cut : maxChars) + `\n… truncated: ${total} characters in ${lines.length} lines; pass a larger max_chars, a smaller depth, or a ref_id to focus`;
    truncated = true;
  }
  return { tree, lines: lines.length, truncated, url: location.href, title: document.title };
}

function findInPage(query) {
  const W = globalThis;
  W.__mq = W.__mq || { refs: [], byEl: new Map() };
  const refOf = (el) => {
    let n = W.__mq.byEl.get(el);
    if (!n) { n = W.__mq.refs.push(el); W.__mq.byEl.set(el, n); }
    return `ref_${n}`;
  };
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { error: "find needs a query" };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|LINK|META|HEAD)$/;
  // The roles read_page reports, so a ref found here reads the same there.
  // A custom element (Reddit is made of them) reports its tag, which says
  // more than "generic" about what it is.
  const TAGROLE = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    LI: "listitem", UL: "list", OL: "list", NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", FORM: "form", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader",
    ARTICLE: "article", SECTION: "region", ASIDE: "complementary", SUMMARY: "button", DETAILS: "group", LABEL: "label", P: "paragraph", DIALOG: "dialog", TIME: "time", BLOCKQUOTE: "blockquote", HR: "separator" };
  const INPUT = { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", image: "button", search: "searchbox", range: "slider", file: "button" };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    if (el.tagName === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (el.tagName === "INPUT") return INPUT[el.type] || "textbox";
    if (el.isContentEditable) return "textbox";
    return TAGROLE[el.tagName] || (el.tagName.includes("-") ? el.tagName.toLowerCase() : "generic");
  };
  const CONTROL = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=textbox], [contenteditable=''], [contenteditable=true], [contenteditable=plaintext-only]";
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const visible = (el) => { if (el.getAttribute("aria-hidden") === "true" || el.hidden) return false; const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden"; };
  const nameOf = (el) => clean(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || "");
  const ownText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  const kids = (el) => [...(el.shadowRoot ? el.shadowRoot.children : []), ...el.children];
  // A control's words often sit in a child span or its own shadow root,
  // where its own text nodes are empty: the flat text a few levels down
  // names it, as read_page does — a "Comments" link is not an unnamed "a".
  const deepText = (el, n) => {
    const out = [];
    const w = (x, d) => {
      if (d > 6 || out.join(" ").length > n) return;
      for (const k of x.childNodes) {
        if (k.nodeType === 3) { const t = k.textContent.trim(); if (t) out.push(t); }
        else if (k instanceof Element && !SKIP.test(k.tagName)) { if (k.shadowRoot) w(k.shadowRoot, d + 1); w(k, d + 1); }
      }
    };
    w(el, 0);
    return clean(out.join(" ")).slice(0, n);
  };
  const matches = [];
  let more = 0;
  const walk = (el) => {
    if (!(el instanceof Element) || SKIP.test(el.tagName) || !visible(el)) return;
    const role = roleOf(el);
    const text = ownText(el);
    const name = nameOf(el) || (!text && el.matches(CONTROL) ? deepText(el, 80) : "");
    const value = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? clean(el.value) : "";
    const href = el.tagName === "A" && el.href ? String(el.href).slice(0, 200) : "";
    if (`${role} ${name} ${text} ${value} ${href}`.toLowerCase().includes(q)) {
      if (matches.length < 20) matches.push({ ref: refOf(el), role, name: name.slice(0, 160), text: text.slice(0, 200), ...(href ? { href } : {}) });
      else more++;
    }
    for (const k of kids(el)) walk(k);
  };
  walk(document.body);
  return { matches, more, note: more ? `${more} more matched — use a more specific query` : undefined };
}

function pageText(maxChars) {
  // innerText stops at a shadow boundary, and Reddit is made of them, so
  // this walks the flat tree itself: text nodes of visible elements, a line
  // break at each block.
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|LINK|META|HEAD)$/;
  const BLOCK = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|BLOCKQUOTE|PRE|BR|HR|DETAILS|SUMMARY|FORM|UL|OL|TABLE|DD|DT|DL|FIGURE|FIGCAPTION|SHREDDIT-POST|SHREDDIT-COMMENT)$/;
  const parts = [];
  const visible = (el) => { if (el.getAttribute("aria-hidden") === "true" || el.hidden) return false; const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden"; };
  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = node.textContent.replace(/\s+/g, " ");
      // Whitespace between inline siblings is still a word boundary.
      if (t.trim()) parts.push(t); else if (t && parts.length && !/\s$/.test(parts[parts.length - 1])) parts.push(" ");
      return;
    }
    if (!(node instanceof Element) || SKIP.test(node.tagName) || !visible(node)) return;
    const block = BLOCK.test(node.tagName) || /^(shreddit|faceplate)-/i.test(node.tagName);
    if (block) parts.push("\n");
    if (node.shadowRoot) for (const k of node.shadowRoot.childNodes) walk(k);
    for (const k of node.childNodes) walk(k);
    if (block) parts.push("\n");
  };
  const root = document.querySelector("main, article, [role=main]") || document.body;
  walk(root);
  let text = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars) + "\n… truncated";
  return { text, truncated, url: location.href, title: document.title };
}

/**
 * Rows off the page by a declared spec — the way the engine reads a
 * platform (lib/browse.mjs; the spec is the skill's, skills/<id>/pages.mjs).
 * `items` is a selector run through every shadow root; each field is
 *   attr:<name>            an attribute of the item
 *   attr:<name>@<selector> an attribute of the first matching descendant
 *   text:<selector>        the trimmed text of the first matching descendant
 *   href:<selector>        that descendant's href, made absolute
 *   text | href | tag      the item's own text, href, or tag name
 *   attrs                  every attribute of the item, as an object — for
 *                          measuring a shape, not for reading one
 * and `a|b` tries a, then b, and takes the first that answers — a page
 * that renders a date as <time datetime> here and <faceplate-timeago ts>
 * there is one field, not two.
 * Reads only: nothing here touches the page. Capped by `limit` (default
 * 100, at most 500) and by 4000 characters a field, so one page cannot
 * flood a run.
 */
function domExtract(spec) {
  const items = String(spec?.items ?? "").trim();
  const limit = Math.max(1, Math.min(500, Number(spec?.limit) || 100));
  const fields = spec?.fields && typeof spec.fields === "object" ? spec.fields : {};
  if (!items) return { error: "read_dom needs spec.items — a selector" };
  const roots = () => {
    const found = [document];
    for (let i = 0; i < found.length; i++) {
      for (const el of found[i].querySelectorAll("*")) if (el.shadowRoot) found.push(el.shadowRoot);
    }
    return found;
  };
  let matched;
  try { matched = []; for (const r of roots()) for (const el of r.querySelectorAll(items)) matched.push(el); }
  catch (e) { return { error: `bad selector: ${e.message}` }; }
  const total = matched.length;
  const seen = new Set();
  const uniq = [];
  for (const el of matched) { if (!seen.has(el)) { seen.add(el); uniq.push(el); } if (uniq.length >= limit) break; }
  const textOf = (el) => (el?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 4000);
  const hrefOf = (el) => { const h = el?.getAttribute?.("href"); if (!h) return null; try { return new URL(h, location.href).href; } catch { return h; } };
  const inside = (el, sel) => { try { return el.querySelector(sel) ?? (el.shadowRoot ? el.shadowRoot.querySelector(sel) : null); } catch { return null; } };
  const read = (el, how) => {
    const h = String(how ?? "");
    if (h.includes("|")) { for (const part of h.split("|")) { const v = read(el, part.trim()); if (v !== null && v !== undefined && v !== "") return v; } return null; }
    if (h === "text") return textOf(el);
    if (h === "href") return hrefOf(el);
    if (h === "tag") return el.tagName.toLowerCase();
    if (h === "attrs") { const o = {}; for (const a of el.attributes) o[a.name] = String(a.value).slice(0, 300); return o; }
    let m;
    if ((m = /^attr:([^@]+)@(.+)$/.exec(h))) { const d = inside(el, m[2]); return d ? d.getAttribute(m[1]) : null; }
    if ((m = /^attr:(.+)$/.exec(h))) return el.getAttribute(m[1]);
    if ((m = /^text:(.+)$/.exec(h))) { const d = inside(el, m[1]); return d ? textOf(d) : null; }
    if ((m = /^href:(.+)$/.exec(h))) { const d = inside(el, m[1]); return d ? hrefOf(d) : null; }
    return null;
  };
  const rows = uniq.map((el) => { const row = {}; for (const [k, how] of Object.entries(fields)) row[k] = read(el, how); return row; });
  return { rows, total, url: location.href, title: document.title };
}

/** A ref's box on the viewport plus the viewport itself — what the wheel
 *  needs to bring it into view. Reads only. */
function refRect(ref) {
  const el = globalThis.__mq?.refs?.[Number(String(ref).replace(/^ref_/, "")) - 1];
  if (!el || !el.isConnected) return { error: `${ref} is not on this page — read_page or find again` };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, scrollX: window.scrollX, scrollY: window.scrollY };
}

function scrollState() {
  return { scrollY: window.scrollY, scrollX: window.scrollX, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight };
}

/** A ref's box, and the click screen: the element's own label and every
 *  actionable ancestor's, through shadow hosts, against the words the
 *  extension will not press. Does not scroll — the wheel does that. */
function resolveRef(ref, screenSrc) {
  const W = globalThis;
  const el = W.__mq?.refs?.[Number(String(ref).replace(/^ref_/, "")) - 1];
  if (!el || !el.isConnected) return { error: `${ref} is not on this page — read_page or find again` };
  const SCREEN = new RegExp(screenSrc, "i");
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  // The label is read through shadow roots: innerText stops at one, and a
  // "Comment" button whose word sits inside its own shadow root would
  // otherwise pass the screen with an empty label.
  const deepText = (x, n) => {
    const out = [];
    const w = (y, d) => { if (d > 6 || out.join(" ").length > n) return; for (const k of y.childNodes) { if (k.nodeType === 3) { const t = k.textContent.trim(); if (t) out.push(t); } else if (k instanceof Element && !/^(SCRIPT|STYLE|SVG)$/.test(k.tagName)) { if (k.shadowRoot) w(k.shadowRoot, d + 1); w(k, d + 1); } } };
    w(x, 0);
    return clean(out.join(" ")).slice(0, n);
  };
  const label = (e) => clean(e.getAttribute?.("aria-label") || e.getAttribute?.("title") || e.getAttribute?.("alt") || (e.tagName === "INPUT" ? e.value : "") || deepText(e, 80)).slice(0, 80);
  // Reddit's controls are custom elements, and so are its containers: a
  // <shreddit-post> holds a title link, "1 vote", "3 comments". A control's
  // text is its label; a container's is a post. Only the short one is
  // screened, or every title would be refused for the words around it.
  const actionable = (e) => e instanceof Element && (e.matches("button, a, summary, label, input, [role=button], [role=menuitem], [role=tab], [role=link], [role=option]") || e.hasAttribute("onclick") ||
    (/^(shreddit|faceplate)-/i.test(e.tagName) && (e.hasAttribute("aria-label") || deepText(e, 120).length <= 40)));
  let e = el;
  for (let i = 0; e && i < 10; i++) {
    if (actionable(e)) {
      const l = label(e);
      const hit = SCREEN.exec(l);
      if (hit) return { refused: true, why: `click refused — the control "${l}" carries "${hit[1]}", a label the extension will not press on an agent's behalf. A human presses that button.` };
      if ((e.tagName === "BUTTON" && (e.type === "submit" || !e.getAttribute("type")) && e.form) || (e.tagName === "INPUT" && e.type === "submit"))
        return { refused: true, why: `click refused — "${l || "that button"}" submits a form, and nothing here submits.` };
    }
    e = e.parentNode instanceof ShadowRoot ? e.parentNode.host : e.parentElement;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { error: `${ref} has no size on screen right now` };
  const cy = r.top + r.height / 2;
  const inView = cy >= innerHeight * 0.1 && cy <= innerHeight * 0.9 && r.left + r.width > 0 && r.left < innerWidth;
  return { x: r.left, y: r.top, w: r.width, h: r.height, inView };
}

/** The same screen for a coordinate: whatever is under that point, through
 *  shadow roots, and its actionable ancestors. */
function screenAt(x, y, screenSrc) {
  const SCREEN = new RegExp(screenSrc, "i");
  const deepest = (root, px, py) => {
    let el = root.elementFromPoint(px, py);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const el = deepest(document, x, y);
  if (!el) return { ok: true, nothing: true };
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const deepText = (x0, n) => {
    const out = [];
    const w = (y0, d) => { if (d > 6 || out.join(" ").length > n) return; for (const k of y0.childNodes) { if (k.nodeType === 3) { const t = k.textContent.trim(); if (t) out.push(t); } else if (k instanceof Element && !/^(SCRIPT|STYLE|SVG)$/.test(k.tagName)) { if (k.shadowRoot) w(k.shadowRoot, d + 1); w(k, d + 1); } } };
    w(x0, 0);
    return clean(out.join(" ")).slice(0, n);
  };
  const label = (e) => clean(e.getAttribute?.("aria-label") || e.getAttribute?.("title") || e.getAttribute?.("alt") || (e.tagName === "INPUT" ? e.value : "") || deepText(e, 80)).slice(0, 80);
  // Reddit's controls are custom elements, and so are its containers: a
  // <shreddit-post> holds a title link, "1 vote", "3 comments". A control's
  // text is its label; a container's is a post. Only the short one is
  // screened, or every title would be refused for the words around it.
  const actionable = (e) => e instanceof Element && (e.matches("button, a, summary, label, input, [role=button], [role=menuitem], [role=tab], [role=link], [role=option]") || e.hasAttribute("onclick") ||
    (/^(shreddit|faceplate)-/i.test(e.tagName) && (e.hasAttribute("aria-label") || deepText(e, 120).length <= 40)));
  let e = el;
  for (let i = 0; e && i < 10; i++) {
    if (actionable(e)) {
      const l = label(e);
      const hit = SCREEN.exec(l);
      if (hit) return { refused: true, why: `click refused — the control "${l}" carries "${hit[1]}", a label the extension will not press on an agent's behalf. A human presses that button.` };
      if ((e.tagName === "BUTTON" && (e.type === "submit" || !e.getAttribute("type")) && e.form) || (e.tagName === "INPUT" && e.type === "submit"))
        return { refused: true, why: `click refused — "${l || "that button"}" submits a form, and nothing here submits.` };
    }
    e = e.parentNode instanceof ShadowRoot ? e.parentNode.host : e.parentElement;
  }
  return { ok: true, tag: el.tagName.toLowerCase() };
}

/** The screen for what has focus — the target of a typed key. `mode` is
 *  "type" (text is about to go in: the focus must be a text field and not a
 *  composer) or "key" (one stroke: Enter/Space on a control go through the
 *  click screen, Enter in a form's input would submit it, ctrl/cmd+Enter is
 *  the chord that submits a composer). Reads only. */
function screenActive(screenSrc, mode, stroke) {
  const SCREEN = new RegExp(screenSrc, "i");
  const COMPOSER = /\b(comment|reply|post|message|chat|compose|composer)\b/i;
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const deepText = (x0, n) => {
    const out = [];
    const w = (y0, d) => { if (d > 6 || out.join(" ").length > n) return; for (const k of y0.childNodes) { if (k.nodeType === 3) { const t = k.textContent.trim(); if (t) out.push(t); } else if (k instanceof Element && !/^(SCRIPT|STYLE|SVG)$/.test(k.tagName)) { if (k.shadowRoot) w(k.shadowRoot, d + 1); w(k, d + 1); } } };
    w(x0, 0);
    return clean(out.join(" ")).slice(0, n);
  };
  const label = (e) => clean(e.getAttribute?.("aria-label") || e.getAttribute?.("title") || e.getAttribute?.("alt") || e.getAttribute?.("placeholder") || e.getAttribute?.("name") || (e.tagName === "INPUT" ? e.value : "") || deepText(e, 80)).slice(0, 80);
  // Reddit's controls are custom elements, and so are its containers: a
  // <shreddit-post> holds a title link, "1 vote", "3 comments". A control's
  // text is its label; a container's is a post. Only the short one is
  // screened, or every title would be refused for the words around it.
  const actionable = (e) => e instanceof Element && (e.matches("button, a, summary, label, input, [role=button], [role=menuitem], [role=tab], [role=link], [role=option]") || e.hasAttribute("onclick") ||
    (/^(shreddit|faceplate)-/i.test(e.tagName) && (e.hasAttribute("aria-label") || deepText(e, 120).length <= 40)));
  const hosts = (e) => { const out = []; for (let i = 0; e && i < 10; i++) { out.push(e); e = e.parentNode instanceof ShadowRoot ? e.parentNode.host : e.parentElement; } return out; };
  const clickScreen = (e) => {
    for (const a of hosts(e)) {
      if (!actionable(a)) continue;
      const l = label(a);
      const hit = SCREEN.exec(l);
      if (hit) return `key refused — the focused control "${l}" carries "${hit[1]}", a label the extension will not press on an agent's behalf. A human presses that button.`;
      if ((a.tagName === "BUTTON" && (a.type === "submit" || !a.getAttribute("type")) && a.form) || (a.tagName === "INPUT" && a.type === "submit"))
        return `key refused — "${l || "that button"}" submits a form, and nothing here submits.`;
    }
    return null;
  };
  const composerOf = (e) => {
    for (const a of hosts(e)) {
      const l = clean(a.getAttribute?.("aria-label") || a.getAttribute?.("placeholder") || a.getAttribute?.("title") || a.getAttribute?.("name") || "");
      if (COMPOSER.test(l)) return l;
      if (/^(shreddit-composer|comment-composer-host|shreddit-composer-host)$/i.test(a.tagName)) return a.tagName.toLowerCase();
    }
    return null;
  };
  const s0 = String(stroke ?? "").toLowerCase();
  if (mode === "key" && /(^|\+)(enter|return)$/.test(s0) && /(^|\+)(ctrl|control|cmd|meta|command)\+/.test(s0))
    return { refused: true, why: `key refused — ${stroke} is the chord that submits a composer, and a human presses that.` };
  if (!el || el === document.body || el === document.documentElement) {
    return mode === "type" ? { refused: true, why: "typing refused — nothing on the page has focus; click into a text field first" } : { ok: true, kind: "none" };
  }
  const kind = el.isContentEditable ? "editable" : el.tagName === "TEXTAREA" ? "textarea"
    : el.tagName === "INPUT" && !/^(checkbox|radio|submit|button|image|file|range|color|reset)$/.test(el.type) ? "input" : "control";
  const l = label(el);
  if (mode === "type") {
    if (kind === "control") return { refused: true, why: `typing refused — the focus is on ${l ? `"${l}"` : el.tagName.toLowerCase()}, not a text field; click into a field first` };
    const c = composerOf(el);
    if (c) return { refused: true, why: `typing refused — "${c}" is a composer, and nothing here writes into one on an agent's behalf. The Insert button on the panel does, for the human.` };
    return { ok: true, kind, inForm: Boolean(el.form) };
  }
  const s = String(stroke ?? "").toLowerCase();
  const enter = /(^|\+)(enter|return)$/.test(s), space = /(^|\+)space$/.test(s);
  if (enter && /(^|\+)(ctrl|control|cmd|meta|command)\+/.test(s)) return { refused: true, why: `key refused — ${stroke} is the chord that submits a composer, and a human presses that.` };
  if (enter && kind === "input" && el.form) return { refused: true, why: `key refused — Enter in "${l || "that field"}" submits its form, and nothing here submits.` };
  if ((enter || space) && kind === "control") { const why = clickScreen(el); if (why) return { refused: true, why }; }
  if (enter && (kind === "editable" || kind === "textarea")) { const c = composerOf(el); if (c) return { refused: true, why: `key refused — "${c}" is a composer, and nothing here writes into one on an agent's behalf.` }; }
  return { ok: true, kind };
}

/** A form control by ref: what it is, what it holds, where it is — and the
 *  same two refusals as everywhere (a button is not a value; a composer is
 *  never written on an agent's behalf). Reads only; the hands do the rest. */
function formTarget(ref, screenSrc) {
  const el = globalThis.__mq?.refs?.[Number(String(ref).replace(/^ref_/, "")) - 1];
  if (!el || !el.isConnected) return { error: `${ref} is not on this page — read_page or find again` };
  void screenSrc;
  const COMPOSER = /\b(comment|reply|post|message|chat|compose|composer)\b/i;
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const label = clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
  if (el.tagName === "BUTTON" || (el.tagName === "INPUT" && /^(submit|button|image|reset)$/.test(el.type)))
    return { error: `form_input sets values; ${label || "that"} is a button` };
  let e = el;
  for (let i = 0; e && i < 10; i++) {
    const l = clean(e.getAttribute?.("aria-label") || e.getAttribute?.("placeholder") || e.getAttribute?.("title") || e.getAttribute?.("name") || "");
    if (COMPOSER.test(l) || /^(shreddit-composer|comment-composer-host|shreddit-composer-host)$/i.test(e.tagName))
      return { refused: true, why: `form_input refused — "${l || e.tagName.toLowerCase()}" is a composer, and nothing here writes into one on an agent's behalf. The Insert button on the panel does, for the human.` };
    e = e.parentNode instanceof ShadowRoot ? e.parentNode.host : e.parentElement;
  }
  const kind = el.tagName === "SELECT" ? "select"
    : el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio") ? el.type
    : el.isContentEditable ? "editable" : el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "INPUT" ? "input" : null;
  if (!kind) return { error: `${ref} is not a form control` };
  if (el.disabled || el.readOnly) return { error: `${label || ref} is ${el.disabled ? "disabled" : "read-only"}` };
  const r = el.getBoundingClientRect();
  const cy = r.top + r.height / 2;
  return {
    kind, label,
    checked: kind === "checkbox" || kind === "radio" ? el.checked : null,
    value: kind === "editable" ? clean(el.textContent) : kind === "select" ? el.value : el.value ?? null,
    options: kind === "select" ? [...el.options].map((o) => o.text.trim()).slice(0, 20) : undefined,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, scrollY: window.scrollY,
      inView: r.width > 0 && cy >= innerHeight * 0.1 && cy <= innerHeight * 0.9 },
  };
}

function networkRequests(limit, pattern) {
  const rows = performance.getEntriesByType("resource")
    .filter((e) => !pattern || e.name.includes(pattern))
    .slice(-limit)
    .map((e) => ({ url: e.name.slice(0, 300), type: e.initiatorType, ms: Math.round(e.duration), bytes: e.transferSize }));
  return { requests: rows, total: performance.getEntriesByType("resource").length, note: "from the page's performance timeline — status codes are not exposed there" };
}
