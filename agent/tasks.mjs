// The task manager — workers on their own threads (PLAN.md, 2026-09-03).
//
// Deep Agents' `task` tool runs a subagent INSIDE the caller's turn: the CMO
// would wait for the slowest scout, and one worker's pause would freeze the
// chat. So background work is a thread, not a tool call: each task is a
// second Deep Agent on its own LangGraph thread, started here, reporting by
// events into the inbox. This is the shape Claude Code uses for its own
// background agents, and it is what lets the CMO decide whether to react.
//
// What a task has:
//   a colleague     skills/<id>/agent.md — the definition (lib/skills.mjs
//                   reads it; this file is the door that runs it)
//   a thread        on the SQLite checkpointer (agent/threads.mjs), so a kill
//                   mid-run resumes from the last checkpoint on restart
//   a lease         a tab in the operator's own Chrome, through the control
//                   lane (lib/control.mjs); closing the task closes the tab
//   the question list  ask_person — one or many questions, handed to the deck
//                   as cards, answered together. Backed by interrupt(): the
//                   thread pauses, persisted; the answers resume it. Several
//                   blocked workers are several paused threads; one card shows
//                   at a time, oldest first.
//   a deadline      running time, not waiting time — a worker paused on a
//                   question is not late
//   cancel          aborts the run, releases the tab, says so in the inbox
//
// Interrupts live ONLY here, in workers. The CMO's thread is never left
// waiting on one (LangGraph drops a pending interrupt when a thread is
// invoked with fresh input) — its approvals are cards, its questions are
// dealt and answered through the inbox.
//
// Every browser call is screened against the colleague's `tools:` line
// (grants: read / click / type — none holds click or type in milestone 1) in
// the broker, and against the label screen in the extension. Every engine
// action goes through the CLI's verbs (agent/verbs.mjs).

import "../lib/node.mjs";   // the Node host for lib/fs.mjs — first, before anything in lib/
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDeepAgent } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { Command, interrupt } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { seat, hasModel } from "../lib/models.mjs";
import { activeSeat, agentDefinition } from "../lib/skills.mjs";
import { grantsOf, TOOLKIT } from "../lib/control.mjs";
import { threadSaver } from "./threads.mjs";
import { engineTools, VERBS } from "./verbs.mjs";

const now = () => new Date().toISOString();
const short = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const KEEP_LOG = 400;
const KEEP_FINISHED = 60;

/* ------------------------------------------------------------ the question */

/** The one input primitive. A question is a card's worth of asking: worked
 *  choices first, a field only when the answer cannot be on a list. */
export const QUESTION = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/).describe("A short key; the answer comes back under it"),
  question: z.string().min(1).max(200).describe("The one thing being asked, as a sentence"),
  help: z.string().max(600).optional().describe("A line or two under it — what you see, why it matters"),
  choices: z.array(z.object({
    id: z.string().regex(/^[\w-]{1,40}$/),
    label: z.string().min(1).max(80),
    note: z.string().max(160).optional(),
  })).max(8).optional().describe("Worked answers to press. Prefer these to a field."),
  multi: z.boolean().optional().describe("Several choices at once"),
  field: z.object({
    placeholder: z.string().max(80).optional(),
    multiline: z.boolean().optional(),
  }).optional().describe("Free text, only when the answer might not be on the list"),
  primary: z.string().max(30).optional().describe("The button's label; default Next"),
  optional: z.boolean().optional().describe("May be skipped; the answer is then null"),
});

export const QUESTIONS = z.object({ questions: z.array(QUESTION).min(1).max(12) });

export function normalizeQuestions(list) {
  const seen = new Set();
  const out = [];
  for (const q of Array.isArray(list) ? list : []) {
    const parsed = QUESTION.safeParse(q);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
    if (out.length >= 12) break;
  }
  return out;
}

/** The same tool in every worker and in the CMO: the schema is shared, the
 *  backing differs. Here it is interrupt(): the thread pauses, persisted, and
 *  the answers resume it — the tool then returns them to the model. */
