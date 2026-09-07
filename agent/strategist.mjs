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
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { readCampaigns, campaignDraft, MENTIONS, STATUSES } from "../lib/campaigns.mjs";
import { store } from "../lib/store.mjs";
import { campaignDigest, digestText, waiting as waitingRows } from "../lib/conversations.mjs";
import { listProjects } from "../lib/projects.mjs";
import { dataDir } from "../lib/dirs.mjs";
import { engineTools } from "./verbs.mjs";
import { threadSaver } from "./threads.mjs";
import { QUESTIONS, normalizeQuestions } from "./tasks.mjs";

const short = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/* ---------------------------------------------------------------- runtime */

/** What bin/serve.mjs hands over once a project's runtime is up: its task
 *  manager (workers, inbox) and the control lane's broker (tabs — one per
 *  machine). Per project directory: two projects are two CMOs, each on its
 *  own thread with its own colleagues. Absent — a bare test harness — the
 *  tools that need them say so instead of failing. */
const runtimes = new Map();
export function attachRuntime(dir, { tasks = null, control = null } = {}) {
  if (dir && typeof dir === "object") { runtimes.set("*", { tasks: dir.tasks ?? null, control: dir.control ?? null }); return; }   // the pre-0.6.0 call shape
  runtimes.set(String(dir), { tasks, control });
}
const runtimeOf = (dir) => runtimes.get(String(dir)) ?? runtimes.get("*") ?? { tasks: null, control: null };

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
    const T = runtimeOf(dir).tasks;
    if (!T) return "no runtime here — the task manager is not attached; nothing can be started";
    const known = new Map(T.colleagues().map((c) => [c.id, c]));
    const kept = [];
    const refused = [];
    for (const p of proposals) {
      const c = known.get(p.agent);
      if (!c) { refused.push(`${p.agent}: no such colleague (installed: ${[...known.keys()].join(", ") || "none"})`); continue; }
      if (c.grants.length && !p.input?.url) { refused.push(`${p.agent}: a browser colleague needs input.url — the page it opens`); continue; }
      if (p.input?.campaign && !readCampaigns(dir).some((k) => k.id === p.input.campaign)) { refused.push(`${p.agent}: no campaign "${p.input.campaign}" — see campaigns`); continue; }
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
          campaign: z.string().optional().describe("The campaign id this task works under, if any — its findings, verdicts and drafts carry it"),
        }).passthrough().optional(),
        title: z.string().optional().describe("Short title for the task list"),
        label: z.string().optional().describe("The button's label; default 'Start it'"),
      })).min(1).max(5),
    }),
  }),

  tool(async () => {
    const T = runtimeOf(dir).tasks;
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
    const T = runtimeOf(dir).tasks;
    if (!T) return "no runtime here";
    const out = T.answer(task, answers);
    return out.error ? out.error : `answered — ${task} resumes now; you hear task.done or task.blocked in your inbox`;
  }, {
    name: "answer_task",
    description: "Answer a blocked colleague's question list on the operator's behalf — ONLY when you know the answer from the inbox, the files or what they told you. Its card is already on their deck; when in doubt, leave it to them. answers is keyed by question id: a choice id, a list of them, free text, or null.",
    schema: z.object({ task: z.string(), answers: z.record(z.any()) }),
  }),

  tool(async ({ task, why }) => {
    const T = runtimeOf(dir).tasks;
    if (!T) return "no runtime here";
    const out = await T.cancel(task, short(why, 200) || "stopped by the specialist");
    return out.error ? out.error : `stopped — ${task} is cancelled and its tab closed`;
  }, {
    name: "cancel_task",
    description: "Stop a running or blocked task. Its tab closes; the inbox records why. Use it when a task is plainly wrong, looping, or no longer wanted — and say so to the operator.",
    schema: z.object({ task: z.string(), why: z.string() }),
  }),

  tool(async ({ since }) => {
    const T = runtimeOf(dir).tasks;
    if (!T) return "no inbox here";
    const { events, cursor } = T.inbox(since ?? 0);
    return JSON.stringify({ cursor, events: events.slice(-60) });
  }, {
    name: "inbox",
    description: "The runtime's events, oldest first from a cursor: task.started, task.tab, task.blocked (with its questions), task.answered, task.done (with the result), task.failed, task.cancelled, person.answered (answers to your own ask_person), proposal.accepted / dismissed, call.refused, grant.needed, campaign.created / campaign.status, reply.waiting (somebody the operator answered wrote back — the turn card is on their deck), day.digest (the numbers per campaign, once a day or when replies land). New events are also delivered to you when you are idle.",
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
    runtimeOf(dir).tasks?.note("cmo.note", { text: t });
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

  /* ---- campaigns: a direction the operator settles on cards; projects. */
  tool(async ({ campaign, status, why }) => {
    const c = readCampaigns(dir).find((k) => k.id === String(campaign ?? "").trim());
    if (!c) return `no campaign "${campaign}" — see campaigns`;
    if (!STATUSES.includes(status)) return `not a status: ${status} (${STATUSES.join(", ")})`;
    if (c.status === status) return `“${c.name}” is already ${status}`;
    patchStash(dir, { campaign_status_draft: { id: c.id, name: c.name, status, why: short(why, 500) } });
    return `dealt — one card asks the operator to ${status === "paused" ? "pause" : status === "done" ? "finish" : "resume"} “${c.name}”; their press changes the file and you hear campaign.status in your inbox. Do not say it is ${status} until you do.`;
  }, {
    name: "propose_status",
    description: "Propose pausing, resuming or finishing a campaign as ONE card on the operator's deck, with your reason. Use it after a digest when the numbers say a campaign is saturated (crowding rising, fit or second turns falling) or spent. The operator's press changes the status; you never change it yourself.",
    schema: z.object({ campaign: z.string().describe("The campaign id, from campaigns"), status: z.enum(["paused", "active", "done"]), why: z.string().describe("One plain line: the number that says so") }),
  }),
  tool(async (input) => {
    const d = campaignDraft(input);
    if (!d.name || !d.idea) return "a campaign needs a name and an idea";
    if (readCampaigns(dir).some((c) => c.id === d.id)) return `a campaign "${d.id}" already exists — propose a different name, or tell the operator to edit it on the dashboard's Campaigns page`;
    patchStash(dir, { campaign_draft: { ...d, done: [] } });
    return `dealt — “${d.name}” walks through the operator's deck now: the idea in their words, who it fits, whether a first message may name what they built (${d.mention}), the room, the phrase. Their last Save writes campaigns/${d.id}.md and probes the room in their browser; you hear campaign.created in your inbox. Do not say it exists until you do. Proposing again replaces the draft.`;
  }, {
    name: "propose_campaign",
    description: "Propose a CAMPAIGN as cards on the operator's deck: a name; the idea as a DIRECTION in prose (what to say and why it is honest to say it — never wording, never a template: the writer applies it per person, and an eight-word repeat is flagged); optionally who it fits (narrows rule.md for this campaign) and what it never does; mention: 'never' (the house rule — a first message sells nothing) or 'disclosed' (may name what they built once, plainly, as theirs, no link unless asked — the only lift there is); the room and the phrase to search. Each card is seeded with your text and has a field for their own words; the file is written by their Save, not by you. Use it when they describe a tactic, an angle, a platform-specific tone — and ask campaigns first, so you do not propose one that exists.",
    schema: z.object({
      name: z.string().describe("Short: 'Honest comments under \"finding clients\"'"),
      idea: z.string().describe("The direction, in prose. What to say and why it is honest — not the words to say it with."),
      fit: z.string().optional().describe("Who this campaign is for, when narrower than rule.md"),
      never: z.string().optional().describe("This campaign's own refusals, if any"),
      voice: z.string().optional().describe("How it sounds under this campaign, when a room or a platform wants a different tone — laid over the measured voice, which still wins on anything it names"),
      mention: z.enum(["never", "disclosed"]).optional().describe("Whether a first message may name what they built. Default never."),
      place: z.string().optional().describe("The room to search, without a platform prefix"),
      q: z.string().optional().describe("The phrase somebody types when they have the problem"),
      why: z.string().optional().describe("Why this, why now — shown on the first card"),
    }),
  }),
  tool(async () => {
    const root = dataDir();
    const all = listProjects(root);
    return JSON.stringify({ current: all.find((p) => p.dir === dir || p.current)?.id ?? null, projects: all.map((p) => ({ id: p.id, name: p.name, current: p.current })) });
  }, {
    name: "projects",
    description: "The projects on this machine and which one you are the specialist for. Each is its own isolated context — memory files, store, campaigns, colleagues; switching or creating one is the operator's, on the panel or the dashboard's Projects page.",
    schema: z.object({}),
  }),

  /* ---- the browser, read-only, on a tab leased for the turn. */
  ...browserTools(dir),

  tool(async () => {
    const deck = await deckSnapshot();
    return typeof deck === "string" ? deck : JSON.stringify(deck);
  }, {
    name: "deck",
    description: "What the operator's panel is showing right now: the current card, the cards behind it, running jobs and colleagues at work. Every panel message already arrives with this in front of it; call it again after you dealt something, or mid-turn when it may have moved. The deck IS the next action, and advice that contradicts the card on screen is worse than silence.",
    schema: z.object({}),
  }),
];

/* ------------------------------------------------------------------- deck */

/** The same deck the panel renders — the strategist should never guess what
 *  the operator is being shown. MQ_SERVER is the dashboard's own address
 *  (set at listen), and this process is the dashboard, so the fetch is a
 *  loopback to ourselves; absent (a bare test harness), the honest answer is
 *  that there is no deck to read. Enough of each card to talk about it
 *  truthfully: what kind it is, the button it actually carries, and whether
 *  the drafts are already on it — so the advice never offers to write what
 *  is written, or names a button the card does not have. */
async function deckSnapshot({ limit = 8 } = {}) {
  const base = process.env.MQ_SERVER;
  if (!base) return "no deck here — the dashboard is not running";
  try {
    const res = await fetch(`${base}/api/cards`, { signal: AbortSignal.timeout(5000) });
    const { cards, jobs, tasks } = await res.json();
    // The numbers as the engine counts them, this second — so a question
    // about a count is answered from here, not from an earlier turn.
    let numbers = null;
    try {
      const st = await (await fetch(`${base}/api/panel`, { signal: AbortSignal.timeout(5000) })).json();
      numbers = {
        contacted_ever: st.contacted ?? null, waiting_on_you: st.waiting ?? null, pending_verdicts: st.pending ?? null,
        no_campaign: st.general ?? null,
        campaigns: (st.campaigns ?? []).map((c) => ({ id: c.id, status: c.status, ...(c.numbers ?? {}) })),
      };
    } catch { /* the deck alone is still worth having */ }
    const card = (c, onScreen) => ({
      id: c.id, kind: c.kind ?? null, question: short(c.question, 140), eyebrow: c.eyebrow ?? null,
      button: c.primary?.label ?? null,
      ...(c.tabs?.length ? { drafts: c.tabs.length, drafted: "already written, in three styles, on the card — the operator edits and inserts; nobody needs to draft it again" } : {}),
      // The drafts' own words ride only for the card on screen — enough to
      // say which tab and why, without quoting the whole round every turn.
      ...(onScreen && c.tabs?.length ? { tabs: c.tabs.map((t) => ({ tab: t.label ?? t.id, text: short(t.value, 260) })) } : {}),
      ...(c.help ? { help: short(c.help, 200) } : {}),
    });
    return {
      showing: cards?.[0]?.id ?? null,
      cards: (cards ?? []).slice(0, limit).map((c, i) => card(c, i === 0)),
      ...(cards?.length > limit ? { more: cards.length - limit } : {}),
      running: (jobs ?? []).map((j) => j.label),
      tasks: (tasks ?? []).map((t) => `${t.title}: ${t.status}`),
      ...(numbers ? { numbers } : {}),
    };
  } catch (e) {
    return `could not read the deck: ${e.message}`;
  }
}

/** What every turn is shown first. The doctrine says "read the deck before
 *  advising"; a model on a free seat does not always do what the doctrine
 *  says, so the deck rides in front of the message and the tool stays for
 *  the second look. Nothing when there is no dashboard. */
async function deckPreface() {
  const deck = await deckSnapshot();
  if (typeof deck === "string") return "";
  return `The operator's deck right now — the cards as the panel shows them, first one on screen; the button named on each is the one that exists:\n${JSON.stringify(deck)}\n\n`;
}

/* ----------------------------------------------------------- the browser */

/** One lease per turn, opened on the first navigate and released when the
 *  turn ends (see `turn`). Read-only by grant: the lane refuses anything
 *  else before the extension hears of it. */
const CMO_GRANTS = ["read"];
const turnLeases = new Map();   // dir → { id, tabId, url } while a turn holds a tab

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
    const C = runtimeOf(dir).control;
    if (!C) return "no browser lane here — the control broker is not attached";
    if (!TOOLKIT[name]) return `${name} is not in the toolkit`;
    if (!turnLeases.get(dir)) {
      const url = name === "navigate" && /^https?:\/\//i.test(String(input?.url ?? "")) ? input.url : null;
      if (!url) return "no tab open — navigate to an http(s) url first";
      const r = await C.lease({ task: "your specialist", url, project: dir });
      if (r.error) return `could not open a tab: ${r.error}`;
      turnLeases.set(dir, { id: r.id, tabId: r.tabId, url });
      return JSON.stringify({ opened: true, url, tabId: r.tabId, note: "the page is loaded; read it with read_page or get_page_text" });
    }
    let out = await C.act(turnLeases.get(dir).id, name, input ?? {}, { grants: CMO_GRANTS });
    if (name === "computer" && input?.action === "screenshot" && out?.screenshot) out = { ok: true, width: out.width, height: out.height, note: "taken; screenshots are for the operator's cards, you read the tree" };
    return JSON.stringify(out ?? {}).slice(0, 80_000);
  }, { name, description, schema }));
}

