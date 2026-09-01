// The strategist — earshot's brain, on Deep Agents.
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
//   - The strategist TALKS, PLANS, and uses the verbs. It can judge, fetch
//     draft material, save a draft (which runs the refusals), mark outcomes.
//   - It does NOT run the reading verbs (sync/probe/tick) — reading Reddit
//     costs a minute a request and belongs to the machine that watches, not to
//     a chat turn. It tells the user which card or button does that.
//   - It does NOT write the memory files. Nothing writes those without a
//     keystroke behind it; the strategist proposes text and says where to put
//     it.
//   - Nothing posts. There is no such code anywhere in this repo to call.
//
// What Deep Agents buys here, concretely: the planning/todo loop, a virtual
// scratch filesystem for long research (context management — big reads go to
// files, not into the window), subagents when a research task warrants one,
// summarization when a thread runs long, and the skills loader reading the
// same skills/<id>/SKILL.md files that teach every other surface.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeepAgent, createSkillsMiddleware, FilesystemBackend } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { seat } from "../lib/models.mjs";
import { memoryContext, readOne } from "../lib/memory.mjs";
import { PER_ROOM_24H, OVERALL_24H } from "../lib/ready.mjs";
import { proposable, patchStash } from "../lib/cards.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ES = join(ROOT, "bin", "es.mjs");

/* ------------------------------------------------------------------ verbs */

/** Every action goes through the CLI — one implementation of every verb,
 *  shared with the dashboard's buttons and the MCP tools. The refusals, the
 *  governor and the rubric hash all live down there, which is exactly why. */
const es = (dir, args, stdin = null) =>
  new Promise((resolvePromise) => {
    const child = execFile(process.execPath, [ES, ...args],
      { env: { ...process.env, EARSHOT_DIR: dir }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolvePromise(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || (err ? String(err.message) : "done")));
    if (stdin !== null) child.stdin.end(stdin);
  });

const makeTools = (dir) => [
  tool(async () => es(dir, ["status"]), {
    name: "status",
    description: "What became of the operator's own Reddit comments, read as a logged-out stranger sees them: visible, filtered, removed, what changed.",
    schema: z.object({}),
  }),
  tool(async () => es(dir, ["queue", "--json"]), {
    name: "queue",
    description: "The people waiting for an answer — already judged fit, not yet handled. JSON rows with id, place, author, title, body, url.",
    schema: z.object({}),
  }),
  tool(async () => es(dir, ["pending"]), {
    name: "pending",
    description: "Items that still need a fit verdict, numbered, as JSON. You may judge them yourself against rule.md (read it with read_memory first), then call judge.",
    schema: z.object({}),
  }),
  tool(async ({ verdicts }) => es(dir, ["judge"], JSON.stringify(verdicts)), {
    name: "judge",
    description: "Record fit verdicts for pending items. Judge against the operator's rule.md and NOTHING else; when you cannot tell, the rule says answer yes.",
    schema: z.object({
      verdicts: z.array(z.object({
        n: z.number().describe("Item number from pending"),
        fit: z.boolean(),
        why: z.string().describe("One sentence, quoting their words where you can"),
      })),
    }),
  }),
  tool(async ({ id }) => es(dir, ["draft", id]), {
    name: "draft_material",
    description: "Everything needed to answer one person: what they said, the operator's measured voice rules, the room's risks, what they can honestly claim. Write the reply FROM this — never invent a first-person claim it does not contain — then call save_draft.",
    schema: z.object({ id: z.string().describe("Item id from queue, e.g. t3_abc123") }),
  }),
  tool(async ({ id, text }) => es(dir, ["draft", id, "--save"], text), {
    name: "save_draft",
    description: "Save a reply draft for an item. The engine runs its refusals over it (repeated phrasing, unsupported claims, invented links) and reports any flags — surface those to the operator rather than hiding them. The draft lands on their card; THEY post it.",
    schema: z.object({ id: z.string(), text: z.string() }),
  }),
  tool(async ({ id, mark }) => es(dir, ["mark", id, mark]), {
    name: "mark",
    description: "Record what the operator did with a queue item: sent (they posted it themselves) or skip. Only mark sent when the operator SAYS they posted — the CLI's gate still fires and may refuse; relay its reason. Undoing lives on the dashboard's Prospects page.",
    schema: z.object({ id: z.string(), mark: z.enum(["sent", "skip"]) }),
  }),
  tool(async () => es(dir, ["rooms"]), {
    name: "rooms",
    description: "Every room known so far: probed, watched, its recorded rules answer, and standing where there is any.",
    schema: z.object({}),
  }),
  tool(async ({ file }) => {
    const m = readOne(dir, file);
    return m ? m.body : `not a memory file: ${file}`;
  }, {
    name: "read_memory",
    description: "Read one of the memory files verbatim: rule.md, project.md, icp.md, me.md, persona.md. You may not write them — propose text and tell the operator where it goes.",
    schema: z.object({ file: z.enum(["rule.md", "project.md", "icp.md", "me.md", "persona.md"]) }),
  }),
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
  tool(async () => {
    // The same deck the panel renders — the strategist should never guess
    // what the operator is being shown. EARSHOT_RELAY is the dashboard's own
    // address (set at listen), and this process is the dashboard, so the
    // fetch is a loopback to ourselves; absent (a bare test harness), the
    // honest answer is that there is no deck to read.
    const base = process.env.EARSHOT_RELAY;
    if (!base) return "no deck here — the dashboard is not running";
    try {
      const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(5000) });
      const { cards, jobs } = await res.json();
      return JSON.stringify({
        showing: cards?.[0]?.id ?? null,
        cards: (cards ?? []).map((c) => ({ id: c.id, question: c.question })),
        running: (jobs ?? []).map((j) => j.label),
      });
    } catch (e) {
      return `could not read the deck: ${e.message}`;
    }
  }, {
    name: "deck",
    description: "What the operator's panel is showing right now: the current card, the cards behind it, and any running jobs. Read this before advising a next action — the deck IS the next action, and advice that contradicts the card on screen is worse than silence.",
    schema: z.object({}),
  }),
];

