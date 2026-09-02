// Where the models run, and what each seat costs.
//
// Three roles, and they are not the same job:
//
//   judge   runs on EVERY item every source returns. A binary question against
//           a rubric. High volume, cheap, and a flash model is genuinely good
//           enough at "does this person have the problem, yes or no".
//   scout   runs ONCE per project. Reads your website and proposes the three
//           files every later verdict is judged by. Getting this wrong is
//           expensive for months, so it is not the place to save a cent.
//   writer  runs once per reply, and the output goes out under your name.
//
// Spending the same model on all three is the mistake in both directions at
// once: a flash model writing your replies, or a frontier model asked ten
// thousand times whether a post is a fit.
//
// THREE PLANS (2026-09-01). The seats used to have one address — OpenRouter,
// with a key and a bill. That is still the measured default, and now one of
// three ways to fill a seat:
//
//   paid   OpenRouter, the models below, cents per hundred verdicts.
//   free   OpenRouter's free variants (ids ending in :free). Same key, no
//          bill. The platform's limits, read off its docs 2026-09-01: 20
//          requests a minute and 50 a day, or 1,000 a day once the account
//          has ever bought $10 of credit. Providers fill up — a 429 from
//          upstream is ordinary here, which is what the fallback list is for.
//   local  An OpenAI-compatible server on this machine — Ollama by default,
//          LM Studio, llama.cpp, vLLM by address. No key, no bill, nothing
//          leaves the machine. Minutes per batch on a CPU, not seconds.
//
// The plan is one field in <dir>/models.json (or MQ_PLAN in the environment);
// each plan keeps its own picks, so switching to free for a month and back
// does not lose the paid ones. Nothing above this file changes with the plan:
// lib/llm.mjs speaks chat completions to whatever address the seat names.
//
// Prices are per MILLION tokens, read off OpenRouter's own /api/v1/models on
// 2026-08-30. They are here so /settings can show what a choice costs before
// it is made, and they carry the date for the same reason every measurement
// in skills/reddit/feed.mjs does: this is the kind of number that is wrong
// later in a way nobody notices.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const BASE_URL = "https://openrouter.ai/api/v1";
/** Ollama's OpenAI-compatible endpoint. LM Studio is :1234/v1, llama.cpp's
 *  server :8080/v1, vLLM :8000/v1 — same protocol, different port. */
export const LOCAL_URL = "http://127.0.0.1:11434/v1";

/* ---------------------------------------------------------------- the menu */

/** @type {Record<string, {id:string,label:string,in:number,out:number,ctx:number,note:string}>} */
export const MODELS = {
  "z-ai/glm-5.3-flash": {
    id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash",
    in: 0.075, out: 0.25, ctx: 1_310_720,
    reasons: true,
    note: "Cheap per token, but reasoning is mandatory on this endpoint — 13s and 274 reasoning tokens for a two-item verdict, measured. Not the volume model it looks like.",
  },
  "z-ai/glm-5.3": {
    id: "z-ai/glm-5.3", label: "GLM 5.3",
    in: 1.40, out: 4.40, ctx: 1_310_720,
    note: "Balanced. Reads a site well without a frontier bill.",
  },
  "moonshotai/kimi-k3": {
    id: "moonshotai/kimi-k3", label: "Kimi K3",
    in: 3.00, out: 15.00, ctx: 1_048_576,
    note: "The writer. Prose that does not read like a template.",
  },
  "deepseek/deepseek-v4-flash-0731": {
    id: "deepseek/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash",
    in: 0.065, out: 0.18, ctx: 1_310_720,
    note: "The volume model. Zero reasoning tokens, 2.0s and $0.00002 for a two-item verdict — measured against the others below.",
  },
  "deepseek/deepseek-v4-pro-0813": {
    id: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro",
    in: 0.66, out: 1.98, ctx: 1_048_576,
    note: "A third of GLM 5.3's price for reading and reasoning.",
  },
  "qwen/qwen3.8-flash": {
    id: "qwen/qwen3.8-flash", label: "Qwen 3.8 Flash",
    in: 0.15, out: 0.47, ctx: 1_000_000,
    note: "Another volume option, if GLM is having a bad day.",
  },
  "qwen/qwen3.8-2.4t-a95b": {
    id: "qwen/qwen3.8-2.4t-a95b", label: "Qwen 3.8 (2.4T)",
    in: 2.00, out: 6.00, ctx: 1_048_576,
    note: "Large, and good at following a long instruction exactly.",
  },
  "qwen/qwen3.7-flash": {
    id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash",
    in: 0.03, out: 0.13, ctx: 1_000_000,
    note: "The floor. Use it when you are judging thousands.",
  },
};