const askPersonTool = () => tool(async ({ questions }) => {
  const answers = interrupt({ questions: normalizeQuestions(questions) });
  return JSON.stringify(answers ?? {});
}, {
  name: "ask_person",
  description: "Ask the operator one or more questions. They are dealt one card at a time on their panel and the answers come back together, keyed by question id (a choice id, a list of choice ids, free text, or null when skipped). Use it for a choice, a permission, a captcha or wall in your tab, a fact only they know. Offer worked choices; a field only when the answer cannot be on a list. You wait; you never guess an answer.",
  schema: QUESTIONS,
});

/* ------------------------------------------------------------- the toolkit */

const TAB = z.number().int().optional().describe("One of your tabs; default the one you were given");
const BROWSER_SCHEMAS = {
  tabs_context: z.object({}),
  tabs_create: z.object({ url: z.string().url() }),
  tabs_close: z.object({ tabId: TAB }),
  navigate: z.object({ url: z.string().describe("An http(s) url, or 'back' / 'forward'"), tabId: TAB }),
  computer: z.object({
    action: z.enum(["screenshot", "scroll", "scroll_to", "hover", "zoom", "wait", "left_click", "right_click", "double_click", "triple_click", "type", "key"]),
    coordinate: z.array(z.number()).length(2).optional(),
    ref: z.string().optional(),
    text: z.string().optional(),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().int().min(1).max(10).optional(),
    duration: z.number().min(0).max(10).optional(),
    region: z.array(z.number()).length(4).optional(),
    repeat: z.number().int().min(1).max(100).optional(),
    modifiers: z.string().optional(),
    tabId: TAB,
  }),
  read_page: z.object({
    filter: z.enum(["all", "interactive"]).optional(),
    depth: z.number().int().min(1).max(40).optional(),
    max_chars: z.number().int().min(500).max(200_000).optional(),
    ref_id: z.string().optional().describe("Read only this node and its children"),
    tabId: TAB,
  }),
  read_dom: z.object({
    spec: z.object({
      items: z.string().min(1).describe("A CSS selector for the rows, run through shadow roots"),
      limit: z.number().int().min(1).max(500).optional(),
      fields: z.record(z.string()).describe("name → attr:<name> | attr:<name>@<selector> | text:<selector> | href:<selector> | text | href | tag"),
    }),
    tabId: TAB,
  }),
  find: z.object({ query: z.string().min(1), tabId: TAB }),
  form_input: z.object({ ref: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), tabId: TAB }),
  get_page_text: z.object({ max_chars: z.number().int().min(500).max(200_000).optional(), tabId: TAB }),
  read_console_messages: z.object({ limit: z.number().int().optional(), onlyErrors: z.boolean().optional(), pattern: z.string().optional(), tabId: TAB }),
  read_network_requests: z.object({ limit: z.number().int().optional(), urlPattern: z.string().optional(), tabId: TAB }),
  batch: z.object({ actions: z.array(z.object({ name: z.string(), input: z.record(z.any()).optional() })).min(1).max(20) }),
};

const BROWSER_DESCRIPTIONS = {
  tabs_context: "Your tab(s): id, url, title, load status.",
  tabs_create: "Open one more tab, in your own group, at an http(s) url. Paced per site.",
  tabs_close: "Close one of your tabs.",
  navigate: "Go to an http(s) url in your tab, or back / forward. Waits for the page to load and looks at it for a moment, like a person. Navigations to one site are spaced out by the lane; a wait of some seconds is normal.",
  computer: "screenshot (saved for the operator's card; you get its size), scroll (scroll_direction + scroll_amount in wheel ticks, at the pointer or a coordinate), scroll_to (ref — the wheel brings it into view; inView says whether it got there), hover, zoom (region), wait (duration ≤ 10s). left_click / right_click / double_click / type / key exist and need the click or type grant, which your definition may not carry — a refusal says so.",
  read_page: "The page as an accessibility tree. Interactive nodes carry [ref_N] for find/scroll_to. filter 'interactive' for controls only; ref_id to focus on one part.",
  read_dom: "Rows off the page by a spec: items (a selector) and fields (attr:<name>, text:<selector>, href:<selector>, text, href, tag). The way the engine reads a platform; your SKILL.md names the elements that carry a post or a comment.",
  find: "Elements whose role, name, text or href contains the query (case-insensitive). Up to 20, with refs; a link carries its href.",
  form_input: "Set a form control's value by ref (needs the type grant).",
  get_page_text: "The page's readable text, through shadow roots, article or main first.",
  read_console_messages: "What the page logged to its console.",
  read_network_requests: "The page's resource requests, from its performance timeline.",
  batch: "Run several of these in one round trip: [{name, input}]. Stops at the first error.",
};

