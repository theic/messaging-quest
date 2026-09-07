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

import { controlClient } from "./control.mjs";

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

/**
 * A browser on one lease. `open(url)` leases the tab (the first page), later
 * `goto(url)` turns pages in it; every read is one toolkit call; `close()`
 * releases. Never rejects: to a verb, a dark lane is a failed read with the
 * reason on it.
 */
export function browser(base, { task = "the engine", stranger = false, project = null, grants = ["read"] } = {}) {
  const root = String(base ?? "").replace(/\/$/, "");
  const lane = controlClient(root);
  let L = null;
  const need = () => (L ? null : { error: "no tab open — open(url) first" });
  const call = async (tool, input = {}) => {
    const no = need();
    if (no) return no;
    const out = await lane.act(L, tool, input, grants);
    if (out?.error === "incognito_not_allowed") return { error: NO_STRANGER };
    return out ?? { error: `${tool} answered nothing` };
  };
  return {
    stranger,
    get lease() { return L; },
    /** Lease a tab on the first page. {ok, tabId, url, title} or {error}. */
    async open(url) {
      if (L) return this.goto(url);
      if (!root) return { error: NO_SERVER };
      if (!(await attached(root))) return { error: NOT_ATTACHED };
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
export const serverBase = () => process.env.MQ_SERVER || null;
