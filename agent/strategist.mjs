// The strategist — Messaging Quest's brain, on Deep Agents. From milestone 1
// (PLAN.md 2026-09-03) it is the CMO: a colleague that talks, proposes, and
// puts colleagues of its own to work in the operator's browser.
//
// This is the one directory in the repo that carries dependencies, and the
// decision is recorded in PLAN.md (2026-09-01): the re-adoption triggers
// written down when the frameworks were removed — subagents, long-held state,
// unbounded steps — fired the moment the product became "a marketing
// specialist that plans and researches" rather than "a reading tool". The
// HEART did not move: lib/ and skills/ stay zero-dependency, every verb the
// strategist uses is the same CLI the dashboard's buttons spawn, and this
// module sits behind one lazy import in bin/serve.mjs that degrades to a
// clear "npm run brain" message when node_modules is absent.
//
// The division of labour, same as the MCP server's and for the same reason:
//   - The CMO TALKS, PLANS, and uses the verbs. It can judge, fetch draft
//     material, save a draft (which runs the refusals), mark outcomes.
//   - It does NOT run the reading verbs (sync/probe/tick) — reading Reddit
//     costs a minute a request and belongs to the machine that watches, not to
//     a chat turn. It deals a card that offers the button.
//   - Background work is a WORKER on its own thread (agent/tasks.mjs): the CMO
//     proposes one as a card, the operator's click starts it, and the CMO
//     hears of it through the inbox when idle — and is allowed to ignore it.
//   - Its thread is NEVER interrupted: LangGraph drops a pending interrupt
//     when a thread is invoked with fresh input, so approvals are cards and
//     its questions are dealt (ask_person) and answered through the inbox.
//     Interrupts live only in workers.
//   - It may READ the operator's browser through the control lane — a tab it
//     leases for the turn and releases after — and never click or type.
//   - It does NOT write the five memory files. It writes exactly one:
//     AGENTS.md, its own notebook — standing instructions and what it learned.
//   - Nothing posts. There is no such code anywhere in this repo to call.
//
// What Deep Agents buys here, concretely: the planning/todo loop, a virtual
// scratch filesystem for long research (context management), subagents when
// a research task warrants one (skills/<id>/agent.mjs), summarization when a
// thread runs long, and the same skills/<id>/SKILL.md files that teach every
// other surface.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDeepAgent } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { seat, hasModel } from "../lib/models.mjs";
import { memoryContext, readOne } from "../lib/memory.mjs";
import { activeSkills, activeSeat } from "../lib/skills.mjs";
import { PER_ROOM_24H, OVERALL_24H } from "../lib/ready.mjs";
import { proposable, patchStash, readStash } from "../lib/cards.mjs";
import { TOOLKIT } from "../lib/control.mjs";
import { engineTools } from "./verbs.mjs";
import { threadSaver } from "./threads.mjs";
import { QUESTIONS, normalizeQuestions } from "./tasks.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const short = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/* ---------------------------------------------------------------- runtime */

/** What bin/serve.mjs hands over once the runtime is up: the task manager
 *  (workers, inbox) and the control lane's broker (tabs). Absent — a bare
 *  test harness — the tools that need them say so instead of failing. */
let runtime = { tasks: null, control: null };
export function attachRuntime({ tasks = null, control = null } = {}) { runtime = { tasks, control }; }

/* ------------------------------------------------------------------ verbs */

/** Every action goes through the CLI — one implementation of every verb,
 *  shared with the dashboard's buttons, the MCP tools and every worker
 *  (agent/verbs.mjs seats them). The refusals, the governor and the rubric
 *  hash all live down there, which is exactly why. */
