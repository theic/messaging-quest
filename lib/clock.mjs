// The clock — the one thing the specialist could not know.
//
// Until 0.12.0 nothing in this repo ever told a model what time it was. A
// colleague that cannot say "three hours ago" says "recently"; asked "when
// did you last look at this?" it invents an answer, or carries one over from
// a turn that happened yesterday. Every other fact reaches the CMO from a
// tool — the deck, the counts, the campaigns — and time was the one it was
// left to guess.
//
// Two things live here, and both are pure: a `now` goes in, a string or a
// number comes out. That is what keeps them testable on a bare Node
// (bin/test.mjs) while the loops that use them sit behind the brain's
// dependencies in agent/.
//
//   * THE WORDS. A local time with its zone, the ISO instant beside it, and
//     how long ago something was in the phrases a person actually uses. The
//     doctrine tells the agent to quote these rather than work them out, for
//     the same reason it is told to quote counts: a figure a model derives
//     is a figure it can get wrong, and the operator acts on it.
//
//   * THE HEARTBEAT'S PACING. How long to wait before waking up with nothing
//     in the inbox, and how fast that doubles while nothing is happening. A
//     founder on a free seat pays for every idle turn, so quiet has to get
//     cheaper on its own — the first silence is free, the second costs half
//     as often, and it keeps halving to a ceiling until something real
//     happens.
//
// Nothing in here reads a file or a clock it was not handed, so the extension's
// service worker runs it as-is (lib/fs.mjs is not even needed).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ms = (at) => {
  if (at instanceof Date) return at.getTime();
  if (typeof at === "number") return Number.isFinite(at) ? at : NaN;
  return Date.parse(String(at ?? ""));
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** This machine's zone, named — "Europe/Kyiv". The fallback is UTC rather
 *  than a guess: an agent told the wrong zone says the wrong hour with
 *  confidence. */
export const zone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

/**
 * How long ago, in words. "just now" under two minutes, then minutes, then
 * hours, then days — rounded the way a person rounds, because "3 hours ago"
 * is what the operator hears and "2.84 hours" is what a model computes.
 * Something that never happened is "never", not "a very long time ago".
 */
export function ago(at, now = Date.now()) {
  const t = ms(at);
  if (!Number.isFinite(t)) return "never";
  const d = now - t;
  if (d < 0) return "just now";        // a clock that moved back; not worth a sentence
  if (d < 2 * MIN) return "just now";
  if (d < 90 * MIN) return `${plural(Math.round(d / MIN), "minute")} ago`;
  if (d < DAY) return `${plural(Math.round(d / HOUR), "hour")} ago`;
  return `${plural(Math.round(d / DAY), "day")} ago`;
}

/** The same span as a length rather than a point — a deadline's "26 minutes
 *  left", a back-off's "an hour from now". */
export function span(millis) {
  const d = Math.max(0, Number(millis) || 0);
  if (d < MIN) return "less than a minute";
  if (d < 90 * MIN) return plural(Math.round(d / MIN), "minute");
  if (d < DAY) return plural(Math.round(d / HOUR), "hour");
  return plural(Math.round(d / DAY), "day");
}

/** The wall clock as the operator reads it, zone named. */
export function localTime(now = Date.now(), timeZone = zone()) {
  try {
    return new Date(now).toLocaleString("en-GB", {
      timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch {
    return new Date(now).toISOString();   // an unknown zone is not a reason to lose the hour
  }
}

/**
 * What every turn is told about time, as two lines of plain prose.
 *
 * It rides in the TURN MESSAGE, never in the system prompt: the system prompt
 * is fingerprinted over its own inputs (agent/strategist.mjs agentFor), so a
 * line that moves every minute would rebuild the agent every minute and throw
 * away the provider's prompt cache with it. Everything that changes per turn
 * — the deck, the numbers, the lane, this — goes in front of the message.
 *
 * Every field is optional; what was never recorded is simply not claimed.
 */
export function clockText({
  now = Date.now(), timeZone = zone(),
  operatorAt = null, heartbeatAt = null, tickAt = null, wokeBy = null,
} = {}) {
  const head = `The clock: ${localTime(now, timeZone)} in ${timeZone} — ${new Date(now).toISOString()}.`;
  const parts = [];
  if (operatorAt) parts.push(`the operator last said something ${ago(operatorAt, now)}`);
  if (heartbeatAt) parts.push(`you last woke by yourself ${ago(heartbeatAt, now)}`);
  if (tickAt) parts.push(`what was due was last read ${ago(tickAt, now)}`);
  const tail = parts.length ? `Since then: ${parts.join(", ")}.` : "";
  const why = wokeBy ? `This turn is ${wokeBy}.` : "";
  return [head, tail, why].filter(Boolean).join(" ");
}

/* ------------------------------------------------------------- heartbeat */

/** Nothing in the inbox, nobody typing: wake up anyway, this often. */
export const HEARTBEAT_MS = 30 * MIN;
/** …and no less often than this, however long the quiet goes on. */
export const HEARTBEAT_CEILING_MS = 4 * HOUR;

/**
 * How long until the next heartbeat, given how many in a row have said
 * nothing. The first silence is free — half an hour of quiet is not evidence
 * of anything — and from the second the interval doubles to the ceiling. Any
 * real event, and any word from the operator, resets `quiet` to zero.
 *
 * 30m · 30m · 1h · 2h · 4h · 4h …
 */
export const heartbeatEvery = (quiet = 0, { everyMs = HEARTBEAT_MS, ceilingMs = HEARTBEAT_CEILING_MS } = {}) =>
  Math.min(ceilingMs, everyMs * 2 ** Math.max(0, Math.min(10, Math.floor(Number(quiet) || 0) - 1)));

/** Is a heartbeat due? `at` is when the last one fired (null: never — one is
 *  due as soon as the interval has passed since the process came up). */
export const heartbeatDue = (at, quiet = 0, { now = Date.now(), everyMs = HEARTBEAT_MS, ceilingMs = HEARTBEAT_CEILING_MS } = {}) => {
  const t = ms(at);
  if (!Number.isFinite(t)) return true;
  return now - t >= heartbeatEvery(quiet, { everyMs, ceilingMs });
};

/**
 * Did that turn say anything? The doctrine's word for "nothing worth saying"
 * is "noted" — the inbox delivery has asked for it since milestone 1 — so a
 * reply that is only that, or only empty, is a silent heartbeat. It is the
 * back-off's one input, which is why it is here and pinned by a test rather
 * than being a regex somewhere in a loop.
 */
export const saidNothing = (text) => {
  const t = String(text ?? "").trim().toLowerCase().replace(/[.!\s]+$/, "");
  return t === "" || t === "noted" || t === "nothing" || t === "nothing to say" || t === "nothing to add" || t === "ok" || t === "okay";
};
