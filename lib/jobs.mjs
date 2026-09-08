// The job runner — the thing that was missing before the dashboard could do
// anything at all.
//
// Every verb that touches Reddit is long and rate-limited: `check` is about a
// minute per thread and `tick` a minute per source, because logged out Reddit
// answers one request a minute per address. None of that can live inside a
// request handler, so before this file the dashboard could only ever be a
// reader — which is exactly what it was.
//
// Three ways work goes through here:
//
//   start()  runs a VERB in this process (0.10.0) — the same function the CLI
//            runs, from lib/verbs.mjs, with this job's log for its lines. One
//            implementation of `probe` for the terminal, the dashboard and the
//            extension's worker; the one that drifts is the one somebody
//            trusts, so there is no second.
//   run()    runs any async function in this process — the model calls (the
//            judge, the writer, the scout) that have no verb to defer to.
//   spawn()  runs `node bin/mq.mjs <verb>` as a child process. What the
//            dashboard did before start() existed; kept for a Node host that
//            wants a verb in its own process, absent on a host without one.
//
// One job per verb at a time. A second `tick` started while the first is still
// reading is not a feature, it is two processes racing for the same
// append-only files and the same one-request-a-minute budget.

import { appendFileSync, existsSync, readFileSync, join, host, builtinDir, cwd } from "./fs.mjs";

/** The CLI, next to the built-in skills. Only a host with `spawn` (Node) can
 *  start it as a child; the memory host runs verbs in-process (run()). */
const ES = () => join(builtinDir(), "..", "bin", "mq.mjs");

/** How much of a job's output is kept in memory. A `check` over two hundred
 *  threads prints a lot, and the browser only ever renders the tail. */
const KEEP_LINES = 400;

let seq = 0;

