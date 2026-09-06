// The feed — one machine reads the sources, many machines use what it found.
//
// WHAT THIS IS FOR. Reading Reddit anonymously costs a minute a request. Ten
// people watching five sources each is fifty reads an hour if they each do it
// themselves, and five if one machine does it and passes on what it found. That
// is the whole argument for a hub, and it is a good one.
//
// WHAT IT DELIBERATELY DOES NOT CARRY. Only `found.jsonl` — public posts other
// people wrote in public rooms. Not verdicts, not drafts, not marks, not the
// contacted list, not anybody's rule.md, and not one byte of any client's own
// Reddit history.
//
// That line is not tidiness, it is the entire position. The moment the hub
// holds who-answered-whom, the operator of the hub is the data controller for
// everybody using it — which is the thing bin/serve.mjs binds to 127.0.0.1 to
// avoid, and the thing CNIL fined KASPR EUR 240,000 over. A hub that only ever
// relays public posts is a cache. A hub that knows your queue is a service, and
// a service has a controller.
//
// SO THE HUB DOES NOT JUDGE. Judging is done by each client against its own
// rule.md, on its own machine, with its own key. If the hub judged, every
// client would get the same queue and the rubric hash on every verdict would
// stop answering the question it exists to answer.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { join } from "node:path";
import { sharedDir } from "./dirs.mjs";

// The machine's, not a project's (lib/dirs.mjs).
const TOKENS = (dir) => join(sharedDir(dir), "feed-tokens.json");

/** Fields a client is given. An allowlist rather than a delete-list, so a field
 *  added to found.jsonl later is not published by accident. */
const PUBLIC = ["id", "place", "url", "author", "title", "body", "body_sha256", "posted_at", "seen_at", "probe"];

export const publicItem = (r) => {
  const out = {};
  for (const k of PUBLIC) if (r[k] !== undefined) out[k] = r[k];
  return out;
};

/* ------------------------------------------------------------------ tokens */

/** Stored as a SHA-256, never in the clear. The hub only ever needs to answer
 *  "is this one of mine", and a file of live bearer tokens is a file worth
 *  stealing. Shown once, at the moment it is made, and not recoverable after. */
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");

export function tokens(dir) {
  try {
    if (existsSync(TOKENS(dir))) return JSON.parse(readFileSync(TOKENS(dir), "utf8"));
  } catch { /* unreadable is the same as none */ }
  return [];
}

export function issueToken(dir, label) {
  const raw = "es_" + randomBytes(24).toString("base64url");
  const all = tokens(dir);
  all.push({ label: String(label || "client").slice(0, 60), sha: hash(raw), added: new Date().toISOString() });
  writeFileSync(TOKENS(dir), JSON.stringify(all, null, 2) + "\n");
  return raw;   // the only time it exists in the clear
}

export function revokeToken(dir, sha) {
  const all = tokens(dir).filter((t) => t.sha !== sha);
  writeFileSync(TOKENS(dir), JSON.stringify(all, null, 2) + "\n");
  return all;
}

/**
 * Is this bearer token one of ours?
 *
 * Compared with timingSafeEqual over the hashes. A plain `===` on a secret
 * leaks its prefix to anybody willing to time a few thousand requests, and this
 * endpoint is the one thing here that is deliberately reachable from off the
 * machine.
 */
export function validToken(dir, presented) {
  const want = Buffer.from(hash(String(presented ?? "")), "hex");
  for (const t of tokens(dir)) {
    let mine;
    try { mine = Buffer.from(t.sha, "hex"); } catch { continue; }
    if (mine.length === want.length && timingSafeEqual(mine, want)) return t;
  }
  return null;
}

/* -------------------------------------------------------------------- feed */

/**
 * Everything found since `after`, oldest first.
 *
 * The cursor is `seen_at` — when THIS machine first saw the post, not when it
 * was posted. Those are different and only one of them is monotonic in the
 * order rows are appended, which is what a resumable cursor needs. Sorting by
 * posted_at would silently skip anything that arrived late.
 *
 * Ties on the same timestamp are the reason `after` is exclusive on the cursor
 * but the client de-duplicates by id anyway: found.jsonl is first-write-wins on
 * id, so re-reading an overlap is free and losing a row is not.
 */
export function feedSince(rows, after = "", limit = 500) {
  const since = String(after ?? "");
  const fresh = rows
    .filter((r) => r && r.id && String(r.seen_at ?? "") > since)
    .sort((a, b) => String(a.seen_at).localeCompare(String(b.seen_at)));
  const page = fresh.slice(0, limit);
  return {
    items: page.map(publicItem),
    cursor: page.length ? String(page[page.length - 1].seen_at) : since,
    more: fresh.length > page.length,
  };
}
