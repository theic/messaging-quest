// The Quest worker — this browser reads for the cloud (Stage 2 of the Quest
// plan, 2026-09-19).
//
// On Supabase, Quest lives in an Edge Function and owns every customer's
// files; it never opens a page, because the operator's rule is that pages are
// read in a real browser a person could watch ("real tabs, no background
// fetches"). So when it needs one — a customer's site, a community's rules, a
// community's posts — it writes a job, and this loop, in the operator's own
// signed-in extension, takes it: one at a time, done WHOLE here (lib/reads.mjs
// — a page and the posts it previewed, in one leased tab, at the lane's pace),
// and handed back as data. No round trip to the cloud per page.
//
// The doors are Supabase RPCs under the account's own session
// (extension/account.js): quest_claim, quest_note, quest_finish. Only an
// account listed in quest_workers may use them; anyone else is told "not a
// worker", and this loop stops asking. Reads are PATIENT, as a customer's
// were on the local server: a permission wall or a window nobody draws is a
// hold, said on the job (the operator sees it on the panel), not a failure.
//
// It runs only where the engine runs in this worker (hosted mode) — the tabs
// are the in-process broker's, the same lane every hosted read goes through.

import { browser } from "../lib/browse.mjs";
import { laneOf } from "../lib/control.mjs";
import { readSite, readText, readListing } from "../lib/reads.mjs";
import { SUPABASE_URL, SUPABASE_KEY } from "./account.js";

/** How often an idle worker asks whether there is a read to do. */
const IDLE_MS = 15_000;
/** How often a worker in the middle of a read says it still is — the queue
 *  gives a job back after ten minutes of silence. */
const PING_MS = 60_000;
/** After an error that is not the job's own: a minute, not a spin. */
const TROUBLE_MS = 60_000;

/** A read, cut to what the cloud records — so a page of long posts never
 *  hands back more than the store would keep. */
function trimmed(out) {
  if (!out || typeof out !== "object") return out;
  const r = { ...out };
  if (Array.isArray(r.entries)) r.entries = r.entries.slice(0, 200).map((e) => ({ ...e, body: String(e.body ?? "").slice(0, 4000) }));
  if (Array.isArray(r.pages)) r.pages = r.pages.slice(0, 6).map((p) => ({ url: p.url, title: String(p.title ?? "").slice(0, 300), text: String(p.text ?? "").slice(0, 20_000) }));
  if (typeof r.text === "string") r.text = r.text.slice(0, 30_000);
  return r;
}

/**
 * The loop. `account` is extension/account.js's (its token() signs the
 * calls); `engine()` resolves to the booted engine in this worker (its
 * CONTROL broker leases the tabs). Everything else is injectable for the
 * tests: `fetch`, the clock, `sleep`, and the reads themselves.
 */
export function questWorker({ account, engine, fetch: f = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), reads = { readSite, readText, readListing }, idleMs = IDLE_MS } = {}) {
  let running = null;
  let on = false;
  let state = { status: "off", job: null, note: null, error: null, done: 0, at: null };
  const set = (patch) => { state = { ...state, ...patch, at: new Date(now()).toISOString() }; };

  const rpc = async (fn, args = {}) => {
    const t = await account.token();
    if (!t) { const e = new Error("not signed in"); e.signedOut = true; throw e; }
    const res = await f(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message ?? text; } catch { /* the text is the message */ }
      const e = new Error(String(msg).slice(0, 300));
      e.status = res.status;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  };

  /** One read, whole, in one leased tab. */
  async function read(job, E) {
    const a = job.args ?? {};
    const b = browser(laneOf(E.CONTROL), {
      task: a.label ?? "reading for Quest",
      patient: true,
      onHold: (w) => {
        const note = w.kind === "window" ? "waiting for Chrome's window to be in view" : `waiting for you to allow ${w.origin} on the panel`;
        set({ note });
        rpc("quest_note", { p_job: job.id, p_note: note }).catch(() => {});
      },
    });
    try {
      if (job.kind === "site") return await reads.readSite(b, a.url, { pages: 4 });
      if (job.kind === "text") return await reads.readText(b, a.url, { max: 20_000 });
      if (job.kind === "listing") {
        return await reads.readListing(b, a.url, {
          skip: new Set(a.skip ?? []),
          skipAuthors: new Set((a.skipAuthors ?? []).map((x) => String(x).toLowerCase())),
          checkDescription: a.purpose !== "tick",
        });
      }
      return { ok: false, error: `not a read this browser knows: ${job.kind}` };
    } finally {
      await b.close();
    }
  }

  /** Ask for a read and do it. True when there was one. */
  async function once() {
    const E = await engine();
    const job = await rpc("quest_claim", { p_name: "Chrome" });
    if (!job?.id) { set({ status: "waiting", job: null, note: null, error: null }); return false; }
    set({ status: "reading", job: { id: job.id, kind: job.kind, label: job.args?.label ?? job.kind }, note: null, error: null });
    const ping = setInterval(() => { rpc("quest_note", { p_job: job.id, p_note: state.note }).catch(() => {}); }, PING_MS);
    try {
      const out = await read(job, E);
      await rpc("quest_finish", { p_job: job.id, p_result: trimmed(out), p_error: null });
      set({ done: state.done + 1 });
    } catch (e) {
      await rpc("quest_finish", { p_job: job.id, p_result: null, p_error: String(e?.message ?? e).slice(0, 400) }).catch(() => {});
      set({ error: String(e?.message ?? e).slice(0, 200) });
    } finally {
      clearInterval(ping);
      set({ status: "waiting", job: null, note: null });
    }
    return true;
  }

  async function loop() {
    while (on) {
      try {
        if (!(await once())) await sleep(idleMs);
      } catch (e) {
        // Not for this account, or nobody signed in: stop asking, and say why
        // on the panel. Anything else is weather — a minute, then again.
        if (e.signedOut) { on = false; set({ status: "signed out" }); break; }
        if (e.status === 403 || /not a worker/i.test(e.message)) { on = false; set({ status: "not a worker", error: null }); break; }
        set({ status: "trouble", error: String(e?.message ?? e).slice(0, 200) });
        await sleep(TROUBLE_MS);
      }
    }
    running = null;
  }

  return {
    /** Start asking — idempotent; a loop already going is left alone. */
    start() { if (!on) { on = true; set({ status: "starting" }); } running ??= loop(); return running; },
    stop() { on = false; set({ status: "off" }); },
    status: () => ({ ...state, on }),
    // for the tests
    once, trimmed,
  };
}