const now = () => new Date().toISOString();
const id = () => `j${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * A job, as the browser sees it. Kept flat and JSON-safe because it is polled
 * roughly once a second and anything clever here becomes a serialisation bug.
 */
const shape = (j) => ({
  id: j.id,
  verb: j.verb,
  label: j.label,
  status: j.status,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
  error: j.error,
  note: j.note,
  done: j.done,
  total: j.total,
  lines: j.lines.slice(-KEEP_LINES),
});

export function jobStore(dir, { verbs: makeVerbs = null } = {}) {
  // This store's jobs. Per store rather than per module: a second project's
  // dashboard must not see — or be blocked by — the first one's tick.
  const jobs = new Map();
  const log = (j) => {
    try {
      appendFileSync(
        join(dir, "jobs.jsonl"),
        JSON.stringify({
          id: j.id, verb: j.verb, label: j.label, status: j.status,
          startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error,
        }) + "\n",
      );
    } catch {
      // A job that finished correctly must not be reported as failed because
      // its history line could not be written.
    }
  };

  const api = {
    /** Every job this process has seen, newest first. */
    list: () => [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(shape),

    get: (jobId) => (jobs.has(jobId) ? shape(jobs.get(jobId)) : null),

    /** The one the header strip shows. */
    running: () => [...jobs.values()].filter((j) => j.status === "running").map(shape),

    busy: (verb) => [...jobs.values()].some((j) => j.status === "running" && j.verb === verb),

    /** History across restarts. The in-memory list is this process only. */
    history: (limit = 50) => {
      const p = join(dir, "jobs.jsonl");
      if (!existsSync(p)) return [];
      return readFileSync(p, "utf8").split("\n").filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).reverse().slice(0, limit);
    },

    cancel(jobId) {
      const j = jobs.get(jobId);
      if (!j || j.status !== "running") return false;
      j.cancelled = true;
      j.ctrl?.abort();
      // SIGTERM rather than SIGKILL: the CLI's writes are single appendFileSync
      // calls, so there is no half-written line to worry about, but a child
      // given the chance to exit cleanly closes its file handles.
      try { j.child?.kill(); } catch { /* already gone */ }
      return true;
    },

    /**
     * Run a verb in THIS process (0.10.0): the same function the CLI runs
     * (lib/verbs.mjs), with the job's log for its lines and `stdin` for what
     * the CLI would have read. The way every host runs a verb now — the
     * extension's worker has no Node to spawn, and the dashboard stopped
     * spawning so that both run one code path. `verbs({ log })` comes from
     * the host that made this store: it binds root, project and browser.
     * Returns { id } at once, or { error } when the verb is already running.
     */
    start(verb, args = [], { label, stdin = "" } = {}) {
      if (!makeVerbs) return { error: "this job store has no verbs to run" };
      return api.run(verb, async (ctl) => {
        const V = makeVerbs({ log: ctl.log, warn: ctl.log });
        if (typeof V[verb] !== "function") throw new Error(`${verb} is not a verb`);
        return V[verb](args, stdin);
      }, { label: label ?? verb });
    },

    /**
     * Start a child `es` process. Returns the job id immediately — the caller
     * is an HTTP handler and must not wait a minute to answer. Node only.
     */
    spawn(verb, args = [], { label, stdin = null } = {}) {
      if (api.busy(verb)) return { error: `${verb} is already running` };
      if (!host().spawn) return { error: "no child processes on this host" };

      const j = {
        id: id(), verb, label: label ?? verb, status: "running",
        startedAt: now(), finishedAt: null, error: null,
        note: "starting", done: 0, total: 0, lines: [], cancelled: false,
      };
      jobs.set(j.id, j);

      const child = host().spawn(process.execPath, [ES(), verb, ...args], {
        cwd: cwd(),
        env: { ...process.env, MQ_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      j.child = child;

      if (stdin !== null) { child.stdin.write(stdin); }
      child.stdin.end();

      let buf = "";
      const onData = (chunk) => {
        buf += chunk;
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          j.lines.push(line);
          if (j.lines.length > KEEP_LINES * 2) j.lines = j.lines.slice(-KEEP_LINES);
          // The CLI's own progress lines are the progress bar. `check` prints
          // "[3/17] r/x — …" and `tick` prints one line per source; reading
          // them beats inventing a second progress protocol the CLI would have
          // to be taught to speak.
          const m = line.match(/\[(\d+)\s*\/\s*(\d+)\]/);
          if (m) { j.done = Number(m[1]); j.total = Number(m[2]); }
          const t = line.trim();
          if (t) j.note = t.slice(0, 120);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.on("error", (e) => {
        j.status = "error"; j.error = e.message; j.finishedAt = now(); log(j);
      });
      child.on("close", (code) => {
        if (j.status !== "running") return;   // already settled by 'error'
        if (buf.trim()) j.lines.push(buf);
        j.status = j.cancelled ? "cancelled" : code === 0 ? "ok" : "error";
        if (j.status === "error") j.error = `exited ${code}`;
        j.note = j.status === "ok" ? "done" : j.status;
        j.finishedAt = now();
        log(j);
      });

      return { id: j.id };
    },

    /**
     * Run an async function as a job. `fn` is handed the controls rather than
     * reaching for them, so a job cannot report progress for a different job.
     */
    run(verb, fn, { label } = {}) {
      if (api.busy(verb)) return { error: `${verb} is already running` };

      const j = {
        id: id(), verb, label: label ?? verb, status: "running",
        startedAt: now(), finishedAt: null, error: null,
        note: "starting", done: 0, total: 0, lines: [], cancelled: false,
        ctrl: new AbortController(),
      };
      jobs.set(j.id, j);

      const ctl = {
        signal: j.ctrl.signal,
        log: (line) => {
          for (const l of String(line ?? "").split("\n")) {
            j.lines.push(l);
            if (l.trim()) j.note = l.trim().slice(0, 120);
          }
          if (j.lines.length > KEEP_LINES * 2) j.lines = j.lines.slice(-KEEP_LINES);
        },
        progress: (done, total, note) => {
          j.done = done; j.total = total;
          if (note) j.note = String(note).slice(0, 120);
        },
      };

      Promise.resolve()
        .then(() => fn(ctl))
        .then((result) => {
          if (j.status !== "running") return;
          j.status = j.cancelled ? "cancelled" : "ok";
          // A job that returns a sentence ("3 drafts on the card", "the
          // writer declined: …") is saying how it went; that is the note
          // the panel's strip shows, where "done" would hide it.
          j.note = j.status !== "ok" ? j.status : typeof result === "string" && result.trim() ? result.trim().slice(0, 120) : "done";
          j.result = result ?? null;
        })
        .catch((e) => {
          if (j.status !== "running") return;
          j.status = "error";
          j.error = e?.message ?? String(e);
          ctl.log(`error: ${j.error}`);
        })
        .finally(() => {
          if (!j.finishedAt) { j.finishedAt = now(); log(j); }
        });

      return { id: j.id };
    },

    /** A finished in-process job's return value, for the pages that need it
     *  (the setup flow reads the scout's proposal back out of here). */
    result: (jobId) => jobs.get(jobId)?.result ?? null,
  };

  return api;
}