async function releaseTurnLease(dir) {
  const l = turnLeases.get(dir);
  turnLeases.delete(dir);
  const C = runtimeOf(dir).control;
  if (l && C) { try { await C.release(l.id); } catch { /* the tab is gone either way */ } }
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
- Nothing posts to any platform from this machine, ever. The operator reads
  every draft in the platform's own composer and presses the platform's own
  button.
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
  you can get wrong, and the operator acts on it. A count is answered from
  the numbers in front of you in THIS message (the deck's "numbers") or from
  status / campaigns called in this turn — never carried over from an
  earlier answer; "sent" and "contacted" are counted there, and 0 is a
  claim like any other.
- The operator has a panel, not a terminal. Never tell them to run a
  command: when a verb is the right move, propose deals the button; when a
  setting is, name the tab (Settings, Campaigns, Rooms) it lives on.
- Buttons come from the deck. When you tell the operator what to press,
  name the button the deck tool showed on that card, in its own words;
  never invent one. A reply card already carries its three drafts: do not
  offer to write one — say which tab you would send, and why.
- You answer on a small panel, as plain text: short sentences, a blank line
  between points, no headings, no markdown, no tables. Lead with the answer;
  say what you would do and why in a few lines, not a report — under 120
  words unless the operator asked for more.
- The five memory files are the operator's to edit. Propose; never pretend
  you saved. AGENTS.md is yours: write_notebook what is durable.
- Setup is the deck's: on a fresh directory it already asks the account, the
  site, the voice habits, the proof-read and the first room, one card at a
  time. Do not duplicate those with ask_person. Read the deck; when setup is
  done, propose the first task — the search on the platform they chose, in
  their own browser.
- A CAMPAIGN is a direction, never a template (lib/campaigns.mjs). When the
  operator describes a tactic, an angle, a different tone for a platform,
  or a different disclosure rule, shape it as one with propose_campaign:
  the idea in prose, who it fits, what it never does, whether a first
  message may name what they built — disclosed is the only lift; there is
  no undisclosed setting — and the room and phrase. It walks through their
  deck as cards with their own words allowed on each; their Save writes the
  file. Never write wording for people to paste. Read campaigns first.
- You are one project's specialist. Its memory files, store, campaigns and
  colleagues are its own; another project is another context, switched by
  the operator on the panel. Do not mix them.
- THE RETURN (0.7.0). An opener is not the product; the second and third
  replies are. A conversation opens when the operator presses "I posted
  it", is bound to their own comment by a profile read, and is read again
  from the stranger's seat by the tick. A reply reaches their deck as a
  turn card BEFORE any new person; you never draft the turn yourself and
  never propose a task for it. Tracking is the engine's and deterministic;
  you do not remember it — the day.digest event reminds you.
- MANY CAMPAIGNS AT ONCE. On a digest, answer three questions with cards or
  silence: who is waiting (already dealt — nothing to say), which campaign
  is saturated (crowding rising, second turns flat: propose_status, one
  line of why), where is the gap (propose ONE campaign aimed at a
  different group of people or kind of post, with its own direction). A
  room where every question gets a dozen generated answers on day one is
  a room to leave, not to out-shout.`;

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

const campaignsText = (dir) => {
  const all = readCampaigns(dir);
  if (!all.length) return "";
  let numbers = "";
  try {
    const S = store(dir, () => null);
    numbers = "\n\nTheir numbers, counted by the engine (found · judged · fit · sent · replied · second turns · waiting · crowding = median comments a post already had when found):\n" + digestText(campaignDigest(S, all));
    const w = waitingRows(S).length;
    if (w) numbers += `\n\n${w} conversation${w === 1 ? "" : "s"} waiting on the operator — already on their deck, ahead of any new person.`;
  } catch { /* a store that cannot be read is not a reason to lose the turn */ }
  return "This project's campaigns:\n\n" + all.map((c) => `- ${c.name} (${c.id}) — ${c.status}, mention: ${c.mention} (${MENTIONS[c.mention]?.label ?? c.mention}). ${short(c.idea, 300)}`).join("\n") + numbers;
};
const projectText = (dir) => {
  try {
    const all = listProjects(dataDir());
    const me = all.find((p) => p.dir === dir) ?? all.find((p) => p.current);
    return me ? `You are the specialist for the project “${me.name}”${all.length > 1 ? ` (one of ${all.length} on this machine — the others are not yours to advise on)` : ""}.` : "";
  } catch { return ""; }
};

async function agentFor(dir) {
  const s = seat(dir, "scout"); // the researcher seat: biggest window, tool-happy

  // The system prompt bakes in the memory files, so an agent built before
  // setup finished would keep telling the user their files are empty. The
  // cache key is what the prompt was built FROM — the seat, the persona, the
  // memory, the notebook, the campaigns, and which skills are active; when
  // any of that moves, rebuild.
  const fp = createHash("sha1").update([
    dir, s.model, personaOf(dir), memoryContext(dir), notebook(dir), campaignsText(dir), projectText(dir),
    activeSkills().map((k) => `${k.id}@${k.path}`).join(","),
    runtimeOf(dir).tasks ? "runtime" : "bare",
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
      projectText(dir),
      doctrine,
      "What you know about the operator:\n\n" + (memoryContext(dir) || "(their memory files are still empty — setup is not finished)"),
      campaignsText(dir),
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
      { messages: [{ role: "user", content: (await deckPreface()) + String(content).slice(0, 12_000) }] },
      { configurable: { thread_id: `mq:${thread}` }, recursionLimit: 40 },
    );
    const last = result.messages?.[result.messages.length - 1];
    return contentText(last?.content);
  } finally {
    await releaseTurnLease(dir);
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

const REACT_TO = new Set(["setup.done", "campaign.created", "campaign.status", "task.done", "task.failed", "task.blocked", "task.cancelled", "person.answered", "proposal.accepted", "proposal.dismissed", "call.refused", "grant.needed", "click.refused", "reply.waiting", "day.digest"]);

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
    const T = runtimeOf(dir).tasks;
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
      const made = worth.find((e) => e.type === "campaign.created");
      const dayDigest = worth.filter((e) => e.type === "day.digest").pop();
      const replies = worth.filter((e) => e.type === "reply.waiting");
      const ask = dayDigest
        ? `The day's digest is in — the numbers per campaign are in the event below, counted by the engine, never by you. Three questions, answered only with cards or with silence: (1) who is waiting — the turn cards are already on the operator's deck, so say nothing about them; (2) which campaign is saturated — crowding rising, fit falling, second turns flat, or a room whose question everybody's bots now answer on day one: propose pausing or finishing it with propose_status, one plain line of why; (3) where is the gap — a kind of person or a kind of post nobody is answering yet, in a room you have reason to believe in: propose ONE new campaign with propose_campaign, aimed at a different group of people or a different kind of post, with its own direction. At most one proposal per digest, and "noted" when the campaigns are simply working.${replies.length ? ` Also: ${replies.length} ${replies.length === 1 ? "person" : "people"} wrote back since you last looked; their turn cards are dealt.` : ""}`
        : replies.length && !setup && !made
          ? `${replies.length === 1 ? "Somebody" : `${replies.length} people`} wrote back. The turn card is already on the operator's deck, ahead of any new person, and it offers to write the reply — do not propose a draft, a task or a search for it. Say nothing, unless several are waiting and the oldest is going cold; then one notify naming who.`
          : setup
        ? `Setup is done: ${setup.title}. Propose the first task now, with propose_tasks — one card: agent "${setup.sources?.[0]?.platform ?? "reddit"}" (the platform's colleague), the room and phrase the operator chose (their search URL is the input url: ${JSON.stringify(setup.sources ?? [])}), the reason on the card in one or two plain sentences. Do not answer "noted" to this one, and do not start anything yourself.`
        : made
          ? `The operator saved a campaign: ${made.title}. Its room is being probed in their browser now, so do not propose that search. Read campaigns, then write one short notify — what the campaign will do and what happens next (the probe, the judge, the watch card) — in two plain sentences. Nothing else.`
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
