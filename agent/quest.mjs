// Quest — the customer's agent, as a seat of its own (Stage 2 of the Quest
// plan, 2026-09-19). It was the customer-facing half of agent/strategist.mjs;
// it moved here so the same seat runs in two places: the operator's own
// `mq serve` (strategist.mjs still takes its turns there, on the SQLite
// thread) and the quest Edge Function on Supabase, where there is no Node, no
// disk and no SQLite — only the engine's memory host (lib/fs-memory.mjs),
// loaded from the database for one turn and written back after it.
//
// So nothing in here touches node:* or the checkpointer. Files go through the
// door (lib/fs.mjs), the browser's state arrives as `lane` (anything with an
// attached() — the local broker, or the cloud's worker record), and a turn's
// memory is either a saver the caller hands in or the transcript itself
// (historyOf): the last things said in the chat, which is all a customer can
// see and so all Quest needs to remember between turns on the server.

import { createDeepAgent } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, join, sha256 } from "../lib/fs.mjs";
import { seat } from "../lib/models.mjs";
import { memoryContext, readOne } from "../lib/memory.mjs";
import { patchStash, readStash } from "../lib/cards.mjs";
import { clockText } from "../lib/clock.mjs";
import { store } from "../lib/store.mjs";
import { customerOf, writeCustomer, siteOf, say, setCard, chatState } from "../lib/chat.mjs";
import { offerLine, lookLine } from "../lib/quest.mjs";
import { applyRevision } from "../lib/revise.mjs";
import { labelsOf, preferred } from "../lib/platform.mjs";

/** When what was due was last actually read — the store's own record
 *  (reads.jsonl), never a memory. */
export const lastReadAt = (dir) => {
  try {
    const rows = store(dir, () => null).readJsonl("reads.jsonl");
    return rows.length ? rows[rows.length - 1]?.at ?? null : null;
  } catch { return null; }
};

/** Its notebook for this customer (AGENTS.md) — standing instructions and what it learned. */
export const notebook = (dir) => { const p = join(dir, "AGENTS.md"); return existsSync(p) ? readFileSync(p, "utf8").trim() : ""; };

/* ------------------------------------------------------------------ Quest */

// Stage 1 of the Quest plan (2026-09-18): the same seat, facing a CUSTOMER.
// A project with a customer.json (lib/chat.mjs) belongs to somebody who
// pasted what they sell on the front page. The person on the other end is
// them, not the operator, and everything the seat says reaches them through
// the transcript — the one channel, which the web chat reads today and email
// or Telegram read later. The operator's deck, campaigns, colleagues and
// memory-file etiquette are the operator's business; none of it is in here.

export const QUEST_PERSONA = `You are Quest, from Messaging Quest. You work for one person: the customer in this chat. They built something — a product, a service, a portfolio — and they need the people who already want it. Your whole job is to find those people for them, show why each one fits, and hand them a reply they can post themselves.`;

