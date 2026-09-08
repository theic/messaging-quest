// The control lane — the extension as a pair of hands, on tabs a task leased.
//
// From 0.6.0 this is the ONLY way anything here touches a platform: the
// background read lane (lib/relay.mjs, a fetch in the extension) is gone, and
// every read — a probe, a tick, a visibility check, a colleague's page — is a
// real tab in the operator's own Chrome, rendered, read in the isolated world
// (lib/browse.mjs is the engine's client). The protocol is a browser toolkit
// with the reach of Claude in Chrome — open a tab, navigate, read the
// accessibility tree, rows by a declared spec (read_dom), find, scroll,
// screenshot, and (behind a grant nobody holds) click and type — over a
// long-poll, so the heart stays zero-dependency: no WebSocket server, one
// HTTP server.
//
// Two seats, chosen at lease time: the operator's own session, and — for the
// visibility verbs, which measure what a logged-out STRANGER sees — an
// Incognito tab (`stranger: true`), which the extension can only open once
// the operator has allowed it there. A lease that cannot have its seat fails
// with the door named; nothing answers from the wrong one.
//
// The law of this lane:
//   * A LEASE is a tab (or a few) the extension opened in the operator's own
//     window, under a "Messaging Quest" tab group, for one task. The runtime
//     injects the tab from the lease; a caller never names a tab it does not
//     hold. Closing the task closes the tab.
//   * Every call is screened HERE, before the extension hears of it: the tool
//     must be in the toolkit, and its FAMILY (read / click / type) must be in
//     the caller's grants — the `tools:` line of the agent's definition. No
//     agent is granted click or type in milestone 1. The extension screens
//     clicks a second time, one layer down, against the labels the insert
//     screen already refuses (post, comment, reply, send, submit …).
//   * Reads pace themselves per SITE, inside the lane: navigations to one
//     host are spaced `paceMs` apart across every lease, because the CLI's
//     governor cannot see them. The number is a human-browsing guess and says
//     so — the anonymous 65s is Reddit's throttle on a logged-out RSS reader,
//     not a measurement of how fast a signed-in person may turn pages.
//   * Visibility checks (sync/check/back) never take this lane. Logged-out is
//     the measurement; a read in the operator's own session answers a
//     different question.
//   * Everything times out. A lease nobody uses is released; a job nobody
//     claims dies with its reason; a poll with nothing to say returns.
//
// Two halves in one file: the BROKER lives in the dashboard
// server, and the CLIENT is what a script (or a task manager in another
// process) calls over HTTP.

/* ---------------------------------------------------------------- toolkit */

/** The toolkit, by the names Claude in Chrome uses, so a model's habits
 *  transfer. Each name maps to the FAMILY it needs; `computer` depends on its
 *  action and `batch` on its items. Anything not here is not a tool. */
export const TOOLKIT = {
  tabs_context: "read",
  tabs_create: "read",
  tabs_close: "read",
  navigate: "read",
  computer: "by-action",
  read_page: "read",
  read_dom: "read",
  find: "read",
  form_input: "type",
  get_page_text: "read",
  read_console_messages: "read",
  read_network_requests: "read",
  batch: "by-items",
};

const READ_ACTIONS = new Set(["screenshot", "scroll", "scroll_to", "hover", "zoom", "wait"]);
const CLICK_ACTIONS = new Set(["left_click", "right_click", "double_click", "triple_click"]);
const TYPE_ACTIONS = new Set(["type", "key"]);

const FAMILIES = ["read", "click", "type"];

/** Which family one call needs, or null when the call is not a toolkit call. */
function familyOf(tool, input = {}) {
  const f = TOOLKIT[tool];
  if (!f) return null;
  if (f === "by-action") {
    const a = String(input?.action ?? "");
    if (READ_ACTIONS.has(a)) return "read";
    if (CLICK_ACTIONS.has(a)) return "click";
    if (TYPE_ACTIONS.has(a)) return "type";
    return null;
  }
  if (f === "by-items") return "batch";
  return f;
}

/** Every family a call needs — a batch needs the union of its items'. Null
 *  when any part of it is not a toolkit call (a batch inside a batch, an
 *  unknown action): the whole call is refused rather than partly run. */
export function familiesOf(tool, input = {}) {
  if (tool === "batch") {
    const items = Array.isArray(input?.actions) ? input.actions : null;
    if (!items || !items.length || items.length > 20) return null;
    const out = new Set();
    for (const it of items) {
      if (!it || it.name === "batch") return null;
      const f = familyOf(it.name, it.input ?? {});
      if (!f) return null;
      out.add(f);
    }
    return [...out];
  }
  const f = familyOf(tool, input);
  return f ? [f] : null;
}