const makeTools = (dir) => [
  ...engineTools(dir),

  tool(async ({ question, why, verb }) => {
    // The allowlist is parsed in the zero-dep heart (lib/cards.mjs), and the
    // server RE-parses it from its own stash at act time — so nothing this
    // tool writes can widen what the button does beyond what its label says.
    const p = proposable(verb);
    if (!p) return "not a proposable verb — allowed: judge | tick | sync | draft <item-id> | probe <room> [phrase]";
    patchStash(dir, { agent_card: { question: String(question ?? "").slice(0, 140), why: String(why ?? "").slice(0, 400), verb: String(verb).trim(), at: new Date().toISOString() } });
    return `proposed — "${p.label}" is on the operator's deck now. One proposal stands at a time; proposing again replaces it.`;
  }, {
    name: "propose",
    description: "Put ONE suggestion on the operator's deck as a card: a question (what you suggest and why it is now), a why (the evidence, concretely), and a verb from: judge | tick | sync | draft <item-id> | probe <room> [phrase]. Use this instead of asking them to go and press something — the card IS you pressing it, minus the click, which stays theirs. One proposal at a time; the newest replaces the last.",
    schema: z.object({
      question: z.string().describe("The suggestion, as a card title. 'Probe r/freelance for \"how do I find clients\"?'"),
      why: z.string().describe("Why this, why now — concrete: numbers from the queue, a quote, a gap."),
      verb: z.string().describe("Exactly one of: judge | tick | sync | draft <item-id> | probe <room> [phrase]"),
    }),
  }),

  /* ---- colleagues: propose a task, hear about it, answer or stop it. */
  tool(async ({ proposals }) => {
    const T = runtime.tasks;
    if (!T) return "no runtime here — the task manager is not attached; nothing can be started";
    const known = new Map(T.colleagues().map((c) => [c.id, c]));
    const kept = [];
    const refused = [];
    for (const p of proposals) {
      const c = known.get(p.agent);
      if (!c) { refused.push(`${p.agent}: no such colleague (installed: ${[...known.keys()].join(", ") || "none"})`); continue; }
      if (c.grants.length && !p.input?.url) { refused.push(`${p.agent}: a browser colleague needs input.url — the page it opens`); continue; }
      kept.push({ agent: c.id, question: short(p.question, 140), why: short(p.why, 400), label: short(p.label, 40), task: { agent: c.id, title: short(p.title ?? p.question, 80), input: p.input ?? {} } });
    }
    patchStash(dir, { proposals: kept });
    return [
      kept.length ? `dealt — ${kept.length} proposal${kept.length === 1 ? "" : "s"} on the deck, one card at a time; the operator's click starts each one, and you hear task.started in your inbox. Do not say a task has started until you do.` : "nothing dealt",
      ...refused,
    ].join("\n");
  }, {
    name: "propose_tasks",
    description: "Offer background work: one or more tasks for colleagues (skills/<id>/agent.md — see `tasks` for who is installed), each as a card with the reason on it. The operator's click starts a task on its own thread, in a tab of their own browser; you hear of it in your inbox. Never start work by any other means, and never claim it started because you proposed it. Proposing again replaces the list.",
    schema: z.object({
      proposals: z.array(z.object({
        agent: z.string().describe("The colleague's id, e.g. reddit"),
        question: z.string().describe("The card's title: what you suggest, as a question. 'Search r/saas for people asking this?'"),
        why: z.string().describe("Why this, why now — concrete."),
        input: z.object({
          url: z.string().optional().describe("The page the colleague opens first (a browser colleague needs one)"),
          brief: z.string().optional().describe("What to do there, in a sentence or two"),
        }).passthrough().optional(),
        title: z.string().optional().describe("Short title for the task list"),
        label: z.string().optional().describe("The button's label; default 'Start it'"),
      })).min(1).max(5),
    }),
  }),

  tool(async () => {
    const T = runtime.tasks;
    if (!T) return "no runtime here — nothing is running and nothing can be";
    const tasks = T.list().slice(0, 20).map((t) => ({
      id: t.id, title: t.title, agent: t.agent, status: t.status, startedAt: t.startedAt,
      questions: t.questions?.map((q) => ({ id: q.id, question: q.question, choices: q.choices?.map((c) => c.id) })) ?? null,
      result: t.result ? short(t.result, 300) : null, error: t.error ?? null,
    }));
    const colleagues = T.colleagues().map((c) => ({ id: c.id, name: c.name, description: c.description, tools: c.tools, seat: c.model }));
    return JSON.stringify({ colleagues, tasks, proposals_on_deck: (readStash(dir).proposals ?? []).map((p) => p.question) });
  }, {
    name: "tasks",
    description: "The colleagues installed (id, what each does, its tools) and every task: running, blocked on a question, done with its result, failed with its reason. Read this before proposing or answering anything about background work.",
    schema: z.object({}),
  }),

  tool(async ({ task, answers }) => {
    const T = runtime.tasks;
    if (!T) return "no runtime here";
    const out = T.answer(task, answers);
    return out.error ? out.error : `answered — ${task} resumes now; you hear task.done or task.blocked in your inbox`;
  }, {
    name: "answer_task",
    description: "Answer a blocked colleague's question list on the operator's behalf — ONLY when you know the answer from the inbox, the files or what they told you. Its card is already on their deck; when in doubt, leave it to them. answers is keyed by question id: a choice id, a list of them, free text, or null.",
    schema: z.object({ task: z.string(), answers: z.record(z.any()) }),
  }),

  tool(async ({ task, why }) => {
    const T = runtime.tasks;
    if (!T) return "no runtime here";
    const out = await T.cancel(task, short(why, 200) || "stopped by the specialist");
    return out.error ? out.error : `stopped — ${task} is cancelled and its tab closed`;
  }, {
    name: "cancel_task",
    description: "Stop a running or blocked task. Its tab closes; the inbox records why. Use it when a task is plainly wrong, looping, or no longer wanted — and say so to the operator.",
    schema: z.object({ task: z.string(), why: z.string() }),
  }),

  tool(async ({ since }) => {
    const T = runtime.tasks;
    if (!T) return "no inbox here";
    const { events, cursor } = T.inbox(since ?? 0);
    return JSON.stringify({ cursor, events: events.slice(-60) });
  }, {
    name: "inbox",
    description: "The runtime's events, oldest first from a cursor: task.started, task.tab, task.blocked (with its questions), task.answered, task.done (with the result), task.failed, task.cancelled, person.answered (answers to your own ask_person), proposal.accepted / dismissed, call.refused, grant.needed. New events are also delivered to you when you are idle.",
    schema: z.object({ since: z.number().int().min(0).optional() }),
  }),

  /* ---- the question list, the CMO's way: dealt as cards, never an
     interrupt on this thread. The answers arrive in the inbox. */
  tool(async ({ questions, eyebrow }) => {
    const list = normalizeQuestions(questions);
    if (!list.length) return "no valid questions — ids are [\\w-]{1,40}, each needs a question";
    const id = `ask${Date.now().toString(36)}`;
    patchStash(dir, { cmo_ask: { id, questions: list, answers: {}, eyebrow: short(eyebrow, 60) || undefined, at: new Date().toISOString() } });
    return `dealt — ${list.length} question${list.length === 1 ? "" : "s"} on the deck (${id}), one card at a time. The answers reach you as a person.answered event in your inbox; do not wait for them in this turn. Asking again replaces the list.`;
  }, {
    name: "ask_person",
    description: "Ask the operator one or more questions as cards — a choice among options, a fact only they know, 'which of these first?'. Worked choices first; a field only when the answer cannot be on a list. You do NOT wait: the answers arrive later in your inbox as person.answered, and the deck already asks the setup questions itself — never duplicate those.",
    schema: QUESTIONS.extend({ eyebrow: z.string().optional().describe("A short label above the cards, e.g. 'Before the search'") }),
  }),

  tool(async ({ text }) => {
    const t = String(text ?? "").trim().slice(0, 700);
    if (!t) return "nothing to say";
    patchStash(dir, { cmo_note: { text: t, at: new Date().toISOString() } });
    runtime.tasks?.note("cmo.note", { text: t });
    return "on the deck — one note at a time; the newest replaces the last";
  }, {
    name: "notify",
    description: "Say one thing to the operator on their deck without being asked — a count a colleague brought back, a refusal worth knowing, a finding. Lead with the fact; one line, then at most a short paragraph. Use it sparingly: silence means things are working.",
    schema: z.object({ text: z.string() }),
  }),

  /* ---- the notebook: the one file this model writes. */
  tool(async () => notebook(dir) || "(empty — nothing written yet)", {
    name: "read_notebook",
    description: "Your own notebook, AGENTS.md in the data directory: standing instructions and what you have learned about this brand and this operator. It is in your prompt already; read it here when you are about to rewrite it.",
    schema: z.object({}),
  }),
  tool(async ({ text }) => {
    const body = String(text ?? "").replace(/\r\n/g, "\n").trim().slice(0, 8000);
    writeFileSync(join(dir, "AGENTS.md"), body + "\n");
    return `written — ${body.length} characters. It loads into your prompt from the next turn.`;
  }, {
    name: "write_notebook",
    description: "Rewrite AGENTS.md — your notebook — in full (at most 8000 characters). Keep it to what is durable: how this operator wants to be spoken to, what the brand is and is not, which rooms worked, what was refused and why. Facts about people belong in the store, not here. This is the only memory file you may write; the five others are the operator's.",
    schema: z.object({ text: z.string() }),
  }),

  /* ---- the browser, read-only, on a tab leased for the turn. */
  ...browserTools(dir),

  tool(async () => {
    // The same deck the panel renders — the strategist should never guess
    // what the operator is being shown. MQ_RELAY is the dashboard's own
    // address (set at listen), and this process is the dashboard, so the
    // fetch is a loopback to ourselves; absent (a bare test harness), the
    // honest answer is that there is no deck to read.
    const base = process.env.MQ_RELAY;
    if (!base) return "no deck here — the dashboard is not running";
    try {
      const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(5000) });
      const { cards, jobs, tasks } = await res.json();
      return JSON.stringify({
        showing: cards?.[0]?.id ?? null,
        cards: (cards ?? []).map((c) => ({ id: c.id, question: c.question })),
        running: (jobs ?? []).map((j) => j.label),
        tasks: (tasks ?? []).map((t) => `${t.title}: ${t.status}`),
      });
    } catch (e) {
      return `could not read the deck: ${e.message}`;
    }
  }, {
    name: "deck",
    description: "What the operator's panel is showing right now: the current card, the cards behind it, running jobs and colleagues at work. Read this before advising a next action — the deck IS the next action, and advice that contradicts the card on screen is worse than silence.",
    schema: z.object({}),
  }),
];

