// OpenRouter, and what "balanced" actually means here.
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
// Prices below are per MILLION tokens, read off OpenRouter's own
// /api/v1/models on 2026-08-30. They are here so /settings can show what a
// choice costs before it is made, and they carry the date for the same reason
// every measurement in skills/reddit/feed.mjs does: this is the kind of number that is
// wrong later in a way nobody notices.
//
// There is nothing to install for any of this. The request layer is
// lib/llm.mjs, which is fetch() and nothing else — so the only thing a model
// seat needs that the rest of the product does not is a key.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const BASE_URL = "https://openrouter.ai/api/v1";

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
 * The roles, their defaults, and what each falls back to.
 *
 * `alternates` becomes OpenRouter's model-level `models:` array — the first is
 * asked and the rest are tried in order if it errors. This matters more than it
 * looks: a `tick` that dies on one provider's `429 engine_overloaded` has spent
 * its minute-per-read budget and produced nothing.
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
    def: "deepseek/deepseek-v4-flash-0731",
    alternates: ["qwen/qwen3.7-flash", "z-ai/glm-5.3-flash"],
    // Generous, because a reasoning model may still be picked here and its
    // thinking comes out of the same budget as the tool call. Too small does
    // not error — it truncates mid-call and the verdicts silently never arrive.
    maxTokens: 8000,
  },
  scout: {
    key: "scout",
    title: "Scout",
    what: "Reads your website once and proposes what you sell, who it is for, and the fit rule.",
    def: "z-ai/glm-5.3",
    alternates: ["deepseek/deepseek-v4-pro-0813", "qwen/qwen3.8-2.4t-a95b"],
    maxTokens: 16384,
  },
  writer: {
    key: "writer",
    title: "Writer",
    what: "Drafts the reply, in your measured voice. Never sends it.",
    def: "moonshotai/kimi-k3",
    alternates: ["z-ai/glm-5.3", "qwen/qwen3.8-2.4t-a95b"],
    maxTokens: 8192,
  },
};

/* ------------------------------------------------------------------ config */

const CONF = (dir) => join(dir, "models.json");
const KEYFILE = (dir) => join(dir, "openrouter.key");

/** Which model each role uses. Unknown ids fall back to the default rather than
 *  being passed through — a typo in models.json should not reach OpenRouter as
 *  a 400 an hour into a tick. */
export function chosen(dir) {
  let saved = {};
  try {
    if (existsSync(CONF(dir))) saved = JSON.parse(readFileSync(CONF(dir), "utf8"));
  } catch { saved = {}; }
  const out = {};
  for (const r of Object.values(ROLES)) {
    const want = saved[r.key];
    out[r.key] = want && MODELS[want] ? want : r.def;
  }
  return out;
}

export function choose(dir, role, model) {
  if (!ROLES[role]) throw new Error(`no such role: ${role}`);
  if (!MODELS[model]) throw new Error(`not a model this build knows: ${model}`);
  const next = { ...chosen(dir), [role]: model };
  writeFileSync(CONF(dir), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * The key. Environment first, so a shell that already exports it needs no
 * setup, and a file second, so the browser has somewhere to put one.
 *
 * `.earshot/` is gitignored, which is the only reason writing it here is
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
  const key = readKey(dir);
  if (!key) throw new Error("no OpenRouter key — add one on /settings, or set OPENROUTER_API_KEY");
  const model = chosen(dir)[r.key];
  return {
    key,
    baseUrl: BASE_URL,
    model,
    // OpenRouter's model-level fallback list, first entry included: a tick
    // that dies on one provider's 429 has spent its minute-a-read budget and
    // produced nothing.
    models: [model, ...r.alternates.filter((a) => a !== model)],
    maxTokens: r.maxTokens,
    // A timeout, because without one there is no upper bound on a job.
    //
    // The first real judge run sat at "judging 1-10 of 22" for five and a half
    // minutes with no error, no progress and nothing in the log. A request that
    // never returns is indistinguishable from one still working, so a job that
    // cannot time out cannot fail — it can only be abandoned. Two minutes is
    // well past the slowest measured call (13.5s) and well short of a coffee.
    timeoutMs: 120_000,
    // One retry, not two or three. Three attempts at a two-minute ceiling is a
    // six-minute silence, and the judge's batch loop already treats a failure
    // as "unjudged", which is a recoverable state and not a verdict.
    retries: 1,
  };
}

/* -------------------------------------------------------------------- cost */

/** Dollars, for a given role and token counts. Rough by construction — it is
 *  shown to answer "is this cents or dollars", which is the only question
 *  anybody actually has before clicking. */
export function cost(dir, role, inTokens, outTokens) {
  const m = MODELS[chosen(dir)[role]];
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
