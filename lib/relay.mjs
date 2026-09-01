// The browser read lane — the survival plan made mechanism.
//
// The anonymous lane sits at Reddit's enforced ceiling (one request a minute
// per address, the 2026-06-11 RSS throttle) with a dated eviction warning on
// it. The lane that no lawsuit and no license negotiation has touched is the
// user's own logged-in browser reading pages the way it always does — so when
// an anonymous FINDING read is refused, the engine can hand that one URL to
// the extension, which fetches it in the user's session and hands the body
// back. The predecessor proved the shape (messaging-quest-monitoring's relay:
// "discovery read reddit from Node and got a 403, so reddit could never be
// explored at all" — until reads went through the panel).
//
// The law of the lane, inherited and kept:
//   * GET only, by construction. A job carries a URL and nothing else; the
//     extension's fetch has its method written as a literal. No field in this
//     protocol can make a browser do anything but read.
//   * Finding only. sync/check/back measure what a STRANGER sees, and a
//     logged-in read would answer a different question wearing the right
//     clothes. The doctrine is enforced at the call sites in bin/es.mjs and
//     pinned by a test that counts them.
//   * Same pace. The lane changes the transport, never the tempo — a relayed
//     read only ever follows a failed governed read, so the 65s gap still
//     spaces everything.
//   * Only URLs a loaded platform recognises as one of its rooms. This
//     process is localhost-only, but "the relay will fetch anything with the
//     user's cookies" is not a sentence that should be true anyway.
//
// Two halves in one file because they are one protocol: the BROKER lives in
// the dashboard server (the long-lived process the extension is attached to),
// and the CLIENT is what a CLI child calls when the server told it — via the
// EARSHOT_RELAY env var — that a broker exists.

import { roomOf } from "./platform.mjs";

/* ----------------------------------------------------------------- broker */

/**
 * Held jobs, waiting browsers, and the promise each read is to its caller.
 * Everything times out: a job nobody claims, a claim nobody answers, a poll
 * with nothing to say. A relay that can hang is a tick that never ends.
 */
export function relayBroker({ ttlMs = 75_000, cap = 8 } = {}) {
  const jobs = new Map();   // id → {url, resolve, timer, claimed}
  let waiters = [];         // pollers parked until a job arrives
  let seq = 0;
  let lastPoll = 0;

  const wake = () => {
    const unclaimed = [...jobs.values()].some((j) => !j.claimed);
    if (!unclaimed) return;
    for (const w of waiters.splice(0)) w();
  };

  return {
    /**
     * One read through somebody's browser. Resolves with what the browser
     * saw ({status, body, finalUrl, retryAfter}) or with {error} — never
     * rejects, because to the caller a failed relay is just a failed read.
     */
    read(url) {
      const u = String(url ?? "");
      if (!/^https:\/\//i.test(u)) return Promise.resolve({ error: "relay reads https only" });
      if (!roomOf(u)) return Promise.resolve({ error: "relay reads only a platform's own rooms" });
      if (jobs.size >= cap) return Promise.resolve({ error: "relay queue is full" });
      return new Promise((resolve) => {
        const id = `r${++seq}`;
        const timer = setTimeout(() => {
          jobs.delete(id);
          resolve({ error: "relay unanswered — no browser picked it up in time" });
        }, ttlMs);
        jobs.set(id, { url: u, resolve, timer, claimed: false });
        wake();
      });
    },

    /**
     * What a browser should read right now. `waitMs` parks the poll until a
     * job arrives (the panel long-polls; the service worker's once-a-minute
     * alarm passes 0). Claimed jobs are not re-handed out — two browsers must
     * not read the same URL twice for one answer.
     */
    async claim(waitMs = 0) {
      lastPoll = Date.now();
      const take = () => {
        const out = [];
        for (const [id, j] of jobs.entries()) if (!j.claimed) { j.claimed = true; out.push({ id, url: j.url }); }
        return out;
      };
      let out = take();
      if (out.length || waitMs <= 0) return out;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, waitMs);
        waiters.push(() => { clearTimeout(t); resolve(); });
      });
      lastPoll = Date.now();
      return take();
    },

    /** A browser's answer. Unknown ids are fine — the job may have timed out
     *  while the fetch ran, and a late answer is not an error, just late. */
    answer(id, { status, body, finalUrl, retryAfter, error } = {}) {
      const j = jobs.get(String(id ?? ""));
      if (!j) return false;
      clearTimeout(j.timer);
      jobs.delete(String(id));
      j.resolve(error
        ? { error: String(error).slice(0, 300) }
        : {
            status: Number(status) || 0,
            body: String(body ?? "").slice(0, 1_500_000),
            finalUrl: String(finalUrl ?? j.url),
            retryAfter: Number(retryAfter) || 0,
          });
      return true;
    },

    /** Whether anything has polled recently enough to call the lane live. */
    attached: () => Date.now() - lastPoll < 90_000,
    pending: () => jobs.size,
  };
}

/* ----------------------------------------------------------------- client */

/**
 * The CLI side: hand one URL to the broker named by EARSHOT_RELAY and wait.
 * The request is held open for as long as the broker might — its ttl plus
 * slack — because "the browser is reading it" genuinely takes seconds.
 */
export async function relayRead(base, url) {
  try {
    const res = await fetch(`${String(base).replace(/\/$/, "")}/api/relay/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(90_000),
    });
    const out = await res.json();
    return out && typeof out === "object" ? out : { error: "relay spoke gibberish" };
  } catch (e) {
    return { error: `relay unreachable: ${e.name === "TimeoutError" ? "timeout" : e.message}` };
  }
}