/* ----------------------------------------------------------- the browser */

/** One lease per turn, opened on the first navigate and released when the
 *  turn ends (see `turn`). Read-only by grant: the lane refuses anything
 *  else before the extension hears of it. */
const CMO_GRANTS = ["read"];
let turnLease = null;   // { id, tabId, url } while a turn holds a tab

const BROWSER = {
  tabs_context: [z.object({}), "Your tab, if you opened one this turn: url, title, status."],
  navigate: [z.object({ url: z.string() }), "Open an http(s) page in a tab of the operator's own browser (leased for this turn, closed after) or go back/forward. Paced per site by the lane."],
  read_page: [z.object({ filter: z.enum(["all", "interactive"]).optional(), max_chars: z.number().int().optional(), ref_id: z.string().optional() }), "The page as an accessibility tree with [ref_N] on interactive nodes."],
  find: [z.object({ query: z.string() }), "Elements whose role, name, text or href contains the query."],
  get_page_text: [z.object({ max_chars: z.number().int().optional() }), "The page's readable text, article or main first."],
  computer: [z.object({ action: z.enum(["screenshot", "scroll", "scroll_to", "wait"]), coordinate: z.array(z.number()).length(2).optional(), ref: z.string().optional(), scroll_direction: z.enum(["up", "down", "left", "right"]).optional(), scroll_amount: z.number().int().optional(), duration: z.number().optional() }), "screenshot (saved; you get its size), scroll, scroll_to a ref, wait. Nothing that clicks or types — you hold no such grant."],
};

