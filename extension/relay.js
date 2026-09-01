// The browser's half of the read lane: ask the local server if any reads are
// waiting, do them in THIS browser — the user's session, the user's address,
// a page the platform serves to any signed-in human — and hand the bodies
// back. The server's broker (lib/relay.mjs) holds the law of the lane; this
// file's contribution to it is structural:
//
//   * The method is the literal string "GET". A job carries a URL and nothing
//     else, so no field in the protocol can make this browser do anything but
//     read. (G5, inherited from the predecessor's relay.)
//   * Nothing runs without the site permission the user granted by hand — the
//     same visible per-site grant the insert flow asks for, never a wildcard.
//
// Used by the side panel (long-polls while open — the fast path) and by the
// service worker's once-a-minute alarm (the catch-up path when the panel is
// closed but the browser is running; browser closed = nobody reads, which is
// the honest state: a human is offline too).

export const RELAY_ORIGINS = ["https://www.reddit.com/*", "https://old.reddit.com/*"];

/**
 * One pass: claim whatever is waiting (parking up to `wait` ms on the
 * server), run each read, answer each. Returns what happened so the caller
 * can render it: {permission:false} means the lane is dark for want of the
 * site grant, and the panel says so instead of leaving jobs to time out
 * silently.
 */
export async function relayPass(base, { wait = 0 } = {}) {
  const permission = await chrome.permissions.contains({ origins: RELAY_ORIGINS }).catch(() => false);
  if (!permission) return { ran: 0, permission: false };

  let jobs = [];
  try {
    const res = await fetch(`${base}/api/relay/jobs?wait=${wait}`, { signal: AbortSignal.timeout(wait + 8000) });
    jobs = (await res.json()).jobs ?? [];
  } catch {
    return { ran: 0, permission: true }; // server gone — the panel's deck fetch will say so
  }

  for (const job of jobs) {
    const answer = await readOne(job.url);
    try {
      await fetch(`${base}/api/relay/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: job.id, ...answer }),
        signal: AbortSignal.timeout(8000),
      });
    } catch { /* the job times out server-side; a lost answer is just late */ }
  }
  return { ran: jobs.length, permission: true };
}

async function readOne(url) {
  try {
    const res = await fetch(url, {
      method: "GET",                    // a literal, and the whole point
      credentials: "include",           // the user's own session — that IS the lane
      redirect: "follow",
      headers: { accept: "*/*" },
      signal: AbortSignal.timeout(25_000),
    });
    const body = (await res.text()).slice(0, 1_500_000);
    return {
      status: res.status,
      body,
      finalUrl: res.url || url,
      retryAfter: Number(res.headers.get("x-ratelimit-reset")) || 0,
    };
  } catch (e) {
    return { error: e.name === "TimeoutError" ? "timeout in the browser" : `browser fetch failed: ${e.message}` };
  }
}
