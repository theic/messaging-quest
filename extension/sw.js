// The service worker does five small things and nothing else: the toolbar
// icon opens the side panel; a once-a-minute alarm asks the local server how
// many cards are waiting so the badge can say so; the same alarm runs one
// relay pass (relay.js) so a read the anonymous lane refused can be answered
// by this browser even with the panel closed; it keeps the control lane's
// claim loop alive (control.js) — the toolkit a task drives leased tabs with;
// and it is the one owner of the debugger, so the panel's Insert button asks
// it to put a draft into a composer (insertDraft) rather than attaching a
// second session of its own.
// The pace stays the server's — the alarm only ever picks up what the governed
// engine already queued, and the control broker spaces navigations per site.
//
// On keeping the worker alive: MV3 kills an idle worker after ~30s, and the
// control loop is the most common way a thing like this silently stops. The
// loop makes an extension API call on every pass (that resets the timer), and
// the alarm restarts the loop once Chrome has killed the worker anyway.
// Neither alone is enough (the predecessor's bridge learned this the hard way).

import { relayPass } from "./relay.js";
import { ensureControlLoop, insertDraft } from "./control.js";

const DEFAULT_BASE = "http://127.0.0.1:8787";

const baseUrl = async () => (await chrome.storage.local.get({ base: DEFAULT_BASE })).base;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("deck", { periodInMinutes: 1 });
  ensureControlLoop(await baseUrl());
});
chrome.runtime.onStartup.addListener(async () => ensureControlLoop(await baseUrl()));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "deck") return;
  const base = await baseUrl();
  ensureControlLoop(base);             // brings the loop back if the worker was killed
  relayPass(base).catch(() => {});     // the catch-up path; the panel long-polls when open
  try {
    const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    const { cards } = await res.json();
    // Waits and the quiet card are not asks; everything else is.
    const asks = (cards ?? []).filter((c) => !/^(onboard\.wait|onboard\.probing|work\.quiet|task\.running)$/.test(c.kind ?? c.id)).length;
    chrome.action.setBadgeText({ text: asks ? String(asks) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  } catch {
    // Server down = badge off. The panel says how to start it; the badge nagging
    // about a machine that is not running would be noise.
    chrome.action.setBadgeText({ text: "" });
  }
});

// The panel's Insert button: the human pressed it, this puts the draft into
// the composer of the tab the panel just opened, the human presses the
// platform's own button. Only the panel can send this — runtime messages
// come from this extension's own pages.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== "insert") return false;
  insertDraft(Number(msg.tabId), String(msg.text ?? ""))
    .then(reply, (e) => reply({ ok: false, reason: String(e?.message ?? e) }));
  return true;
});

// The worker was just started by something — an event, the panel, Chrome
// itself. Whatever it was, the lane should be listening.
baseUrl().then(ensureControlLoop).catch(() => {});