export const questDoctrine = `
How you work, non-negotiable:
- The customer is a builder, not a marketer. Talk like a sharp colleague in a chat: plain words, short messages, no jargon. Say "people", "posts", "communities" — never "leads", "ICP", "funnel" or "campaign". Do not describe your own machinery (models, tools, browsers, agents); describe what you are doing for them.
- You find, you judge, you draft. THEY post. You never post, comment, message or email anyone for them, and you never ask for a password, a login or access to any account of theirs. If they ask you to post for them, say plainly that you don't: they read the reply, change what they like, and press the button themselves.
- The flow, in order. (1) Their site is read by itself as soon as they sign up — not by you — and what was understood arrives in this chat as a card: what it is, the problem, where you will look first. They press Looks right, or tell you what to change; revise_offer replaces the card with a corrected one. (2) Once they confirm, each community is checked by itself — its rules first (one that forbids promotion is skipped), then its recent posts — and the ones where real people ask for this are watched a few times a day. (3) Every person who fits arrives in this chat as an opportunity card by itself: their words, why it fits, a reply they could post, the link, and buttons. You do not post those cards; you talk about them — why one fits, what to change in a reply, where else to look (revise_offer with more communities, or people to leave out). When they want a reply changed — shorter, warmer, less promotional — call rewrite_reply with their words; never write the new reply yourself, the writer does it and it replaces the old one on the card in a minute or two. Card numbers are for your tool calls only — never say one to them.
- Their site: when they give you its address — or a corrected one — use set_site, and it is read by itself. No site (a freelancer, a consultant, a service), or one that could not be opened: ask for a sentence or two about what they sell and who buys it, then describe_offer. A CV they uploaded is read by itself too. Never read their site yourself, never ask them to confirm the card in words (the button is on it), and never guess what a site says from its name. The line "Where things stand" at the top of every message says what is happening; trust it.
- Honesty about time. Every page is read the way a person reads it, one at a time, so a first look takes minutes and results arrive over hours. Never promise "real time", "instantly" or "24/7". When you start something that takes a while, say what happens next and that you will come back here with it.
- Never invent a person, a post, a quote, a number or a result. If you have not found anyone yet, say so.
- A reply you draft may mention what they built — always openly as theirs ("I built…", "we make…") and only when it genuinely helps the person asking. Never a hidden plug, never pretending to be a happy customer.
- Who to leave out and which communities to add is applied for you before you see their message; a line beginning "Already done" says what, and they have been told — never do it again or repeat it. Anything else they want remembered (tone, wording, what matters to them): write it into your notebook (write_notebook) and say in one line what changed. You cannot hide, delete, un-mark or re-judge a card or a reply, and you never say you did.
- THE CLOCK. Every message you RECEIVE opens with the local time and how long ago things happened. That line is for you, not for them: never start a reply with the date or the time, and never mention a time zone unless they ask. When time matters, say "three hours ago", not "recently"; never guess a time and never carry one over from an earlier turn.
- Every message you receive says whether your research browser is connected. It is not the customer's and it is not their problem: when it is down, never mention it — no "browser", no "connection", no "machine" — and never ask them to open, install or connect anything. Say "It's in the queue — I'll post what I find right here", and do what needs no page.
- WAKING UP BY YOURSELF. Some turns are nobody asking. Speak up (notify) only when there is something worth their attention; otherwise answer with the single word "noted".
- Nothing is charged now and no price has been set — say exactly that if asked. Email and Telegram are coming; for now everything arrives in this chat.
- Answer as plain chat text: no headings, no tables, no markdown emphasis. Lead with the answer. Under 90 words unless they asked for more.`;

/** Who Quest is, for one customer: stable between turns, like the operator's
 *  prompt, and for the same reason — it is also the agent's cache key. What
 *  moves (the clock, the browser, the customer's own line) rides in front of
 *  the message instead (questPreface). */
export function questPromptOf(dir) {
  const nb = notebook(dir);
  const rule = readOne(dir, "rule.md");
  return [
    QUEST_PERSONA,
    questDoctrine,
    "What you know about what they sell:\n\n" + (memoryContext(dir) || "(nothing yet — you have not read their site)"),
    rule?.filled ? "Who counts as a fit for them (rule.md — the judge reads exactly this):\n\n" + rule.body.trim() : "",
    nb ? "Your notebook (AGENTS.md):\n\n" + nb : "Your notebook (AGENTS.md) is empty. Write down what this customer tells you about who to find and who to leave out.",
  ].filter(Boolean).join("\n\n");
}

/** The browser in a sentence, as Quest must hear it: the customer can do
 *  nothing about it, so the fix is never theirs to be told. */
const questLaneLine = (C) => {
  if (!C || typeof C.attached !== "function") return "Your research browser: there is none on this host — no page can be read.";
  if (!C.attached()) return "Your research browser: NOT CONNECTED right now, so nothing is being read. The customer can do nothing about it and must not hear about it: never mention a browser, a connection, a machine or \"the house\", and never ask them to open, install or connect anything — even if you said something like that earlier in this conversation. If they are waiting on a read, say something like \"It's in the queue — I'll post what I find right here\" — and still answer everything else they asked (a community they want added goes in your notebook until the card exists, then into revise_offer).";
  return "Your research browser: connected — the reads run on their own; you never open pages yourself.";
};

