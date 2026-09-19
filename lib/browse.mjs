// The engine's browser — the ONE way anything in this repo reads a platform
// (0.6.0, the operator's rule: "reddit must not be accessed anyhow but from
// the fully rendered human browser, and for engineering simplicity this is
// the only browsing mechanism in the tool").
//
// There is no fetch of a platform page anywhere else. A probe, a tick, a
// visibility check, the site scout, a colleague on its own thread — every one
// of them opens a real tab in the operator's own Chrome through the control
// lane (lib/control.mjs), waits for the page to render, reads it the way the
// extension reads everything (in the isolated world, writing nothing), and
// closes the tab. Pace, pauses and the machine's own window are the lane's;
// this file only holds a lease and asks.
//
// Two seats:
//   * the operator's own session — the finding reads. Posts, searches, a
//     colleague's search page. What a signed-in person sees.
//   * the STRANGER's — the visibility verbs (sync, check, back). A
//     shadow-removed comment is shown to its author as if nothing happened,
//     so "what became of what I wrote" can only be measured logged out. The
//     lease asks for `stranger: true`, the extension opens the tab in an
//     Incognito window (which Chrome only allows once the operator has ticked
//     "Allow in Incognito" for the extension), and a read that cannot have
//     that seat fails with the door named rather than answering from the
//     wrong one.
//
// What comes back is what the platform's page spec asked for (`read_dom`: a
// selector, a field map, a cap — declared by the skill, executed by the
// extension, never platform code in the page) or the page's text. The
// skill turns rows into entries; the engine never sees a DOM.

import { controlClient, isHidden } from "./control.mjs";
import { env } from "./fs.mjs";

/** Is the lane live right now — a browser polling for work? Asked before a
 *  read so a bare terminal fails in a second with the reason, not after the
 *  lease's minute-long wait for a browser that is not there. */
export async function attached(base) {
  try {
    const res = await fetch(`${String(base).replace(/\/$/, "")}/api/control/leases`, { signal: AbortSignal.timeout(4000) });
    return Boolean((await res.json())?.attached);
  } catch {
    return false;
  }
}

export const NOT_ATTACHED = "the browser is not attached — every read happens in your own Chrome. Keep `mq serve` running, open Chrome with the Messaging Quest extension loaded, and try again.";
const NO_SERVER = "no server to reach the browser through — run `mq serve` (the panel and the reads both live there) and try again.";
const NO_STRANGER = "the stranger's view needs an Incognito tab, and Chrome has not allowed the extension there yet: chrome://extensions → Messaging Quest → Details → “Allow in Incognito”. A signed-in read cannot see a shadow-removal, so this is refused rather than answered from the wrong seat.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameSite = (a, b) => String(a ?? "").replace(/\/\*?$/, "") === String(b ?? "").replace(/\/\*?$/, "");
/** How long a patient browser waits for the operator to press Allow, and how
 *  often it looks. Well inside a lease's own life (lib/control.mjs). */
const HOLD_MS = 8 * 60_000;
const HOLD_POLL_MS = 2_000;

/**
 * A browser on one lease. `open(url)` leases the tab (the first page), later
 * `goto(url)` turns pages in it; every read is one toolkit call; `close()`
 * releases. Never rejects: to a verb, a dark lane is a failed read with the
 * reason on it.
 *
 * `patient` is a customer's browser (lib/engine.mjs): nobody is at a terminal
 * to read "try again once they grant it", so what only the person at the
 * machine can lift is a HOLD, not a failed read — a permission wall (the lane
 * answers `grant`, the origin the extension may not read yet) and a Chrome
 * window that is not on screen (a covered or minimised window is drawn by
 * nobody, and gets no page). The ask is already on the operator's panel and
 * on the chat page; the read waits here until it is answered, then asks the
 * same thing again, in the tab it already has. Measured 2026-09-19 in the
 * owner's own Chrome: the read failed on the wall, the operator pressed
 * Allow, nothing began again for ten minutes while the chat said "being read
 * now" — and then three reads in a row stopped on a covered window.
 * `onHold({ kind: "allow", origin } | { kind: "window" })` says so in the
 * job's own words; `signal` is the job's cancel; after `holdMs` the answer is
 * handed back as it was.
 */