/* ----------------------------------------------------------------- persona */

/** persona.md is a real memory file now (lib/memory.mjs, optional: true) —
 *  the operator edits who this is on the dashboard's memory page, and readOne
 *  hands back the seed until they do. It reaches ONLY this seat: the judge
 *  and writer never see it, because a judge told "you are a colleague named
 *  X" starts judging like a colleague named X. */
const personaOf = (dir) => readOne(dir, "persona.md")?.body ?? "";

const doctrine = `
House rules, non-negotiable:
- Nothing posts to Reddit from this machine, ever. The operator reads every
  draft in Reddit's own composer and presses Reddit's own button.
- The pacing limits stand: ${PER_ROOM_24H} replies per room and ${OVERALL_24H} overall in 24 hours.
  If the governor refuses a send, that is the answer — relay its reason.
- Reading verbs (sync, probe, tick) run on the server's clock, not in chat.
  When one is the right next move, use the propose tool — the card is you
  reaching for the button; the click stays the operator's.
- Judge only against rule.md. Draft only from draft_material. Never invent a
  first-person claim me.md does not support.
- The memory files are the operator's to edit. Propose; never pretend you saved.`;

/* -------------------------------------------------------------- the agent */

// One saver for the server's lifetime: the panel's thread keeps its context
// between messages. A restart forgets the conversation and loses nothing else
// — every fact lives in the store and the memory files, and the deck rebuilds
// from those.
const saver = new MemorySaver();
const agents = new Map();

function agentFor(dir) {
  const s = seat(dir, "scout"); // the researcher seat: biggest window, tool-happy

  // The system prompt bakes in the memory files, so an agent built before
  // setup finished would keep telling the user their files are empty. The
  // cache key is what the prompt was built FROM; when that moves, rebuild.
  const fp = createHash("sha1").update([dir, s.model, personaOf(dir), memoryContext(dir)].join("\x00")).digest("hex");
  if (agents.get(dir)?.fp === fp) return agents.get(dir).agent;

  const model = new ChatOpenAI({
    model: s.model,
    apiKey: s.key,
    configuration: { baseURL: s.baseUrl },
    maxTokens: s.maxTokens,
    timeout: s.timeoutMs,
  });

  const agent = createDeepAgent({
    model,
    tools: makeTools(dir),
    systemPrompt: [
      personaOf(dir),
      doctrine,
      "What you know about the operator:\n\n" + (memoryContext(dir) || "(their memory files are still empty — setup is not finished)"),
    ].join("\n\n"),
    middleware: [
      // The same SKILL.md files that teach the CLI's agents and any OpenClaw
      // agent teach this one: platform norms, measured facts, refusals.
      createSkillsMiddleware({
        backend: new FilesystemBackend({ rootDir: ROOT, virtualMode: true }),
        sources: ["/skills/"],
      }),
    ],
    checkpointer: saver,
  });

  agents.set(dir, { fp, agent });
  return agent;
}

/**
 * One turn. `thread` keeps a conversation's context on the saver; the panel
 * uses one thread, a future Telegram relay would use another.
 */
export async function strategist(dir, message, thread = "panel") {
  if (!String(message ?? "").trim()) return { reply: "Say something and I will answer." };
  const agent = agentFor(dir);
  const result = await agent.invoke(
    { messages: [{ role: "user", content: String(message).slice(0, 8000) }] },
    { configurable: { thread_id: `earshot:${thread}` }, recursionLimit: 40 },
  );
  const last = result.messages?.[result.messages.length - 1];
  return { reply: contentText(last?.content) };
}

const contentText = (c) => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return String(c ?? "");
};