/* ------------------------------------------------------------- the manager */

const WORKER_RULES = `House rules for a colleague working in the operator's own browser:
- You READ. You never click, type into, or submit anything on a page — the tab is their signed-in session and every page is theirs. If a page needs a click to go on, call ask_person and say what you see.
- When you need a person — a choice, a permission, a wall or captcha in your tab, a fact only they know — call ask_person. One question per matter, worked choices first, a field only when the answer cannot be on a list. You wait for the answers; you never guess them.
- Navigations to one site are paced by the lane. A short wait between pages is normal, not an error.
- Numbers come from what you read. Quote counts; never round or estimate.
- Finish with a plain report — what you found, in sentences, no headings — then stop. Nothing posts; there is no code path for that anywhere.`;

/**
 * @param dir       the data directory (.mq)
 * @param control   the control-lane broker (lib/control.mjs) — tabs
 * @param modelFor  optional (def, task) => chat model; the seats by default
 * @param deadlineMs running-time budget per task (default 30 min)
 * @param onEvent   optional observer of every inbox event
 */
export function taskManager(dir, { control, modelFor = null, deadlineMs = 30 * 60_000, onEvent = null } = {}) {
  if (!control) throw new Error("the task manager needs the control lane's broker");
  const file = join(dir, "tasks.json");
  const shots = join(dir, "tasks");
  mkdirSync(shots, { recursive: true });

  let state = { tasks: [] };
  try { if (existsSync(file)) state = JSON.parse(readFileSync(file, "utf8")); } catch { state = { tasks: [] }; }
  if (!Array.isArray(state.tasks)) state.tasks = [];

  const running = new Map();   // id → { ctrl, timer }
  let seq = 0;
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    // Finished tasks are kept for the screens that show them, then let go —
    // the log of a task from last month is not a thing anybody re-reads.
    const finished = state.tasks.filter((t) => /^(done|failed|cancelled)$/.test(t.status));
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((t) => t.id));
      state.tasks = state.tasks.filter((t) => !drop.has(t.id));
    }
    writeFileSync(file, JSON.stringify(state, null, 2));
  };
  const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(save, 150); };

  const inbox = (type, detail = {}) => {
    const ev = { at: now(), type, ...detail };
    try { appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(ev) + "\n"); } catch { /* an event that could not be written must not fail the task */ }
    try { onEvent?.(ev); } catch { /* observers do not break the runtime */ }
    return ev;
  };

  const byId = (id) => state.tasks.find((t) => t.id === String(id ?? ""));
  const colleagues = () => activeSeat("agent.md").map(agentDefinition).filter(Boolean)
    .map((d) => ({ ...d, grants: grantsOf(d.tools.join(",")) }));
  const colleague = (id) => colleagues().find((c) => c.id === id) ?? null;

  const logLine = (task, line) => {
    for (const l of String(line ?? "").split("\n")) {
      task.log.push(`${now().slice(11, 19)} ${l}`);
    }
    if (task.log.length > KEEP_LOG * 2) task.log = task.log.slice(-KEEP_LOG);
    task.updatedAt = now();
    saveSoon();
  };

  const logMessage = (task, m) => {
    const type = typeof m?.getType === "function" ? m.getType() : (m?._getType?.() ?? m?.type ?? "");
    if (type === "ai") {
      for (const c of m.tool_calls ?? []) logLine(task, `→ ${c.name}(${short(JSON.stringify(c.args ?? {}), 140)})`);
      const text = contentText(m.content);
      if (text) logLine(task, `said: ${short(text, 240)}`);
    } else if (type === "tool") {
      logLine(task, `← ${m.name ?? "tool"}: ${short(contentText(m.content), 160)}`);
    }
  };

  const shotPath = (task) => join(shots, `${task.id}.png`);
  const saveShot = (task, dataUrl) => {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl ?? ""));
    if (!m) return false;
    try { writeFileSync(shotPath(task), Buffer.from(m[1], "base64")); task.shotAt = now(); saveSoon(); return true; } catch { return false; }
  };

  /* --------------------------------------------------------------- leases */

  const openLease = async (task, url) => {
    if (task.lease?.id) return task.lease;
    const r = await control.lease({ task: task.title, url, project: dir });
    if (r.error) return { error: r.error };
    task.lease = { id: r.id, tabId: r.tabId, url };
    logLine(task, `opened a tab (${r.tabId}) at ${url}`);
    inbox("task.tab", { task: task.id, title: task.title, tabId: r.tabId, url });
    return task.lease;
  };
  const releaseLease = async (task) => {
    const l = task.lease;
    if (!l?.id) return;
    task.lease = null;
    saveSoon();
    try { await control.release(l.id); } catch { /* the tab is gone either way */ }
    logLine(task, "closed its tab");
  };
  /** After a restart the broker has forgotten every lease; the task record
   *  has not. Adopt the tab that is still open in Chrome. */
  const readopt = (task) => {
    if (task.lease?.id && task.lease.tabId !== undefined && typeof control.adopt === "function")
      control.adopt({ id: task.lease.id, task: task.title, tabs: [task.lease.tabId], url: task.lease.url, project: dir });
  };

  /* ---------------------------------------------------------------- tools */

  const browserTools = (task, def) => {
    const grants = def.grants;
    const act = async (name, input = {}) => {
      const url = (name === "navigate" || name === "tabs_create") && /^https?:\/\//i.test(String(input.url ?? "")) ? input.url : null;
      if (!task.lease?.id) {
        const open = url ?? task.input?.url;
        if (!open || !/^https?:\/\//i.test(String(open))) return "no tab yet — navigate to an http(s) url first";
        const l = await openLease(task, open);
        if (l.error) return `could not open a tab: ${l.error}`;
        if (name === "navigate" && url === open) return JSON.stringify({ url: open, tabId: l.tabId, opened: true });
      }
      let out = await control.act(task.lease.id, name, input, { grants });
      if (out?.error && /tab is gone|no such lease/.test(out.error)) {
        // The operator closed the tab, or the server restarted and the lease
        // could not be re-adopted. Open a fresh one where the task started.
        logLine(task, `its tab was gone (${out.error}); opening another`);
        task.lease = null;
        const l = await openLease(task, url ?? task.input?.url ?? task.lease?.url);
        if (l.error) return `could not open a tab: ${l.error}`;
        out = await control.act(task.lease.id, name, input, { grants });
      }
      if (name === "computer" && input.action === "screenshot" && out?.screenshot) {
        const kept = saveShot(task, out.screenshot);
        out = { ok: true, width: out.width, height: out.height, viewport: out.viewport, note: kept ? "saved; it shows on the operator's card when you ask them something" : "could not be saved" };
      }
      logLine(task, `${name}${input.action ? ` ${input.action}` : ""}${url ? ` ${url}` : ""}${input.query ? ` "${input.query}"` : ""} → ${out?.error ? out.error : "ok"}`);
      return JSON.stringify(out ?? {}).slice(0, 80_000);
    };
    return Object.keys(TOOLKIT).map((name) =>
      tool(async (input) => act(name, input ?? {}), {
        name,
        description: BROWSER_DESCRIPTIONS[name],
        schema: BROWSER_SCHEMAS[name],
      }));
  };

  const defaultModel = (def) => {
    const s = seat(dir, def.model);
    return new ChatOpenAI({ model: s.model, apiKey: s.key || "none", configuration: { baseURL: s.baseUrl }, maxTokens: s.maxTokens, timeout: s.timeoutMs });
  };

  const brief = (task) => [
    `Task: ${task.title}`,
    task.input && Object.keys(task.input).length ? `Input: ${JSON.stringify(task.input)}` : "",
    task.input?.campaign ? `Campaign: ${task.input.campaign} — pass it as \`campaign\` to record_findings, so the judge and the writer apply its direction.` : "",
    task.lease?.tabId ? `Your tab is open at ${task.lease.url}. Read it with read_page or get_page_text.` : "",
  ].filter(Boolean).join("\n");

  const build = async (task, def) => {
    const names = new Set(def.tools);
    const tools = [];
    if (names.has("ask_person")) tools.push(askPersonTool());
    if (def.grants.length) tools.push(...browserTools(task, def));
    tools.push(...engineTools(dir, [...names].filter((n) => VERBS[n])));
    // The colleague's own SKILL.md teaches it — inlined, not mounted: a
    // worker has one skill, the file is small, and a listing that points at
    // a path the agent's file tools cannot reach costs it steps for nothing
    // (measured on the first live run: two wasted calls before the work).
    const skillPath = join(def.skillDir, "SKILL.md");
    const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim().slice(0, 12_000) : "";
    return createDeepAgent({
      model: modelFor ? await modelFor(def, task) : defaultModel(def),
      tools,
      systemPrompt: [def.prompt, skill ? `What you know about ${def.id} (skills/${def.id}/SKILL.md):\n\n${skill}` : "", WORKER_RULES, brief(task)].filter(Boolean).join("\n\n"),
      checkpointer: threadSaver(dir),
      name: def.name,
    });
  };

  /* ---------------------------------------------------------------- runs */

  const armDeadline = (task, ctrl) => {
    task.deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
    const t = setTimeout(() => api.cancel(task.id, `the ${Math.round(deadlineMs / 60_000)}-minute running budget was spent`), deadlineMs);
    t.unref?.();
    return t;
  };

  const settle = async (task, status, detail = {}) => {
    task.status = status;
    task.finishedAt = now();
    task.questions = null;
    await releaseLease(task);
    save();
    inbox(`task.${status}`, { task: task.id, title: task.title, agent: task.agent, ...detail });
  };

  async function run(task, input) {
    const def = colleague(task.agent);
    if (!def) { task.error = `the colleague "${task.agent}" is not installed any more`; return settle(task, "failed", { error: task.error }); }
    const ctrl = new AbortController();
    const handle = { ctrl, timer: null };
    running.set(task.id, handle);
    task.status = "running";
    task.questions = null;
    save();
    let agent;
    try { agent = await build(task, def); }
    catch (e) { running.delete(task.id); task.error = String(e.message ?? e).split("\n")[0]; return settle(task, "failed", { error: task.error }); }
    handle.timer = armDeadline(task, ctrl);
    const config = { configurable: { thread_id: task.thread }, recursionLimit: 120, signal: ctrl.signal };
    let interrupts = null;
    try {
      const stream = await agent.stream(input, { ...config, streamMode: "updates" });
      for await (const chunk of stream) {
        if (chunk && chunk.__interrupt__) { interrupts = chunk.__interrupt__; continue; }
        for (const update of Object.values(chunk ?? {})) for (const m of update?.messages ?? []) logMessage(task, m);
      }
      if (task.status !== "running") return;   // cancelled underneath us
      if (interrupts?.length) {
        const payload = interrupts[0]?.value ?? {};
        task.status = "blocked";
        task.questions = normalizeQuestions(payload.questions);
        task.answers = {};
        task.askedAt = now();
        if (!task.questions.length) {
          // A pause with no questions cannot be answered — treat it as one
          // question rather than leaving a thread that can never resume.
          task.questions = [{ id: "go_on", question: `${task.title} paused and asked nothing in particular.`, choices: [{ id: "yes", label: "Carry on" }, { id: "stop", label: "Stop it" }] }];
        }
        save();
        inbox("task.blocked", { task: task.id, title: task.title, agent: task.agent, questions: task.questions.map((q) => q.question) });
        logLine(task, `asked: ${task.questions.map((q) => q.question).join(" · ")}`);
        snapshot(task, def).catch(() => {});
      } else {
        const st = await agent.getState(config);
        task.result = lastAiText(st?.values?.messages) || "(finished without a report)";
        await settle(task, "done", { result: short(task.result, 600) });
      }
    } catch (e) {
      if (task.status !== "running") return;   // cancel() already settled it
      const msg = String(e?.message ?? e).split("\n")[0];
      task.error = /recursion limit/i.test(msg)
        ? "it ran out of steps — 120 tool calls without finishing. A colleague that loops is a colleague to rewrite; its log says where it circled."
        : msg;
      logLine(task, `failed: ${task.error}`);
      await settle(task, "failed", { error: task.error });
    } finally {
      clearTimeout(handle.timer);
      running.delete(task.id);
      save();
    }
  }

  /** When a worker stops for a person, the card should carry what it sees. */
  async function snapshot(task, def) {
    if (!task.lease?.id || !def.grants.includes("read")) return;
    const out = await control.act(task.lease.id, "computer", { action: "screenshot" }, { grants: def.grants });
    if (out?.screenshot) saveShot(task, out.screenshot);
  }

  /** Continue a task after a restart: from its last checkpoint, or from the
   *  start if it never got one. */
  async function resume(task) {
    readopt(task);
    const def = colleague(task.agent);
    if (!def) { task.error = `the colleague "${task.agent}" is not installed any more`; return settle(task, "failed", { error: task.error }); }
    let hasCheckpoint = false;
    try {
      const agent = await build(task, def);
      const st = await agent.getState({ configurable: { thread_id: task.thread } });
      hasCheckpoint = Boolean(st?.values?.messages?.length);
    } catch { hasCheckpoint = false; }
    logLine(task, hasCheckpoint ? "the server came back; continuing from the last checkpoint" : "the server came back; starting over");
    inbox("task.resumed", { task: task.id, title: task.title, from: hasCheckpoint ? "checkpoint" : "start" });
    return run(task, hasCheckpoint ? null : { messages: [{ role: "user", content: brief(task) }] });
  }

  /* ------------------------------------------------------------------ api */

  const shape = (t) => ({
    id: t.id, agent: t.agent, title: t.title, status: t.status, input: t.input,
    startedAt: t.startedAt, updatedAt: t.updatedAt, finishedAt: t.finishedAt, askedAt: t.askedAt ?? null, deadlineAt: t.deadlineAt ?? null,
    lease: t.lease ? { tabId: t.lease.tabId, url: t.lease.url } : null,
    questions: t.questions ?? null, answers: t.answers ?? {},
    result: t.result ?? null, error: t.error ?? null, acked: Boolean(t.acked),
    shot: existsSync(shotPath(t)) ? t.shotAt ?? true : null,
    log: t.log.slice(-80),
  });

  const api = {
    colleagues,
    list: () => [...state.tasks].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(shape),
    get: (id) => { const t = byId(id); return t ? shape(t) : null; },
    blocked: () => state.tasks.filter((t) => t.status === "blocked").sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt))).map(shape),
    running: () => state.tasks.filter((t) => t.status === "running").map(shape),
    screenshotPath: (id) => { const t = byId(id); return t && existsSync(shotPath(t)) ? shotPath(t) : null; },

    /** Start a colleague on a task. Returns {id} at once; the run is the
     *  thread's business. `input.url` opens the tab before the first turn. */
    async start(agentId, input = {}, { title = null } = {}) {
      const def = colleague(agentId);
      if (!def) return { error: `no colleague "${agentId}" — the Tasks page lists the ones installed` };
      if (!hasModel(dir)) return { error: "no model to run it on — add an OpenRouter key or pick Local on Settings" };
      const url = input?.url && /^https?:\/\//i.test(String(input.url)) ? String(input.url) : null;
      if (def.grants.length && !url && !input?.brief) return { error: "a browser colleague needs a url to open, or a brief that names one" };
      const id = `t${Date.now().toString(36)}${(seq++).toString(36)}`;
      const task = {
        id, agent: def.id, title: short(title || def.name, 80), input: { ...input, ...(url ? { url } : {}) },
        status: "running", thread: `mq:task:${id}`, startedAt: now(), updatedAt: now(), finishedAt: null,
        lease: null, questions: null, answers: {}, result: null, error: null, acked: false, log: [],
      };
      state.tasks.push(task);
      save();
      inbox("task.started", { task: id, title: task.title, agent: def.id, input: task.input });
      (async () => {
        if (url && def.grants.length) {
          const l = await openLease(task, url);
          if (l.error) { task.error = l.error; await settle(task, "failed", { error: l.error }); return; }
        }
        await run(task, { messages: [{ role: "user", content: brief(task) }] });
      })().catch((e) => { task.error = String(e?.message ?? e); settle(task, "failed", { error: task.error }); });
      return { id };
    },

    /** One question answered. When the list is complete the thread resumes. */
    answerQuestion(id, qid, value) {
      const t = byId(id);
      if (!t || t.status !== "blocked") return { error: "that task is not waiting on an answer" };
      if (!(t.questions ?? []).some((q) => q.id === qid)) return { error: "that question is not the one being asked" };
      t.answers = { ...(t.answers ?? {}), [qid]: value ?? null };
      const complete = (t.questions ?? []).every((q) => q.id in t.answers);
      save();
      if (complete) api.answer(id, t.answers);
      return { ok: true, complete };
    },

    /** All the answers at once (the CMO's answer_task, or a script). */
    answer(id, answers = {}) {
      const t = byId(id);
      if (!t || t.status !== "blocked") return { error: "that task is not waiting on an answer" };
      t.answers = { ...(t.answers ?? {}), ...answers };
      logLine(t, `answered: ${short(JSON.stringify(t.answers), 200)}`);
      inbox("task.answered", { task: id, title: t.title, answers: t.answers });
      run(t, new Command({ resume: t.answers })).catch(() => {});
      return { ok: true };
    },

    async cancel(id, why = "cancelled by the operator") {
      const t = byId(id);
      if (!t || /^(done|failed|cancelled)$/.test(t.status)) return { error: "that task is not running" };
      const h = running.get(t.id);
      t.status = "cancelled";
      t.error = why;
      logLine(t, `cancelled: ${why}`);
      if (h) { clearTimeout(h.timer); try { h.ctrl.abort(); } catch { /* fine */ } }
      await settle(t, "cancelled", { why });
      return { ok: true };
    },

    ack(id) { const t = byId(id); if (!t) return { error: "no such task" }; t.acked = true; save(); return { ok: true }; },

    retry(id) { const t = byId(id); if (!t) return { error: "no such task" }; return api.start(t.agent, t.input, { title: t.title }); },

    /** The inbox, from a line cursor. The CMO reads it when idle. */
    inbox(cursor = 0) {
      const p = join(dir, "inbox.jsonl");
      if (!existsSync(p)) return { events: [], cursor: 0 };
      const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
      const from = Math.min(Math.max(0, Number(cursor) || 0), lines.length);
      const events = lines.slice(from).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return { events, cursor: lines.length };
    },
    /** Something else that happened, said into the inbox (the CMO's notes,
     *  the lane's refusals, a person's answers). */
    note: (type, detail) => inbox(type, detail),
  };

  // The server came back. Running tasks continue from their checkpoint;
  // blocked ones keep waiting — their interrupt is persisted, their tab
  // re-adopted so the answer can drive it.
  for (const t of state.tasks) {
    if (t.status === "running") resume(t).catch(() => {});
    else if (t.status === "blocked") readopt(t);
  }

  return api;
}

/* ----------------------------------------------------------------- helpers */

const contentText = (c) => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return c == null ? "" : String(c);
};

const lastAiText = (messages) => {
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const type = typeof m?.getType === "function" ? m.getType() : (m?._getType?.() ?? m?.type ?? "");
    if (type === "ai" && !(m.tool_calls ?? []).length) {
      const t = contentText(m.content).trim();
      if (t) return t;
    }
  }
  return "";
};