/** The `tools:` line of an agent definition, parsed to families. Accepts the
 *  families themselves and the `browser.<family>` spelling; anything else on
 *  the line is somebody else's tool and is ignored here. */
export function grantsOf(toolsLine) {
  const out = new Set();
  for (const raw of String(toolsLine ?? "").split(/[,\s]+/)) {
    const t = raw.trim().toLowerCase().replace(/^browser[.:]/, "");
    if (FAMILIES.includes(t)) out.add(t);
  }
  return [...out];
}

/** The screen every call passes before the extension hears of it. */
export function permitted(tool, input = {}, grants = ["read"]) {
  const need = familiesOf(tool, input);
  if (!need) return { ok: false, why: `${tool}${input?.action ? ` ${input.action}` : ""} is not in the browser toolkit` };
  const have = new Set(grants);
  const missing = need.filter((f) => !have.has(f));
  if (missing.length)
    return { ok: false, why: `${tool}${input?.action ? ` ${input.action}` : ""} needs the "${missing.join('", "')}" grant, and this agent's tools line does not carry it. No agent may click or type unless its definition says so.` };
  return { ok: true };
}

/* ----------------------------------------------------------------- broker */

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return null; } };
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Held jobs, open leases, waiting browsers, and the promise each call is to
 * its caller. `paceMs` spaces navigations per host, site-wide; `leaseTtlMs`
 * releases a lease nobody has used for that long, so a crashed task does not
 * leave a tab open forever.
 */