function browserTools(dir) {
  return Object.entries(BROWSER).map(([name, [schema, description]]) => tool(async (input) => {
    const C = runtime.control;
    if (!C) return "no browser lane here — the control broker is not attached";
    if (!TOOLKIT[name]) return `${name} is not in the toolkit`;
    if (!turnLease) {
      const url = name === "navigate" && /^https?:\/\//i.test(String(input?.url ?? "")) ? input.url : null;
      if (!url) return "no tab open — navigate to an http(s) url first";
      const r = await C.lease({ task: "your specialist", url });
      if (r.error) return `could not open a tab: ${r.error}`;
      turnLease = { id: r.id, tabId: r.tabId, url };
      return JSON.stringify({ opened: true, url, tabId: r.tabId, note: "the page is loaded; read it with read_page or get_page_text" });
    }
    let out = await C.act(turnLease.id, name, input ?? {}, { grants: CMO_GRANTS });
    if (name === "computer" && input?.action === "screenshot" && out?.screenshot) out = { ok: true, width: out.width, height: out.height, note: "taken; screenshots are for the operator's cards, you read the tree" };
    return JSON.stringify(out ?? {}).slice(0, 80_000);
  }, { name, description, schema }));
}

async function releaseTurnLease() {
  const l = turnLease;
  turnLease = null;
  if (l && runtime.control) { try { await runtime.control.release(l.id); } catch { /* the tab is gone either way */ } }
}