/**
 * The free variants, measured 2026-09-01: every free model on OpenRouter that
 * accepts a tool call was asked the judge's own two-item verdict, same forced
 * tool schema as lib/agents.mjs, once each (twice where the first answer was
 * a 429). Time, reasoning tokens, whether the answer conformed on the first
 * ask, and whether it agreed with the paid judge's recorded verdicts. The
 * ones that were full or refused are listed too, because the menu should say
 * why they are not the pick rather than pretend they do not exist.
 *
 *   poolside/laguna-s-2.1:free           5.2s / 4.7s     0 reasoning   conformed, agreed
 *   liquid/lfm-2.5-2.6b:free             2.3s          541 reasoning   conformed, agreed  (2.6B — the floor)
 *   inclusionai/ling-3.0-flash-fin:free  6.2s          648 reasoning   conformed, agreed
 *   openrouter/free  (→ ling 3.0)        6.2s          580 reasoning   conformed, agreed
 *   minimax/minimax-m2.7:free           14.2s          746 reasoning   conformed, agreed
 *   nvidia/nemotron-3-super-120b:free   16.9s        1,044 reasoning   conformed, agreed
 *   nvidia/nemotron-3-nano-omni:free    25.4s        1,318 reasoning   conformed, agreed
 *   nvidia/nemotron-3-ultra-550b:free   31.1s        1,914 reasoning   conformed, agreed
 *   dots-studio/dots-3-note:free        17.7s        2,006 reasoning   conformed, judged the fit a miss
 *   minimax/minimax-m3:free              5.3s            0 reasoning   answered without the verdicts array
 *   nvidia/nemotron-3.5-lightning:free   no answer in 120s
 *   google/gemma-4-31b / 26b:free        429 from Google AI Studio, both asks
 *   z-ai/glm-5.2:free                    429 from Decart, both asks
 *   poolside/laguna-xs-2.1:free          429 from Poolside, both asks
 *   thinkingmachines/inkling:free        403 — "only available on agentic harnesses"
 *
 * The other two seats, same day. The scout: the real brief and tool loop
 * against play.messaging.quest, capped at three pages, then the proposal
 * call. The writer: the real `mq draft` material for one queue item, the
 * real options schema, one call.
 *
 *   minimax/minimax-m2.7:free       scout  3 pages in 27s, proposal 14s, conformed — the best free run
 *                                   writer 3 options in 13s, none with a template phrase; one invented
 *                                          an experience, which the claims guard names
 *   nvidia/nemotron-3-super:free    scout  3 pages in 102s, proposal 18s, conformed
 *                                   "temporarily overloaded" on three of five asks that afternoon
 *   poolside/laguna-s-2.1:free      writer 3 options in 7s, generic, and story-first invented a job
 *                                   "429" on one scout ask
 *   moonshotai/kimi-k3 (paid)       writer 3 options in 34s once told to answer through the tool;
 *                                   128s and a prose answer first without that line
 *
 * A 429 or "overloaded" from a free provider is that plan's weather, not a
 * verdict on the model — which is why the free fallbacks are chosen to be
 * DIFFERENT providers. Two of them, not three: OpenRouter takes three
 * entries in the `models` list and refuses a fourth ("'models' array must
 * have 3 items or fewer", a 400 the first live judge run on this plan hit
 * on 2026-09-01 — and reported as "ok" with nothing written, which is the
 * other thing fixed that day).
 */