export function controlBroker({ ttlMs = 60_000, cap = 32, paceMs = 6_000, leaseTtlMs = 30 * 60_000, silentMs = 90_000, freshMs = 30_000, panelMs = 60_000, onEvent = null } = {}) {
  const leases = new Map();  // id → { id, task, tabs, group, window, openedAt, lastAt, released, grant, calls }
  const jobs = new Map();    // id → { id, lease, tabId, tool, input, resolve, timer, claimed }
  const needed = new Map();  // origin → { at, task }: sites the extension may not read yet, until granted
  const lastNav = new Map(); // host → when the last navigation there was handed out
  let waiters = [];
  let seq = 0;
  let lastPoll = 0;
  // Every extension instance on the lane — one per Chrome profile the
  // extension is loaded in, named by the worker itself. Measured 2026-09-07:
  // loaded in two profiles, both workers polled, one probe's jobs went to
  // whichever answered first, and the tab one profile had opened was "that
  // tab is gone" to the other. So a tab is bound to the instance that opened
  // it, and a NEW tab opens in the owner: the instance whose panel the
  // operator has open (the panel says so with every deck poll), else the
  // first to arrive. A worker does not poll while it runs a job (a page
  // can take twenty seconds to load), so one with a claimed job unanswered
  // is busy, not silent. An instance silent past silentMs is off the lane
  // and its tabs out of reach; the OWNER role moves sooner — freshMs, about
  // one long-poll — so a reloaded or closed profile does not stall the next
  // tab until the job's own timeout (measured: a lease unanswered for 60 s
  // while the old owner aged out at 90).
  const pollers = new Map(); // instance → { first, lastPoll, panelAt }
  let owner = null;
  const ANON = "?";          // an extension that names no instance: one, as before
  const busy = (id) => [...jobs.values()].some((j) => j.claimed && j.instance === id);
  const alive = (id) => { const p = pollers.get(id); return Boolean(p) && (Date.now() - p.lastPoll < silentMs || busy(id)); };
  const fresh = (id) => { const p = pollers.get(id); return Boolean(p) && (Date.now() - p.lastPoll < freshMs || busy(id)); };
  const ownerNow = () => {
    for (const id of [...pollers.keys()]) if (!alive(id)) pollers.delete(id);
    if (owner !== null && !fresh(owner)) owner = null;
    if (owner === null) {
      let best = null;
      for (const [id, p] of pollers) {
        if (!fresh(id)) continue;
        const q = best === null ? null : pollers.get(best);
        if (!q || p.panelAt > q.panelAt || (p.panelAt === q.panelAt && p.first < q.first)) best = id;
      }
      owner = best;
    }
    return owner;
  };

  const emit = (type, detail) => { try { onEvent?.({ type, at: new Date().toISOString(), ...detail }); } catch { /* an observer must not break the lane */ } };

  const wake = () => {
    if (![...jobs.values()].some((j) => !j.claimed)) return;
    for (const w of waiters.splice(0)) w();
  };

  const queue = (lease, tool, input, tabId) =>
    new Promise((resolve) => {
      if (jobs.size >= cap) return resolve({ error: "control queue is full" });
      const id = `c${++seq}`;
      const timer = setTimeout(() => {
        jobs.delete(id);
        resolve({ error: `${tool} unanswered — no browser picked it up in time. Is the extension loaded, and is Chrome running?` });
      }, ttlMs);
      jobs.set(id, { id, lease: lease?.id ?? null, instance: lease?.instance ?? null, tabId: tabId ?? null, tool, input, resolve, timer, claimed: false });
      wake();
    });

  /** Per-site pacing. Reserves the next slot for this host and returns how
   *  long to wait for it — reserved at call time, so two concurrent
   *  navigations to one host land at least paceMs apart rather than
   *  together. The gap is uneven on purpose: paceMs plus up to 80% more,
   *  because a person's pauses between pages are not a metronome. */
  const reserve = (url) => {
    const h = hostOf(url);
    if (!h) return 0;
    const now = Date.now();
    const gap = paceMs + Math.floor(Math.random() * paceMs * 0.8);
    const at = Math.max(now, (lastNav.get(h) ?? 0) + gap);
    lastNav.set(h, at);
    return at - now;
  };

  const shape = (l) => ({
    id: l.id, task: l.task, tabs: [...l.tabs], group: l.group, window: l.window, stranger: Boolean(l.stranger), project: l.project ?? null,
    openedAt: l.openedAt, lastAt: new Date(l.lastAt).toISOString(), grant: l.grant, calls: l.calls, url: l.url,
  });

  const api = {
    /**
     * Open a tab for a task. Resolves with {id, tabId, groupId} or {error} —
     * never rejects, because to a task a lane that is dark is just a step
     * that failed, with the reason on it.
     */
    async lease({ task, url, stranger = false, project = null } = {}) {
      const u = String(url ?? "");
      if (!/^https?:\/\//i.test(u)) return { error: "a lease opens on an http(s) url" };
      const id = `L${++seq}`;
      const lease = { id, task: String(task ?? "").slice(0, 80), tabs: [], group: null, window: null, url: u,
        stranger: Boolean(stranger), project: project ? String(project) : null,
        openedAt: new Date().toISOString(), lastAt: Date.now(), released: false, grant: null, calls: 0, instance: null };
      leases.set(id, lease);
      await sleep(reserve(u));
      const ans = await queue(lease, "lease", { url: u, stranger: lease.stranger });
      if (ans?.error) { leases.delete(id); return { error: ans.error }; }
      lease.tabs.push(Number(ans.tabId));
      lease.group = ans.groupId ?? null;
      lease.window = ans.windowId ?? null;
      lease.lastAt = Date.now();
      emit("lease.opened", { lease: id, task: lease.task, tabId: lease.tabs[0], url: u, stranger: lease.stranger, project: lease.project });
      return { id, tabId: lease.tabs[0], groupId: lease.group, url: ans.url ?? u, title: ans.title ?? "" };
    },

    /**
     * One toolkit call on a lease. Screened against the grants first; the tab
     * is the lease's, never the caller's; navigations wait for their host's
     * slot. Resolves with the extension's answer, or {error} (with
     * `refused: true` when it was the screen that said no).
     */
    async act(leaseId, tool, input = {}, { grants = ["read"] } = {}) {
      const lease = leases.get(String(leaseId ?? ""));
      if (!lease || lease.released) return { error: "no such lease — it was released, timed out, or never opened", refused: true };
      if (lease.instance !== null && !alive(lease.instance)) return { error: "the Chrome profile that opened this tab is not on the lane any more — the tab is out of reach from here; release it and open another" };
      const p = permitted(tool, input ?? {}, grants);
      if (!p.ok) { emit("call.refused", { lease: lease.id, project: lease.project, tool, why: p.why }); return { error: p.why, refused: true }; }

      let tabId = lease.tabs[0];
      if (input?.tabId !== undefined && input?.tabId !== null) {
        if (!lease.tabs.includes(Number(input.tabId))) return { error: "that tab is not on this lease", refused: true };
        tabId = Number(input.tabId);
      }
      if (tool === "tabs_create" && !/^https?:\/\//i.test(String(input?.url ?? ""))) return { error: "tabs_create needs an http(s) url", refused: true };

      // Pacing: every navigation in the call, in order, waits for its host.
      const navs = tool === "batch"
        ? input.actions.filter((a) => (a.name === "navigate" || a.name === "tabs_create") && /^https?:\/\//i.test(String(a.input?.url ?? ""))).map((a) => a.input.url)
        : (tool === "navigate" || tool === "tabs_create") && /^https?:\/\//i.test(String(input?.url ?? "")) ? [input.url] : [];
      for (const u of navs) await sleep(reserve(u));

      lease.lastAt = Date.now();
      lease.calls++;
      const ans = await queue(lease, tool, { ...input, tabId }, tabId);
      lease.lastAt = Date.now();
      if (ans?.error === "not_granted") {
        lease.grant = String(ans.origin ?? "");
        // The ask outlives the lease: a script that hit the wall and released
        // still leaves the button on the panel, so the operator sees it.
        needed.set(lease.grant, { at: Date.now(), task: lease.task });
        emit("grant.needed", { lease: lease.id, project: lease.project, origin: lease.grant });
        return { error: `the extension has no permission for ${lease.grant} yet — the operator is being asked on the panel; try again once they grant it`, grant: lease.grant };
      }
      if (tool === "tabs_create" && ans?.tabId !== undefined) lease.tabs.push(Number(ans.tabId));
      if (tool === "tabs_close" && !ans?.error) lease.tabs = lease.tabs.filter((t) => t !== tabId);
      if (ans?.refused) emit("click.refused", { lease: lease.id, project: lease.project, why: ans.error });
      return ans;
    },

    /** Ask the extension to reload itself — the same thing as the reload
     *  button on chrome://extensions, for after a pull. The answer comes back
     *  before the worker restarts; the lane is dark for a second after. */
    reload: () => queue(null, "reload", {}, null),

    /** Close the lease's tabs. Idempotent; a lease already gone is fine. */
    async release(leaseId) {
      const lease = leases.get(String(leaseId ?? ""));
      if (!lease) return { ok: true, gone: true };
      if (lease.released) return { ok: true };
      lease.released = true;
      leases.delete(lease.id);
      emit("lease.released", { lease: lease.id, task: lease.task, project: lease.project });
      if (!lease.tabs.length) return { ok: true };
      if (lease.instance !== null && !alive(lease.instance)) return { ok: true, unreachable: true };   // its profile is gone; nobody can close what it opened
      const ans = await queue(lease, "release", { tabIds: [...lease.tabs] });
      return ans?.error ? { ok: false, error: ans.error } : { ok: true };
    },

    /** What the browser should do right now — the extension long-polls it,
     *  naming its instance. A job on a tab goes only to the instance that
     *  opened the tab; a job that opens one goes to the owner. */
    async claim(waitMs = 0, instance = null) {
      const id = instance === null || instance === undefined || String(instance) === "" ? ANON : String(instance).slice(0, 80);
      const seen = () => {
        const now = Date.now();
        const p = pollers.get(id);
        if (p) p.lastPoll = now; else pollers.set(id, { first: now, lastPoll: now, panelAt: 0 });
        lastPoll = now;
      };
      seen();
      const take = () => {
        const mine = ownerNow() === id;
        const out = [];
        for (const j of jobs.values()) {
          if (j.claimed) continue;
          const l = j.lease === null ? null : leases.get(j.lease) ?? null;
          const bound = j.instance ?? l?.instance ?? null;
          if (bound !== null ? bound !== id : !mine) continue;
          if (l && l.instance === null) l.instance = id;   // the first job on a lease binds it to the profile that opens its tab
          j.instance = id;
          j.claimed = true;
          out.push({ id: j.id, lease: j.lease, tabId: j.tabId, tool: j.tool, input: j.input });
        }
        return out;
      };
      const until = Date.now() + Math.max(0, waitMs);
      for (;;) {
        const out = take();
        const left = until - Date.now();
        if (out.length || left <= 0) return out;
        await new Promise((resolve) => {
          const t = setTimeout(resolve, left);
          waiters.push(() => { clearTimeout(t); resolve(); });
        });
        seen();
      }
    },

    /** The browser's answer. Unknown ids are late, not wrong. */
    answer(id, result = {}) {
      const j = jobs.get(String(id ?? ""));
      if (!j) return false;
      clearTimeout(j.timer);
      jobs.delete(String(id));
      const r = result && typeof result === "object" ? result : { error: "the browser answered gibberish" };
      // A screenshot is the one big field; everything else is text a model
      // reads, capped so one page cannot flood the run's context.
      if (typeof r.text === "string") r.text = r.text.slice(0, 400_000);
      if (typeof r.tree === "string") r.tree = r.tree.slice(0, 400_000);
      j.resolve(r);
      return true;
    },

    /** A lease from before a restart: the task record remembers the tab that
     *  is still open in Chrome; the broker did not. Register it so calls can
     *  drive it again. A tab that turns out to be gone is answered as such by
     *  the extension, and the caller opens another. */
    adopt({ id, task, tabs, url, project = null } = {}) {
      const key = String(id ?? "");
      if (!key || leases.has(key)) return leases.get(key) ? shape(leases.get(key)) : null;
      const lease = { id: key, task: String(task ?? "").slice(0, 80), tabs: (tabs ?? []).map(Number).filter(Number.isFinite), group: null, window: null, url: String(url ?? ""), project: project ? String(project) : null,
        openedAt: new Date().toISOString(), lastAt: Date.now(), released: false, grant: null, calls: 0, instance: null, adopted: true };
      leases.set(key, lease);
      return shape(lease);
    },

    /** Idle leases die here — a task that crashed must not keep a tab. */
    sweep() {
      const cutoff = Date.now() - leaseTtlMs;
      for (const l of [...leases.values()]) if (l.lastAt < cutoff) api.release(l.id);
      for (const [o, n] of [...needed]) if (n.at < cutoff) needed.delete(o);
    },

    /** The operator said "not now": the standing ask goes; a lease still
     *  blocked on it keeps its own, so the card returns if a task is truly
     *  waiting there. */
    dismiss(origin) {
      const o = String(origin ?? "").replace(/\/\*?$/, "");
      for (const k of [...needed.keys()]) if (k.replace(/\/\*?$/, "") === o) needed.delete(k);
    },

    /** An origin the operator granted: the lease may try again. */
    granted(origin) {
      const o = String(origin ?? "").replace(/\/\*?$/, "");
      for (const l of leases.values()) if (l.grant && l.grant.replace(/\/\*?$/, "") === o) l.grant = null;
      for (const k of [...needed.keys()]) if (k.replace(/\/\*?$/, "") === o) needed.delete(k);
    },

    leases: () => [...leases.values()].map(shape),
    lease_: (id) => { const l = leases.get(String(id ?? "")); return l ? shape(l) : null; },
    grantsNeeded: () => [...new Set([...needed.keys(), ...[...leases.values()].map((l) => l.grant).filter(Boolean)])],
    /** The panel of one instance is open — that profile is where the
     *  operator looks, so new tabs open there, unless another instance's
     *  panel was seen within panelMs (two panels open: the first keeps it).
     *  A panel whose worker is not on the lane cannot take it. */
    panelSeen(instance) {
      const id = String(instance ?? "").slice(0, 80);
      const p = id ? pollers.get(id) : null;
      if (!p) return false;
      p.panelAt = Date.now();
      const o = ownerNow();
      if (o === id) return true;
      const q = o === null ? null : pollers.get(o);
      if (!q || Date.now() - q.panelAt > panelMs) owner = id;
      return owner === id;
    },
    /** How many extension instances — Chrome profiles — are on the lane now. */
    instances: () => { ownerNow(); return [...pollers.keys()].filter(fresh).length; },
    owner: () => ownerNow(),
    /** Any extension on the lane — polling, or out running a job. */
    attached: () => [...pollers.keys()].some(alive),
    pending: () => jobs.size,
  };
  return api;
}

/* ----------------------------------------------------------------- client */

/** The HTTP side, for a script or a process that is not the server: the same
 *  three verbs over /api/control/*. Each holds its request open as long as the
 *  broker might, plus slack — a page genuinely takes seconds to read. */
export function controlClient(base) {
  const root = String(base ?? "").replace(/\/$/, "");
  const post = async (path, body, timeoutMs = 90_000) => {
    try {
      const res = await fetch(`${root}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const out = await res.json();
      return out && typeof out === "object" ? out : { error: "the control lane spoke gibberish" };
    } catch (e) {
      return { error: `control lane unreachable: ${e.name === "TimeoutError" ? "timeout" : e.message}` };
    }
  };
  return {
    lease: (task, url, extra = {}) => post("/api/control/lease", { task, url, ...extra }),
    act: (lease, tool, input, grants) => post("/api/control/act", { lease, tool, input, grants }),
    release: (lease) => post("/api/control/release", { lease }),
  };
}

/**
 * The same three calls on a broker in THIS process — what lib/browse.mjs
 * takes instead of a server address when the verb and the broker share a
 * process (the extension's worker, 0.10.0). `attached` is the fourth: is a
 * worker polling — there, the worker's own claim loop.
 */
export function laneOf(broker) {
  return {
    attached: async () => broker.attached(),
    lease: (task, url, extra = {}) => broker.lease({ task, url, ...extra }),
    act: (lease, tool, input, grants) => broker.act(lease, tool, input, { grants }),
    release: (lease) => broker.release(lease),
  };
}