/* ----------------------------------------------------------------- persona */

/** persona.md is a real memory file (lib/memory.mjs, optional: true) — the
 *  operator edits who this is on the dashboard's memory page, and readOne
 *  hands back the seed until they do. It reaches ONLY this seat: the judge
 *  and writer never see it, because a judge told "you are a colleague named
 *  X" starts judging like a colleague named X. */
const personaOf = (dir) => readOne(dir, "persona.md")?.body ?? "";

/** AGENTS.md — the sixth memory file, and the only one the model writes. */
const notebook = (dir) => { const p = join(dir, "AGENTS.md"); return existsSync(p) ? readFileSync(p, "utf8").trim() : ""; };

/** The active skills' SKILL.md, inlined: what the platforms tolerate, the
 *  measured facts, the refusals. Inlined rather than mounted — a listing that
 *  points at a path the agent's file tools cannot reach costs steps for
 *  nothing (measured on the first live worker run, 2026-09-03). */
const skillsText = () => activeSkills()
  .map((k) => { try { return `## ${k.id} (skills/${k.id}/SKILL.md)\n\n${readFileSync(join(k.path, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim().slice(0, 12_000)}`; } catch { return ""; } })
  .filter(Boolean).join("\n\n");

const doctrine = `
House rules, non-negotiable:
- Nothing posts to Reddit from this machine, ever. The operator reads every
  draft in Reddit's own composer and presses Reddit's own button.
- The pacing limits stand: ${PER_ROOM_24H} replies per room and ${OVERALL_24H} overall in 24 hours.
  If the governor refuses a send, that is the answer — relay its reason.
- Reading verbs (sync, probe, tick) run on the server's clock, not in chat.
  When one is the right next move, use the propose tool — the card is you
  reaching for the button; the click stays the operator's.
- Background work is a COLLEAGUE on its own thread: propose_tasks deals the
  card, the operator's click starts it, and you hear of it in your inbox.
  Never claim a task started because you proposed it. Silence from a running
  task means it is working.
- A blocked colleague's question is already on the operator's deck. Use
  answer_task only when you KNOW the answer; never guess for them.
- Your inbox is delivered when you are idle. React with notify or
  propose_tasks when there is signal — a count, a wall, a refusal — or say
  nothing. Not every event deserves a word.
- You may read pages in the operator's own browser (navigate, read_page …)
  and never click or type — you hold no such grant, and the lane refuses.
- Judge only against rule.md. Draft only from draft_material. Never invent a
  first-person claim me.md does not support.
- Numbers come from the tools. Quote the count a tool returned; never tally
  rows by hand and never round — a figure you worked out yourself is a figure
  you can get wrong, and the operator acts on it.
- The five memory files are the operator's to edit. Propose; never pretend
  you saved. AGENTS.md is yours: write_notebook what is durable.
- Setup is the deck's: on a fresh directory it already asks the account, the
  site, the voice habits, the proof-read and the first room, one card at a
  time. Do not duplicate those with ask_person. Read the deck; when setup is
  done, propose the first task — the Reddit search, in their own browser.`;