export const FREE_MODELS = {
  "poolside/laguna-s-2.1:free": {
    id: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (free)", in: 0, out: 0, ctx: 262_144,
    note: "The free judge. 5.2s and 4.7s for the two-item verdict, zero reasoning tokens, conformed on the first ask both times, agreed with the paid judge (2026-09-01). As the writer: 7s, generic, and its story-first option invented a job — a judge, not a writer.",
  },
  "nvidia/nemotron-3-super-120b-a12b:free": {
    id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B (free)", in: 0, out: 0, ctx: 262_144,
    note: "16.9s, 1,044 reasoning tokens, conformed, agreed (2026-09-01). As the scout: three pages and a conforming proposal in 102s + 18s — and 'temporarily overloaded' on three of five asks that afternoon. The scout's first fallback.",
  },
  "minimax/minimax-m2.7:free": {
    id: "minimax/minimax-m2.7:free", label: "MiniMax M2.7 (free)", in: 0, out: 0, ctx: 196_608,
    note: "14.2s, 746 reasoning tokens, conformed, agreed (2026-09-01). As the scout: three pages and a conforming proposal in 27s + 14s, the best free run. As the writer: three specific options in 13s, one of them claiming an experience the operator never had — which the claims guard names. The free scout and writer.",
  },
  "nvidia/nemotron-3-ultra-550b-a55b:free": {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B (free)", in: 0, out: 0, ctx: 1_000_000,
    note: "31.1s, 1,914 reasoning tokens, conformed, agreed (2026-09-01). Slow; here for the window.",
  },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano Omni 30B (free)", in: 0, out: 0, ctx: 256_000,
    note: "25.4s, 1,318 reasoning tokens, conformed, agreed (2026-09-01).",
  },
  "inclusionai/ling-3.0-flash-fin:free": {
    id: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash Fin (free)", in: 0, out: 0, ctx: 262_144,
    note: "6.2s, 648 reasoning tokens, conformed, agreed (2026-09-01). Finance-tuned, and what openrouter/free routed to on the day.",
  },
  "liquid/lfm-2.5-2.6b:free": {
    id: "liquid/lfm-2.5-2.6b:free", label: "LFM 2.5 2.6B (free)", in: 0, out: 0, ctx: 65_536,
    note: "2.3s, 541 reasoning tokens, conformed, agreed (2026-09-01) — and 2.6B parameters, so the floor: right on two easy items is not right on a hard one.",
  },
  "openrouter/free": {
    id: "openrouter/free", label: "OpenRouter free router", in: 0, out: 0, ctx: 200_000,
    note: "OpenRouter's own router over whatever is free that minute. Answered from Ling 3.0 Flash in 6.2s on 2026-09-01. The last fallback, never the pick — you do not know who judged.",
  },
  "google/gemma-4-31b-it:free": {
    id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free)", in: 0, out: 0, ctx: 262_144,
    note: "429 from Google AI Studio on both asks, 2026-09-01 — the endpoint was full. Listed because it will not always be.",
  },
  "google/gemma-4-26b-a4b-it:free": {
    id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (free)", in: 0, out: 0, ctx: 262_144,
    note: "429 from Google AI Studio on both asks, 2026-09-01.",
  },
  "z-ai/glm-5.2:free": {
    id: "z-ai/glm-5.2:free", label: "GLM 5.2 (free)", in: 0, out: 0, ctx: 256_000,
    note: "429 from Decart on both asks, 2026-09-01.",
  },
  "minimax/minimax-m3:free": {
    id: "minimax/minimax-m3:free", label: "MiniMax M3 (free)", in: 0, out: 0, ctx: 1_048_576,
    note: "Answered without the verdicts array on the first ask (2026-09-01); the retry lands, at double the wait. Not a default.",
  },
  "dots-studio/dots-3-note-preview:free": {
    id: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note (free)", in: 0, out: 0, ctx: 512_000,
    note: "17.7s, 2,006 reasoning tokens, conformed — and judged the fit item a miss (2026-09-01). Not a judge.",
  },
};

/**
 * Tags for a local server. NOT MEASURED: this project has had no machine with
 * Ollama on it to measure on, and a note that reads like a measurement without
 * being one is the thing this file exists to prevent. What IS known: sizes,
 * off ollama.com on 2026-09-01, and that the Qwen family's tool calls work
 * through Ollama's OpenAI endpoint — which the judge and writer depend on
 * (a forced tool call; lib/llm.mjs also takes the JSON out of prose when a
 * server ignores tool_choice). Measure, then replace these notes.
 */