/** Is the site being read right now? The job itself lives in the engine's
 *  memory; the stash keeps when the engine started it, and a read that has
 *  neither finished nor failed inside twenty minutes is not "running". */
export const readingSite = (s) => Boolean(s.scout_at && !s.offer && !s.scout_gaveup && !s.scout_empty && Date.now() - Date.parse(s.scout_at) < 20 * 60_000);

export async function questPreface(dir, { wokeBy = null, lane = null } = {}) {
  const s = readStash(dir);
  const c = customerOf(dir) ?? {};
  return [
    clockText({ who: "the customer", operatorAt: s.operator_at ?? null, heartbeatAt: s.heartbeat_at ?? null, tickAt: lastReadAt(dir), wokeBy }),
    questLaneLine(lane),
    `The customer: ${c.email ?? "(no email given)"}. Their site: ${c.url ?? "not given yet"}.`,
    `Where things stand: ${offerLine({ offer: s.offer ?? null, scout: readingSite(s) ? "running" : "none", url: c.url ?? null, attempts: Number(s.scout_tries) || 0, material: c.url ? null : c.cv ? "cv" : c.about ? "about" : null, empty: Boolean(s.scout_empty) })}`,
    lookLine(s.look, { room: roomLabel(dir) }),
    foundLine(dir),
  ].filter(Boolean).join("\n\n") + "\n\n";
}

/** The opportunities so far, counted off the transcript — the cards are the
 *  record, so the count cannot drift from what the customer was shown. */
const foundLine = (dir) => {
  const posted = chatState(dir, { limit: Infinity }).messages.filter((m) => m.card?.kind === "opportunity");
  if (!posted.length) return "";
  const cards = posted.map((m) => m.card);
  const n = (f) => cards.filter(f).length;
  const last = cards[cards.length - 1];
  const numbered = posted.slice(-5).map((m) => `#${m.id} ${m.card.room}: "${String(m.card.title || m.card.quote || "").slice(0, 60)}"`).join("; ");
  return `Opportunities so far: ${cards.length} posted in the chat (${n((c) => c.rating === "good")} marked relevant, ${n((c) => c.rating === "bad")} not relevant, ${n((c) => c.state === "replied")} replied to, ${n((c) => c.opened_at)} opened). They are cards in the chat already — never paste one again. The latest: "${String(last.title || last.quote || "").slice(0, 120)}" in ${last.room}. Card numbers, for rewrite_reply: ${numbered}.`;
};

/** What the platform's people call a community ("r/saas"), for a card. */
const roomLabel = (dir) => (p) => labelsOf(preferred(readStash(dir).platform)).room(p);

/** What a customer has been told about, in the few things they can see: how
 *  many people were posted, whether their offer is confirmed, whether their
 *  site said nothing. If this has not moved since Quest last spoke up on its
 *  own, there is nothing new to say — however the model feels about it. */
export const newsOf = (dir) => {
  const s = readStash(dir);
  const people = chatState(dir, { limit: Infinity }).messages.filter((m) => m.card?.kind === "opportunity").length;
  return JSON.stringify([people, s.offer?.state ?? null, Boolean(s.scout_empty)]);
};

/** Quest's hands: say something in the chat, keep a notebook, set their site,
 *  correct the card, write a reply again. Everything else the
 *  operator's seat holds — the deck, campaigns, colleagues, the CLI's verbs,
 *  the browser — is left out on purpose; the search and the opportunities arrive as tools of their own. */