/* -------------------------------------------------------------- the agent */

// The threads live on the SQLite checkpointer in the data directory
// (agent/threads.mjs) — the CMO on one long-lived thread that a restart no
// longer forgets, each worker on its own. Every fact still lives in the store
// and the memory files; what the checkpoint keeps is the conversation.
const agents = new Map();

/* The agent door. A skill folder with an agent.mjs contributes a SUBAGENT —
 * a colleague the strategist can hand a task to INSIDE a turn (research for
 * a reply). The module itself is bare Node (the heart's rule: skills carry no
 * dependencies); THIS file owns the LangChain runtime, so the adaptation
 * happens here and nowhere else. Background colleagues are agent.md, seated
 * by agent/tasks.mjs on their own threads.
 *
 * The contract, deliberately small: default export
 *   { name, description, prompt, tools?: [{ name, description, schema, run }] }
 * with schema plain JSON Schema and run(args, { dir }) returning a string.
 * The registry decides which agent skills are ACTIVE; a folder that lost its
 * slot never reaches this seat. */
async function skillSubagents(dir) {
  const out = [];
  for (const s of activeSeat("agent")) {
    try {
      const a = (await import(pathToFileURL(s.seats.agent).href)).default;
      if (!a?.name || !a.description || !a.prompt) {
        console.error(`skill ${s.id}: agent.mjs must default-export { name, description, prompt } — not seated`);
        continue;
      }
      out.push({
        name: String(a.name),
        description: String(a.description),
        systemPrompt: String(a.prompt),
        tools: (a.tools ?? []).map((t) =>
          tool(async (args) => String(await t.run(args ?? {}, { dir })), {
            name: t.name,
            description: t.description,
            schema: t.schema ?? { type: "object", properties: {} },
          })),
      });
    } catch (e) {
      console.error(`skill ${s.id}: agent.mjs — ${e.message} — not seated`);
    }
  }
  return out;
}

async function agentFor(dir) {
  const s = seat(dir, "scout"); // the researcher seat: biggest window, tool-happy

  // The system prompt bakes in the memory files, so an agent built before
  // setup finished would keep telling the user their files are empty. The
  // cache key is what the prompt was built FROM — the seat, the persona, the
  // memory, the notebook, and which skills are active; when any of that
  // moves, rebuild.
  const fp = createHash("sha1").update([
    dir, s.model, personaOf(dir), memoryContext(dir), notebook(dir),
    activeSkills().map((k) => `${k.id}@${k.path}`).join(","),
    runtime.tasks ? "runtime" : "bare",
  ].join("\x00")).digest("hex");
  if (agents.get(dir)?.fp === fp) return agents.get(dir).agent;

  const model = new ChatOpenAI({
    model: s.model,
    apiKey: s.key,
    configuration: { baseURL: s.baseUrl },
    maxTokens: s.maxTokens,
    timeout: s.timeoutMs,
  });

  const subagents = await skillSubagents(dir);
  const skills = skillsText();
  const nb = notebook(dir);

  const agent = createDeepAgent({
    model,
    tools: makeTools(dir),
    systemPrompt: [
      personaOf(dir),
      doctrine,
      "What you know about the operator:\n\n" + (memoryContext(dir) || "(their memory files are still empty — setup is not finished)"),
      nb ? "Your notebook (AGENTS.md):\n\n" + nb : "Your notebook (AGENTS.md) is empty. Write it when you have learned something durable.",
      skills ? "What the skills teach:\n\n" + skills : "",
    ].filter(Boolean).join("\n\n"),
    ...(subagents.length ? { subagents } : {}),
    checkpointer: threadSaver(dir),
  });

  agents.set(dir, { fp, agent });
  return agent;
}

/* ------------------------------------------------------------------ turns */

// Turns on one directory run one at a time: the panel's message and the
// inbox's delivery must not invoke the same thread concurrently, and the
// turn's browser lease is one tab for one turn.
const queues = new Map();
const serial = (dir, fn) => {
  const prev = queues.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(dir, next.catch(() => {}));
  return next;
};