export const LOCAL_MODELS = {
  "qwen3.5:9b": { id: "qwen3.5:9b", label: "qwen3.5:9b", in: 0, out: 0, ctx: 0, note: "6.6 GB. Fits a 16 GB machine; tool calls work. The default for every seat until a measurement says otherwise. Unmeasured." },
  "qwen3.5:27b": { id: "qwen3.5:27b", label: "qwen3.5:27b", in: 0, out: 0, ctx: 0, note: "17 GB. The step up on a 32 GB machine. Unmeasured." },
  "qwen3.6:35b": { id: "qwen3.6:35b", label: "qwen3.6:35b", in: 0, out: 0, ctx: 0, note: "23 GB, 3B active — quick for its size on a GPU. Unmeasured." },
  "gemma4:12b": { id: "gemma4:12b", label: "gemma4:12b", in: 0, out: 0, ctx: 0, note: "7.6 GB. Plainer prose at this size, if your Ollama build has a tool template for it — if not, the request is refused with 'does not support tools' and you know in a second. Unmeasured." },
  "gpt-oss:20b": { id: "gpt-oss:20b", label: "gpt-oss:20b", in: 0, out: 0, ctx: 0, note: "14 GB. Reasoning on by default, which is minutes on a CPU. Unmeasured." },
};

export const PLANS = {
  paid: {
    key: "paid", title: "Paid", needsKey: true, menu: MODELS,
    what: "OpenRouter, the measured defaults. Cents per hundred verdicts; the writer is the seat that costs.",
  },
  free: {
    key: "free", title: "Free", needsKey: true, menu: FREE_MODELS,
    what: "OpenRouter's free variants. The same key, no bill — 20 requests a minute, 50 a day (1,000 once $10 of credit was ever bought). Slower, and a provider can be full.",
  },
  local: {
    key: "local", title: "Local", needsKey: false, menu: LOCAL_MODELS,
    what: "A model on this machine — Ollama by default, or any OpenAI-compatible server by address. No key, no bill, nothing leaves the machine. Minutes per batch on a CPU.",
  },
};
const PLAN_IDS = Object.keys(PLANS);

/**
 * The roles, their defaults per plan, and what each falls back to.
 *
 * `alternates` becomes OpenRouter's model-level `models:` array — the first is
 * asked and the rest are tried in order if it errors. This matters more than it
 * looks: a `tick` that dies on one provider's `429 engine_overloaded` has spent
 * its minute-per-read budget and produced nothing. On the free plan it matters
 * twice: the upstream 429 is the ordinary case there. A local server has no
 * such field, so the local list is empty. THREE ENTRIES IN ALL: OpenRouter
 * answers a fourth with a 400, so `seat()` cuts the list there whatever is
 * written here.
 */