export const questTools = (dir) => [
  tool(async ({ text }) => {
    const t = String(text ?? "").trim().slice(0, 1500);
    if (!t) return "nothing to say";
    // Measured 2026-09-18: the heartbeat, told never to report that nothing
    // changed, posted "still waiting, no new matches" two hours later. A rule
    // in a prompt is a request; this is the rule.
    const news = newsOf(dir);
    if (readStash(dir).cmo_note?.news === news) return "nothing has changed since you last spoke up — they already know. Say nothing more: answer with the single word \"noted\".";
    say(dir, t);
    // The same stamp the operator's note leaves, so a heartbeat that spoke
    // is never counted as a silent one (dealt, below).
    patchStash(dir, { cmo_note: { text: t.slice(0, 700), at: new Date().toISOString(), news } });
    return "said — it is in the customer's chat now";
  }, {
    name: "notify",
    description: "Say something to the customer in their chat without being asked — something you found, something that changed. Lead with the fact; a sentence or two. Use it sparingly: silence means you are working. Your reply to a message they sent is already shown to them; never repeat it through here.",
    schema: z.object({ text: z.string() }),
  }),
  tool(async () => notebook(dir) || "(empty — nothing written yet)", {
    name: "read_notebook",
    description: "Your notebook for this customer (AGENTS.md): who they want found, who to leave out, where not to look, what you learned. It is in your prompt already; read it here when you are about to rewrite it.",
    schema: z.object({}),
  }),
  tool(async ({ text }) => {
    const body = String(text ?? "").replace(/\r\n/g, "\n").trim().slice(0, 8000);
    writeFileSync(join(dir, "AGENTS.md"), body + "\n");
    return `written — ${body.length} characters. It loads into your prompt from the next turn.`;
  }, {
    name: "write_notebook",
    description: "Rewrite your notebook for this customer in full (at most 8000 characters): their instructions about who to find and who to leave out, communities to avoid, what worked. Keep it to what is durable.",
    schema: z.object({ text: z.string() }),
  }),

  /* ---- the offer: their site's address, and the card's corrections. */
  tool(async ({ url }) => {
    const u = siteOf(url);
    if (!u) return "that is not a web address — ask them for their site's address, like acme.com";
    if (readStash(dir).offer) return "their site was already read and answered on a card — to change what it says, use revise_offer";
    writeCustomer(dir, { url: u });
    patchStash(dir, { scoutJob: null, scout_tries: null, scout_gaveup: null, scout_at: null, scout_empty: null });
    return `set — ${u} is read by itself within a minute or two (sooner if nothing else is being read), and the card arrives in the chat. Tell them it is on its way; do not read it yourself.`;
  }, {
    name: "set_site",
    description: "Record THEIR OWN site's address — when they give it to you, or a corrected one after it could not be opened. It is then read by itself and what was understood arrives in the chat as a card. Never for a competitor's site or an example they mention.",
    schema: z.object({ url: z.string().describe("Their site, e.g. acme.com or https://acme.com/product") }),
  }),
  tool(async ({ text }) => {
    const t = String(text ?? "").trim().slice(0, 4000);
    if (t.length < 20) return "too short to work from — ask for a sentence or two: what it is, and who buys it";
    if (readStash(dir).offer) return "what they sell is already on a card — to change it, use revise_offer";
    // Their words win over a site that could not be opened: the read then
    // works from what they said, with no browser at all.
    writeCustomer(dir, { about: t, url: null });
    patchStash(dir, { scoutJob: null, scout_tries: null, scout_gaveup: null, scout_at: null, scout_empty: null });
    return "set — it is read by itself in a few seconds and the card arrives in the chat. Tell them it is on its way.";
  }, {
    name: "describe_offer",
    description: "When they have no site, or it could not be opened, record what they sell in their own words — what it is, who buys it, the problem it solves. Their description is then read by itself and a card arrives in the chat, the same as for a site. Pass their words, lightly joined up; do not invent anything.",
    schema: z.object({ text: z.string().describe("What they sell and who buys it, in their words") }),
  }),
  tool(async ({ note, card }) => {
    const n = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (!n) return "what should change? ask them in a few words";
    const cards = chatState(dir, { limit: Infinity }).messages.filter((m) => m.card?.kind === "opportunity" && m.card.state !== "dismissed" && (m.card.draft || m.card.no_draft || m.card.rewriting));
    const target = card ? cards.find((m) => m.id === Number(card)) : cards[cards.length - 1];
    if (!target) return card ? "there is no such reply — the numbers are in \"Opportunities so far\"" : "there is no reply to rewrite yet";
    if (target.card.rewriting) return "that reply is already being rewritten — say the new one is on its way";
    setCard(dir, target.id, { rewriting: { note: n, style: null, at: new Date().toISOString() }, draft: null, drafts: null, no_draft: null });
    return "done — the reply is being written again with their note and replaces the old one on its card in a minute or two. Say exactly that in one line (it is being rewritten — not that it is done); never mention card numbers, they are for your tool calls only; do not write the reply yourself.";
  }, {
    name: "rewrite_reply",
    description: "When they ask to change a reply you drafted — shorter, less promotional, warmer, mention something — write it again with their note. The card's three replies are replaced by three new ones. Defaults to the latest reply; pass the card's number for an older one. Never write the new reply yourself.",
    schema: z.object({
      note: z.string().describe("What should change, in their words: 'shorter, and not salesy'"),
      card: z.number().optional().describe("The card's number from \"Opportunities so far\", when they mean an older one"),
    }),
  }),
  tool(async ({ one_line, problem, signals, searches, places, leave_out }) => {
    return applyRevision(dir, { one_line, problem, signals, searches, places, leave_out }, { room: roomLabel(dir) }).said;
  }, {
    name: "revise_offer",
    description: "Correct the card that says what they sell: the one-line description, the problem people describe, what those people do in a post (signals), the short phrases searched for, the communities to look in (bare names, e.g. saas), and who to leave out (e.g. agencies, students). Pass only what they asked to change. Before they confirm, it replaces the card with a corrected one; after, who to leave out takes effect at once, and new communities are searched with the phrases as they stand.",
    schema: z.object({
      one_line: z.string().optional().describe("What it is and who it is for, in one plain sentence"),
      problem: z.string().optional().describe("The problem in the words of somebody who has it, one short sentence"),
      signals: z.array(z.string()).optional().describe("What a person does in a post when they need it, each under 10 words, starting with a verb: 'ask for a scheduling tool'"),
      searches: z.array(z.string()).optional().describe("2 to 4 search phrases of 2 to 4 plain words: 'calendly alternative'"),
      places: z.array(z.string()).optional().describe("Communities to look in, bare names"),
      leave_out: z.array(z.string()).optional().describe("Kinds of people to leave out, in their words"),
    }),
  }),
  // No browser tools: every read Quest's customer needs runs as an engine
  // step on the lane — the site read, the community checks, the watching —
  // so a second reader in the chat would only open a second tab in the
  // operator's Chrome to read the same page.
];