export function browser(base, { task = "the engine", stranger = false, project = null, grants = ["read"], patient = false, onHold = null, signal = null, holdMs = HOLD_MS, pollMs = HOLD_POLL_MS } = {}) {
  // `base` is the server that holds the lane (a URL) — or, in the process
  // that holds the broker itself (the extension's worker, 0.10.0), the lane
  // object from lib/control.mjs laneOf(broker): no HTTP between a verb and
  // the tab it reads.
  const direct = base !== null && typeof base === "object";
  const root = direct ? "" : String(base ?? "").replace(/\/$/, "");
  const lane = direct ? base : controlClient(root);
  let L = null;
  const need = () => (L ? null : { error: "no tab open — open(url) first" });
  // What a patient browser waits on, from what the lane answered.
  const waitOn = (out) => (out?.grant ? { kind: "allow", origin: out.grant } : isHidden(out?.error) ? { kind: "window" } : null);
  const hold = async (out, again) => {
    if (!patient) return out;
    const until = Date.now() + holdMs;
    let told = null, asked_ = 0;
    for (let w = waitOn(out); w && !signal?.aborted && Date.now() < until; w = waitOn(out)) {
      const tag = `${w.kind}|${w.origin ?? ""}`;
      if (told !== tag) { told = tag; try { onHold?.(w); } catch { /* a note that cannot be written is no reason to stop */ } }
      if (w.kind === "allow") {
        if (typeof lane.grants !== "function") break;
        await sleep(pollMs);
        // Still on the panel? Then keep waiting. The ask goes when the operator
        // presses Allow — or "not now", in which case the same call brings it back.
        let asked = false;
        try { asked = (await lane.grants()).some((o) => sameSite(o, w.origin)); } catch { asked = false; }
        if (asked) continue;
      } else {
        // Nothing to look up: the window is either drawn now or it is not, and
        // asking is what raises it (and flashes its taskbar button) — so a little
        // less often than the grant list, which costs nothing to read, and less
        // each time: four seconds, eight, twelve, then sixteen.
        await sleep(pollMs * 2 * Math.min(4, 1 + asked_++));
      }
      out = await again();
    }
    return out;
  };
  const call = async (tool, input = {}) => {
    const no = need();
    if (no) return no;
    const ask = () => lane.act(L, tool, input, grants);
    const out = await hold(await ask(), ask);
    if (out?.error === "incognito_not_allowed") return { error: NO_STRANGER };
    return out ?? { error: `${tool} answered nothing` };
  };
  return {
    stranger,
    get lease() { return L; },
    /** Lease a tab on the first page. {ok, tabId, url, title} or {error}. */
    async open(url) {
      if (L) return this.goto(url);
      if (!direct && !root) return { error: NO_SERVER };
      if (!(direct ? await lane.attached() : await attached(root))) return { error: NOT_ATTACHED };
      const r = await lane.lease(task, url, { stranger, project });
      if (r.error) return { error: r.error === "incognito_not_allowed" ? NO_STRANGER : r.error };
      L = r.id;
      return { ok: true, tabId: r.tabId, url: r.url ?? url, title: r.title ?? "" };
    },
    /** Turn a page in the leased tab. The lane paces it per site. */
    async goto(url) {
      const out = await call("navigate", { url });
      return out.error ? out : { ok: true, url: out.url ?? url, title: out.title ?? "", status: out.status ?? null };
    },
    /** Where the tab is now — the final URL after redirects, and the title. */
    async where() {
      const out = await call("tabs_context", {});
      const t = out?.tabs?.[0];
      return t && !t.gone ? { url: t.url, title: t.title, status: t.status } : { error: out?.error ?? "that tab is gone" };
    },
    /** Rows off the page by the platform's spec (lib/control.mjs read_dom). */
    async extract(spec) {
      const out = await call("read_dom", { spec });
      return out.error ? out : { ok: true, rows: Array.isArray(out.rows) ? out.rows : [], total: out.total ?? 0, url: out.url, title: out.title };
    },
    /** The page's readable text. */
    async text(max_chars = 30_000) {
      const out = await call("get_page_text", { max_chars });
      return out.error ? out : { ok: true, text: out.text ?? "", url: out.url, title: out.title, truncated: Boolean(out.truncated) };
    },
    /** Wheel down, a page at a time — for listings that grow as a person
     *  scrolls. */
    async scroll(ticks = 6) { return call("computer", { action: "scroll", scroll_direction: "down", scroll_amount: Math.max(1, Math.min(10, ticks)) }); },
    async close() {
      const id = L;
      L = null;
      if (!id) return { ok: true };
      try { return await lane.release(id); } catch { return { ok: true }; }
    },
  };
}

/** The server that holds the lane, for a child process: set by `mq serve`
 *  for everything it spawns, and by the dashboard for itself. */
export const serverBase = () => env("MQ_SERVER") || null;