export const ROLES = {
  judge: {
    key: "judge",
    title: "Judge",
    what: "Decides whether each post found is somebody you should answer. Runs on everything.",
    // Chosen on a measurement rather than on the price list, after the first
    // real judge run hung. One two-item verdict, same tool schema, 2026-08-30:
    //
    //   deepseek/deepseek-v4-flash    0 reasoning tokens    2.0s   $0.000021
    //   qwen/qwen3.7-flash          146 reasoning tokens    2.9s   $0.000067
    //   z-ai/glm-5.3                214 reasoning tokens    5.8s   $0.001748
    //   z-ai/glm-5.3-flash          274 reasoning tokens   13.5s   $0.000241
    //   qwen/qwen3.8-flash          provider returned an error
    //
    // GLM 5.3 Flash was the default here and was the wrong pick: it is a third
    // of DeepSeek's price PER TOKEN and eleven times the price per verdict,
    // because reasoning is mandatory on that endpoint — OpenRouter answers
    // `reasoning: {enabled: false}` with "Reasoning is mandatory for this
    // endpoint and cannot be disabled." A cheap token you are forced to spend
    // three hundred of is not a cheap token.
    pick: {
      paid: { def: "deepseek/deepseek-v4-flash-0731", alternates: ["qwen/qwen3.7-flash", "z-ai/glm-5.3-flash"] },
      free: { def: "poolside/laguna-s-2.1:free", alternates: ["inclusionai/ling-3.0-flash-fin:free", "openrouter/free"] },
      local: { def: "qwen3.5:9b", alternates: [] },
    },
    // Generous, because a reasoning model may still be picked here and its
    // thinking comes out of the same budget as the tool call. Too small does
    // not error — it truncates mid-call and the verdicts silently never arrive.
    maxTokens: 8000,
  },
  scout: {
    key: "scout",
    title: "Scout",
    what: "Reads your website once and proposes what you sell, who it is for, and the fit rule.",
    pick: {
      paid: { def: "z-ai/glm-5.3", alternates: ["deepseek/deepseek-v4-pro-0813", "qwen/qwen3.8-2.4t-a95b"] },
      free: { def: "minimax/minimax-m2.7:free", alternates: ["nvidia/nemotron-3-super-120b-a12b:free", "poolside/laguna-s-2.1:free"] },
      local: { def: "qwen3.5:9b", alternates: [] },
    },
    maxTokens: 16384,
  },
  writer: {
    key: "writer",
    title: "Writer",
    what: "Drafts the reply, in your measured voice. Never sends it.",
    pick: {
      paid: { def: "moonshotai/kimi-k3", alternates: ["z-ai/glm-5.3", "qwen/qwen3.8-2.4t-a95b"] },
      free: { def: "minimax/minimax-m2.7:free", alternates: ["nvidia/nemotron-3-super-120b-a12b:free", "poolside/laguna-s-2.1:free"] },
      local: { def: "qwen3.5:9b", alternates: [] },
    },
    maxTokens: 8192,
  },
};

export const defaultFor = (role, p) => ROLES[role].pick[p].def;
export const alternatesFor = (role, p) => ROLES[role].pick[p].alternates;

/* ------------------------------------------------------------------ config */

const CONF = (dir) => join(dir, "models.json");
const KEYFILE = (dir) => join(dir, "openrouter.key");

/** models.json, whole. Its first shape was flat — {judge, scout, writer} —
 *  and meant OpenRouter; that still reads as the paid plan's picks, so nobody's
 *  choice of writer is lost to a file format. */
function conf(dir) {
  let raw = {};
  try { if (existsSync(CONF(dir))) raw = JSON.parse(readFileSync(CONF(dir), "utf8")) || {}; } catch { raw = {}; }
  const picks = { paid: {}, free: {}, local: {}, ...(raw.picks ?? {}) };
  for (const r of Object.keys(ROLES)) if (typeof raw[r] === "string" && !picks.paid[r]) picks.paid[r] = raw[r];
  return {
    plan: PLAN_IDS.includes(raw.plan) ? raw.plan : "paid",
    picks,
    local: {
      baseUrl: typeof raw.local?.baseUrl === "string" && raw.local.baseUrl ? raw.local.baseUrl : LOCAL_URL,
      key: typeof raw.local?.key === "string" ? raw.local.key : "",
    },
  };
}
const save = (dir, c) => writeFileSync(CONF(dir), JSON.stringify(c, null, 2) + "\n");

/** Which plan fills the seats. MQ_PLAN in the environment wins, so a script or
 *  a CI job can say "local" without touching a file. */
export function plan(dir) {
  const e = process.env.MQ_PLAN;
  if (e && PLAN_IDS.includes(e)) return e;
  return conf(dir).plan;
}

export function setPlan(dir, p) {
  if (!PLANS[p]) throw new Error(`not a plan: ${p} — paid, free or local`);
  const c = conf(dir);
  c.plan = p;
  save(dir, c);
  return p;
}

/** The local server's address and, if it insists, a key. MQ_LOCAL_URL and
 *  MQ_LOCAL_KEY override the file, same as the plan. */
export function localConfig(dir) {
  const c = conf(dir).local;
  return {
    baseUrl: (process.env.MQ_LOCAL_URL || c.baseUrl).replace(/\/+$/, ""),
    key: process.env.MQ_LOCAL_KEY ?? c.key,
  };
}