/* ------------------------------------------------------------- the seat */

/**
 * OpenRouter can answer 200 with an error object in the body when the
 * upstream provider failed after headers went out — "Upstream error from
 * Nvidia: Service temporarily overloaded", measured 2026-09-07, the free
 * plan's ordinary weather. The engine's own client (lib/llm.mjs) reads that
 * and asks again; the OpenAI client under LangChain does not, reads
 * choices[0].message of nothing, and the turn dies on a TypeError with the
 * provider's sentence lost. Re-labelled with the error's own status, the
 * client retries it like any other 5xx, and with the seat's fallback list
 * on the request OpenRouter itself moves to the next provider.
 */
export const openRouterFetch = async (url, init) => {
  const res = await fetch(url, init);
  if (res.status !== 200 || !/json/i.test(res.headers.get("content-type") ?? "")) return res;
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const err = body && body.error && !body.choices ? body.error : null;
  const code = Number(err?.code);
  const status = err ? (code >= 400 && code < 600 ? code : 502) : res.status;
  return new Response(text, { status, statusText: err ? String(err.message ?? "upstream error").slice(0, 200) : res.statusText, headers: res.headers });
};


export const contentText = (c) => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return String(c ?? "");
};


/** The same wake, facing a customer: there is no deck to read and nothing to
 *  propose — only whether they should hear something now. */
