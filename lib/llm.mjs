// The entire model layer. fetch(), a schema check, and a tool loop — nothing else.
//
// This file replaced three frameworks (LangChain core, its OpenAI adapter, and
// deepagents) plus zod, and the decision is worth recording because it will be
// re-litigated: those libraries were doing three narrow jobs here — send a chat
// request with fallbacks, force a JSON answer that matches a schema, and run
// one read-a-page loop for the scout. That is ~200 lines of code against ~40MB
// of node_modules, four version-peering relationships that already broke once
// (ERESOLVE, 2026-08), and a supply chain nobody can audit for a tool whose
// pitch is "runs on your machine, reads your prospects, holds your key".
// A standard has to be auditable by one person in one sitting. This is.
//
// What was deliberately KEPT from those frameworks:
//   - structured output via a FORCED TOOL CALL, not response_format. That is
//     what withStructuredOutput did under the hood, it is what was measured
//     working across DeepSeek, Qwen, GLM and Kimi on OpenRouter, and json_mode
//     support is patchier than tool support on exactly the cheap models the
//     judge runs on.
//   - model-level fallbacks via OpenRouter's `models:` array — a tick that dies
//     on one provider's 429 has spent its minute-a-read budget and produced
//     nothing.
//   - a hard timeout and ONE retry. A request that never returns is
//     indistinguishable from one still working, so a job that cannot time out
//     cannot fail — it can only be abandoned. Measured: the first judge run sat
//     326s at "judging 1–10 of 22" with no error and no progress.
//
// Everything here speaks plain OpenAI-compatible chat completions, which is
// also what makes the hosted twin cheap to build: point `baseUrl` somewhere
// else and nothing above this file changes.

/* ---------------------------------------------------------------- request */

/**
 * One chat completion. Returns `{message, usage, model}` — the raw assistant
 * message, because the two callers below want different halves of it (text or
 * tool_calls) and pre-digesting it here would just be a second API.
 *
 * `seat` comes from models.mjs: {key, baseUrl, model, models, maxTokens,
 * timeoutMs, retries}.
 */
export async function complete(seat, messages, opts = {}) {
  const body = {
    model: seat.model,
    models: seat.models,
    provider: { sort: "throughput", allow_fallbacks: true },
    messages,
    temperature: 0,
    max_tokens: seat.maxTokens,
  };
  if (opts.tools) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;

  const attempts = 1 + (seat.retries ?? 1);
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    try {
      const data = await post(seat, body, opts.signal);
      // OpenRouter can answer 200 with an error object in the body when the
      // upstream provider failed after headers went out. A 200 is not a result
      // until it has a message in it.
      if (data.error) throw new Error(providerError(data.error));
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("the response carried no message");
      return { message, usage: data.usage ?? null, model: data.model ?? seat.model };
    } catch (e) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      lastErr = e;
      // 4xx other than 429 is our request being wrong; asking again with the
      // same request is asking to be wrong twice.
      if (e.status && e.status !== 429 && e.status < 500) break;
      if (attempt + 1 < attempts) await sleep(1500);
    }
  }
  throw lastErr;
}

