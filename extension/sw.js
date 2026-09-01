// The service worker does two small things and nothing else: the toolbar icon
// opens the side panel, and a once-a-minute alarm asks the local server how
// many cards are waiting so the badge can say so. All reading of Reddit stays
// on the server's clock (a minute a request, measured); nothing here fetches
// anything but our own loopback address.

const DEFAULT_BASE = "http://127.0.0.1:8787";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("deck", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "deck") return;
  const { base } = await chrome.storage.local.get({ base: DEFAULT_BASE });
  try {
    const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    const { cards } = await res.json();
    // Waits and the quiet card are not asks; everything else is.
    const asks = (cards ?? []).filter((c) => !/^(onboard\.wait|onboard\.probing|work\.quiet)$/.test(c.kind ?? c.id)).length;
    chrome.action.setBadgeText({ text: asks ? String(asks) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  } catch {
    // Server down = badge off. The panel says how to start it; the badge nagging
    // about a machine that is not running would be noise.
    chrome.action.setBadgeText({ text: "" });
  }
});