export function setLocal(dir, { baseUrl, key } = {}) {
  const c = conf(dir);
  if (baseUrl !== undefined) {
    const u = String(baseUrl).trim().replace(/\/+$/, "");
    if (!/^https?:\/\/\S+$/.test(u)) throw new Error("the server address starts with http:// or https://");
    c.local.baseUrl = u;
  }
  if (key !== undefined) c.local.key = String(key ?? "").trim();
  save(dir, c);
  return c.local;
}

/** Which model each role uses on a plan. On OpenRouter an unknown id falls
 *  back to the default rather than being passed through — a typo in
 *  models.json should not reach the provider as a 400 an hour into a tick.
 *  Locally any tag goes through as written: the server's own "model not
 *  found, try pulling it" is the honest error, and it arrives in a second. */
export function chosen(dir, p = plan(dir)) {
  const picks = conf(dir).picks[p] ?? {};
  const out = {};
  for (const r of Object.keys(ROLES)) {
    const want = typeof picks[r] === "string" ? picks[r].trim() : "";
    out[r] = p === "local" ? (want || defaultFor(r, p)) : (PLANS[p].menu[want] ? want : defaultFor(r, p));
  }
  return out;
}

export function choose(dir, role, model, p = plan(dir)) {
  if (!ROLES[role]) throw new Error(`no such role: ${role}`);
  if (!PLANS[p]) throw new Error(`not a plan: ${p}`);
  const id = String(model ?? "").trim();
  if (p === "local") { if (!id) throw new Error("a model tag is needed, e.g. qwen3.5:9b"); }
  else if (!PLANS[p].menu[id]) throw new Error(`not a model this build knows on the ${p} plan: ${id}`);
  const c = conf(dir);
  c.picks[p] = { ...c.picks[p], [role]: id };
  save(dir, c);
  return chosen(dir, p);
}

/**
 * The key. Environment first, so a shell that already exports it needs no
 * setup, and a file second, so the browser has somewhere to put one.
 *
 * `.mq/` is gitignored, which is the only reason writing it here is
 * defensible. It is your key, on your machine, for your bill.
 */
export function readKey(dir) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    if (existsSync(KEYFILE(dir))) return readFileSync(KEYFILE(dir), "utf8").trim() || null;
  } catch { /* unreadable is the same as absent */ }
  return null;
}

export function writeKey(dir, key) {
  const k = String(key ?? "").trim();
  if (!k) { try { unlinkSync(KEYFILE(dir)); } catch { /* was not there */ } return null; }
  if (!/^sk-or-/.test(k)) throw new Error("an OpenRouter key starts with sk-or-");
  writeFileSync(KEYFILE(dir), k + "\n");
  return k;
}

export const hasKey = (dir) => Boolean(readKey(dir));

/** Where the key came from, so /settings can say "set in your environment"
 *  rather than showing an empty box over a working key. */
export const keySource = (dir) =>
  process.env.OPENROUTER_API_KEY ? "env" : existsSync(KEYFILE(dir)) ? "file" : null;

/** Can a seat be filled at all? The question every screen with a model
 *  button used to ask as "is there a key" — which the local plan answers
 *  without one. */
export const hasModel = (dir) => plan(dir) === "local" || hasKey(dir);

/** What the menu knows about an id, or the bare id when it knows nothing —
 *  which on the local plan is any tag the operator typed. */
export const modelInfo = (p, id) =>
  PLANS[p]?.menu[id] ?? { id, label: id, in: 0, out: 0, ctx: 0, note: p === "local" ? "A tag this build has no note for. Pull it, measure it, write the note." : "" };

/* -------------------------------------------------------------------- seat */

/**
 * Everything lib/llm.mjs needs to make requests for one role.
 *
 * temperature 0 everywhere including the writer (set inside llm.mjs), which
 * looks wrong for prose and is not: the drafter is asked for three options that
 * differ by MOVE, and sampling noise produces three tones of one sentence
 * instead. The variety has to come from the instruction, not the temperature.
 */