async function post(seat, body, signal) {
  // Node 18 has no AbortSignal.any, so the timeout and the caller's cancel are
  // combined by hand. Both matter: without the timeout there is no upper bound
  // on a job, and without the caller's signal the Stop button lies — the job
  // reads "cancelled" while the request carries on underneath it.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), seat.timeoutMs ?? 120_000);
  const onAbort = () => ctrl.abort("cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${seat.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${seat.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try { detail = providerError(JSON.parse(text).error); } catch { /* not JSON — keep the excerpt */ }
      const err = new Error(`${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    try { return JSON.parse(text); } catch { throw new Error("200 but the body was not JSON"); }
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error(ctrl.signal.reason === "timeout"
        ? `no answer after ${Math.round((seat.timeoutMs ?? 120_000) / 1000)}s — timed out`
        : "cancelled");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const providerError = (e) =>
  [e?.message, e?.metadata?.provider_name && `(${e.metadata.provider_name})`].filter(Boolean).join(" ") || "provider error";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- structured */

/**
 * Ask for an answer that matches a JSON Schema, and refuse anything that does
 * not. One forced tool call; the arguments ARE the answer.
 *
 * On a malformed answer it asks exactly once more, quoting the validator's
 * complaint. The second ask lands almost every time; a third would just be
 * paying to hear the same mistake again.
 */
export async function structured(seat, messages, schema, { name = "answer", signal, log } = {}) {
  const tools = [{ type: "function", function: { name, description: `Record the ${name}.`, parameters: schema } }];
  const tool_choice = { type: "function", function: { name } };

  let convo = messages;
  for (let attempt = 0; ; attempt++) {
    const { message, usage } = await complete(seat, convo, { tools, tool_choice, signal });
    const raw = message?.tool_calls?.[0]?.function?.arguments;
    let data, why;
    if (raw === undefined) why = `the model answered in prose instead of calling ${name}`;
    else if (typeof raw === "object" && raw !== null) data = raw;   // some providers pre-parse
    else { try { data = JSON.parse(raw); } catch (e) { why = `arguments were not JSON: ${e.message}`; } }
    if (data && !(why = conforms(schema, data))) return { data, usage };

    if (attempt >= 1) throw new Error(`${name}: ${why}`);
    log?.(`  malformed ${name} (${why}) — asking once more`);
    // A fresh ask with the complaint attached, not a continued transcript: a
    // dangling tool_call with no tool result is itself a protocol error on
    // several providers, so the failed attempt is not replayed.
    convo = [...messages, { role: "user", content: `Your previous answer was rejected: ${why}. Call the ${name} function again with arguments that match its schema exactly.` }];
  }
}

/**
 * Does a value match a JSON Schema? Returns the first complaint as a string
 * ("$.verdicts[0].fit is missing"), or null when it conforms.
 *
 * Deliberately the subset this repo writes — object/array/string/number/
 * integer/boolean, required, enum — rather than the whole spec. A validator
 * nobody can read end-to-end is a validator nobody notices lying.
 */
export function conforms(schema, v, path = "$") {
  if (!schema || typeof schema !== "object") return null;
  const kind = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  const t = schema.type;
  if (t === "object") {
    if (kind !== "object") return `${path} should be an object, got ${kind}`;
    for (const k of schema.required ?? []) if (v[k] === undefined) return `${path}.${k} is missing`;
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (v[k] === undefined) continue;
      const bad = conforms(sub, v[k], `${path}.${k}`);
      if (bad) return bad;
    }
  } else if (t === "array") {
    if (kind !== "array") return `${path} should be an array, got ${kind}`;
    if (schema.items) for (let i = 0; i < v.length; i++) {
      const bad = conforms(schema.items, v[i], `${path}[${i}]`);
      if (bad) return bad;
    }
  } else if (t === "string" && kind !== "string") return `${path} should be a string, got ${kind}`;
  else if (t === "number" && kind !== "number") return `${path} should be a number, got ${kind}`;
  else if (t === "integer" && (kind !== "number" || !Number.isInteger(v))) return `${path} should be an integer`;
  else if (t === "boolean" && kind !== "boolean") return `${path} should be a boolean, got ${kind}`;
  if (schema.enum && !schema.enum.includes(v)) return `${path} should be one of: ${schema.enum.join(", ")}`;
  return null;
}

/* -------------------------------------------------------------- tool loop */

/**
 * An agent, in the only sense this tool needs one: a loop that lets the model
 * call the tools it was handed until it answers in prose.
 *
 * `tools` is [{name, description, parameters, run}] where `run` takes the
 * parsed arguments and returns a string. A tool that throws reports its error
 * INTO the transcript rather than up the stack — the model deciding what to do
 * about a 404 is the job; the loop dying on one is not.
 */
export async function toolLoop(seat, { messages, tools, maxSteps = 24, signal, log } = {}) {
  const defs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const convo = [...messages];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let text = "";

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error("cancelled");
    const { message, usage: u } = await complete(seat, convo, { tools: defs, signal });
    usage.prompt_tokens += u?.prompt_tokens ?? 0;
    usage.completion_tokens += u?.completion_tokens ?? 0;
    if (typeof message.content === "string" && message.content.trim()) text = message.content;

    const calls = message.tool_calls ?? [];
    if (!calls.length) return { text, usage, steps: step + 1 };

    convo.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const c of calls) {
      const t = byName.get(c.function?.name);
      let out;
      try {
        const args = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : (c.function?.arguments ?? {});
        out = t ? String(await t.run(args)) : `there is no tool called ${c.function?.name}`;
      } catch (e) {
        out = `that call failed: ${e.message}`;
      }
      convo.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  // Out of steps with prose in hand is a result; out of steps without is one
  // too — the caller decides, so both travel with the flag rather than a throw.
  return { text, usage, steps: maxSteps, exhausted: true };
}