async function turn(dir, content, thread) {
  const agent = await agentFor(dir);
  try {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: String(content).slice(0, 12_000) }] },
      { configurable: { thread_id: `mq:${thread}` }, recursionLimit: 40 },
    );
    const last = result.messages?.[result.messages.length - 1];
    return contentText(last?.content);
  } finally {
    await releaseTurnLease();
  }
}

/**
 * One turn. `thread` keeps a conversation's context on the saver; the panel
 * uses one thread, a future Telegram relay would use another.
 */
export async function strategist(dir, message, thread = "panel") {
  if (!String(message ?? "").trim()) return { reply: "Say something and I will answer." };
  const reply = await serial(dir, () => turn(dir, message, thread));
  return { reply };
}

/* ------------------------------------------------------------------ inbox */

const REACT_TO = new Set(["setup.done", "task.done", "task.failed", "task.blocked", "task.cancelled", "person.answered", "proposal.accepted", "proposal.dismissed", "call.refused", "grant.needed", "click.refused"]);

/**
 * Inbox delivery when idle: every `everyMs`, the events since the last
 * cursor that deserve a reaction are handed to the CMO's thread as one
 * message. It may notify, propose, answer a task — or say nothing; the reply
 * text is not shown anywhere. Never while another turn is in flight (the
 * queue), never without a model, and with a long back-off after an error so
 * a dead key does not cost a failed call every twenty seconds.
 */
export function startInboxLoop(dir, { everyMs = 20_000, thread = "panel" } = {}) {
  let backoffUntil = 0;
  let inFlight = false;
  const tick = async () => {
    const T = runtime.tasks;
    if (!T || inFlight || Date.now() < backoffUntil || !hasModel(dir)) return;
    const cursor = Number(readStash(dir).cmo_cursor) || 0;
    const { events, cursor: next } = T.inbox(cursor);
    if (next === cursor) return;
    const worth = events.filter((e) => REACT_TO.has(e.type));
    if (!worth.length) { patchStash(dir, { cmo_cursor: next }); return; }
    inFlight = true;
    try {
      const digest = worth.slice(-20).map((e) => `- ${e.at} ${e.type}${e.title ? ` · ${e.title}` : ""}${e.task ? ` (${e.task})` : ""}${e.questions ? ` — asks: ${e.questions.join(" · ")}` : ""}${e.result ? ` — ${short(e.result, 400)}` : ""}${e.error ? ` — ${short(e.error, 200)}` : ""}${e.why ? ` — ${short(e.why, 200)}` : ""}${e.answers ? ` — answers: ${short(JSON.stringify(e.answers), 300)}` : ""}${e.origin ? ` — ${e.origin}` : ""}`).join("\n");
      // Setup finishing is the one event with a prescribed reaction: the
      // first proposal, the Reddit search in their own browser (PLAN.md,
      // milestone 1). Everything else is the CMO's call.
      const setup = worth.find((e) => e.type === "setup.done");
      const ask = setup
        ? `Setup is done: ${setup.title}. Propose the first task now, with propose_tasks — one card: agent "reddit", the room and phrase the operator chose (their search URL is the input url: ${JSON.stringify(setup.sources ?? [])}), the reason on the card in one or two plain sentences. Do not answer "noted" to this one, and do not start anything yourself.`
        : `React only if there is signal — notify the operator, propose the next task, answer a colleague you can answer — otherwise reply with the single word "noted".`;
      await serial(dir, () => turn(dir,
        `Inbox (${worth.length} event${worth.length === 1 ? "" : "s"} since you last looked). ${ask}\n\n${digest}`,
        thread));
      patchStash(dir, { cmo_cursor: next });
    } catch (e) {
      console.error(`inbox delivery failed: ${String(e?.message ?? e).split("\n")[0]} — trying again in 5 minutes`);
      backoffUntil = Date.now() + 5 * 60_000;
    } finally {
      inFlight = false;
    }
  };
  const t = setInterval(() => { tick().catch(() => {}); }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

const contentText = (c) => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return String(c ?? "");
};