export function seat(dir, role) {
  const r = ROLES[role];
  if (!r) throw new Error(`no such role: ${role}`);
  const p = plan(dir);
  const model = chosen(dir, p)[r.key];

  if (p === "local") {
    const { baseUrl, key } = localConfig(dir);
    return {
      plan: p, key, baseUrl, model,
      models: null, openrouter: false,
      maxTokens: r.maxTokens,
      // Ten minutes, because a 9B model on a CPU takes minutes for a judge
      // batch and slow is not stuck. The Stop button still works — the
      // caller's signal is honoured underneath the timeout.
      timeoutMs: 600_000,
      // No retry: a second ten-minute wait on a machine that just spent ten
      // minutes is not a recovery, it is the same afternoon twice.
      retries: 0,
    };
  }

  const key = readKey(dir);
  if (!key) throw new Error("no OpenRouter key — add one on /settings or set OPENROUTER_API_KEY (the free plan needs one too), or pick Local there and run a model on this machine");
  return {
    plan: p, key,
    baseUrl: BASE_URL,
    model,
    // OpenRouter's model-level fallback list, first entry included: a tick
    // that dies on one provider's 429 has spent its minute-a-read budget and
    // produced nothing.
    // Three entries at most — the platform's limit, measured the hard way
    // (a 400 on the first live free judge run, 2026-09-01). Cut here so a
    // longer list in ROLES degrades to fewer fallbacks, never to no verdicts.
    models: [model, ...alternatesFor(r.key, p).filter((a) => a !== model)].slice(0, 3),
    openrouter: true,
    maxTokens: r.maxTokens,
    // A timeout, because without one there is no upper bound on a job.
    //
    // The first real judge run sat at "judging 1-10 of 22" for five and a half
    // minutes with no error, no progress and nothing in the log. A request that
    // never returns is indistinguishable from one still working, so a job that
    // cannot time out cannot fail — it can only be abandoned. Two minutes is
    // well past the slowest measured paid call (13.5s) and well short of a
    // coffee; the free variants got three, because 31s was measured there.
    timeoutMs: p === "free" ? 180_000 : 120_000,
    // One retry, not two or three. Three attempts at a two-minute ceiling is a
    // six-minute silence, and the judge's batch loop already treats a failure
    // as "unjudged", which is a recoverable state and not a verdict.
    retries: 1,
  };
}

/**
 * Is anything listening at a local address, and what does it have? Zero-dep,
 * bounded, and never thrown — a dead server is a fact for the Settings page,
 * not an exception for the router.
 */
export async function probeLocal(baseUrl, timeoutMs = 2500) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `${base} answered ${res.status} to GET /models` };
    const j = await res.json();
    const models = (j.data ?? j.models ?? []).map((m) => m?.id ?? m?.name).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    const code = String(e?.cause?.code ?? e?.code ?? "");
    const why = e?.name === "TimeoutError" ? `no answer from ${base} in ${Math.round(timeoutMs / 1000)}s`
      : /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(`${code} ${e?.message}`) ? `nothing is listening at ${base} — is Ollama running?`
      : e?.message ?? String(e);
    return { ok: false, error: why };
  }
}

/* -------------------------------------------------------------------- cost */

/** Dollars, for a given role and token counts. Rough by construction — it is
 *  shown to answer "is this cents or dollars", which is the only question
 *  anybody actually has before clicking. Zero off the paid plan, exactly. */
export function cost(dir, role, inTokens, outTokens) {
  const p = plan(dir);
  if (p !== "paid") return 0;
  const m = MODELS[chosen(dir, p)[role]];
  if (!m) return 0;
  return (inTokens / 1e6) * m.in + (outTokens / 1e6) * m.out;
}

export const money = (n) =>
  n === 0 ? "$0" : n < 0.01 ? `${(n * 100).toFixed(2)}¢` : `$${n.toFixed(2)}`;

/**
 * What judging n posts costs on the current pick.
 *
 * ~400 in and ~70 out per item, measured off a real batch rather than guessed:
 * the first version of this said 900/120 and was an order of magnitude out on
 * a reasoning model, because reasoning tokens are billed as completion tokens
 * and never appear in the answer. On a model that must reason this is still a
 * floor rather than a figure — which is why `MODELS[].note` says which ones do.
 */
export const judgeEstimate = (dir, n) => cost(dir, "judge", n * 400, n * 70);