export const QUEST_HEARTBEAT_ASK = `Nobody asked — this is your heartbeat. The customer is not talking to you right now.

If there is something they should hear — someone you found, something that changed — say it with notify, in a sentence or two. Otherwise answer with the single word "noted" and spend nothing. Never tell them that nothing happened, and never repeat something you already said. The only count of people found is the "Opportunities so far" line above — the cards they can see; a post read or judged is not a person found.`;

/** …and the mail: events arrived while Quest was idle. */
export const QUEST_MAIL_ASK = `React only if the customer should hear about it — say it with notify, in a sentence or two, in plain words — otherwise reply with the single word "noted".`;

/** The model Quest thinks with: the researcher seat (lib/models.mjs), the
 *  same one the operator's CMO uses — biggest window, tool-happy. */
export function questModel(dir) {
  const s = seat(dir, "scout");
  return new ChatOpenAI({
    model: s.model,
    apiKey: s.key,
    configuration: { baseURL: s.baseUrl, ...(s.openrouter === false ? {} : { fetch: openRouterFetch }) },
    maxTokens: s.maxTokens,
    timeout: s.timeoutMs,
    maxRetries: 3,
    // The seat's fallback list — OpenRouter's model-level `models:` array —
    // so a provider that is full for a minute costs a minute, not the turn.
    ...(Array.isArray(s.models) && s.models.length > 1 ? { modelKwargs: { models: s.models } } : {}),
  });
}

/** One agent per customer directory, rebuilt when what it is told changes
 *  (the prompt is its own cache key, as in strategist.mjs agentFor). */
const agents = new Map();
export function questAgent(dir, { saver = null } = {}) {
  const s = seat(dir, "scout");
  const systemPrompt = questPromptOf(dir);
  const fp = sha256([dir, s.model, systemPrompt, saver ? "saver" : "bare"].join("\x00"));
  if (agents.get(dir)?.fp === fp) return agents.get(dir).agent;
  const agent = createDeepAgent({ model: questModel(dir), tools: questTools(dir), systemPrompt, ...(saver ? { checkpointer: saver } : {}) });
  agents.set(dir, { fp, agent });
  return agent;
}

/**
 * The conversation so far, as the model is shown it when there is no saver
 * holding the thread: what the customer said and what Quest said back, in
 * order, the newest last — cards are left out (the turn's own preface counts
 * them and names the latest, from the same transcript). `before` leaves out
 * the message being answered, which arrives as the turn itself.
 */
export function historyOf(dir, { before = Infinity, limit = 16, chars = 6000 } = {}) {
  const rows = chatState(dir, { limit: Infinity }).messages
    .filter((m) => m.id < before && !m.card && !m.error && (m.from === "you" || m.from === "quest") && String(m.text ?? "").trim())
    .slice(-limit);
  const out = [];
  for (const m of rows) {
    const role = m.from === "you" ? "user" : "assistant";
    const text = String(m.text).trim();
    const last = out[out.length - 1];
    if (last?.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  // The newest words matter most: trim from the front until it fits, and
  // never open on Quest's side — a model shown its own reply first has lost
  // what it was replying to.
  while (out.length && out.reduce((n, m) => n + m.content.length, 0) > chars) out.shift();
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/**
 * One turn. `content` is what they said (or the heartbeat's ask); the clock,
 * the browser's line and where things stand ride in front of it, as they do
 * locally. With a `saver` the thread lives on it (`thread` names it); without
 * one the transcript is the memory (`history`, from historyOf).
 */
export async function questTurn(dir, content, { history = [], wokeBy = null, note = "", lane = null, saver = null, thread = "chat", signal = null } = {}) {
  const agent = questAgent(dir, { saver });
  const said = (await questPreface(dir, { wokeBy, lane })) + (note ? `${note}\n\n` : "") + String(content).slice(0, 12_000);
  const result = await agent.invoke(
    { messages: [...(saver ? [] : history), { role: "user", content: said }] },
    // `signal` bounds the whole turn — the cloud's function has a wall clock.
    { ...(saver ? { configurable: { thread_id: `mq:${thread}` } } : {}), recursionLimit: 40, ...(signal ? { signal } : {}) },
  );
  const last = result.messages?.[result.messages.length - 1];
  return contentText(last?.content);
}
