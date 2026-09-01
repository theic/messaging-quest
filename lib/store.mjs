// The store, in one place, because two readers of the same files drift.
//
// This was inside bin/mq.mjs until the dashboard needed it too. Re-deriving
// "first write wins on items, last write wins on verdicts, contacted is
// permanent" in a second file is how a CLI and a UI end up disagreeing about
// what the same directory says — and the one that disagrees quietly is the one
// somebody trusts.
//
// Everything is append-only JSONL. The two rules that matter:
//   items and found: FIRST write wins. A re-read must never overwrite a body.
//   checks:          nothing is ever replaced. The transition IS the finding.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readRoomFile } from "./rules.mjs";
import { roomOf } from "./platform.mjs";

/** Where the data lives: ".mq" unless MQ_DIR says otherwise. A directory
 *  written under the tool's earlier name is carried over once, by rename —
 *  the brand grew up; nobody's queue starts over for that. */
export function dataDir() {
  const dir = process.env.MQ_DIR || ".mq";
  if (dir === ".mq" && !existsSync(dir) && existsSync(".earshot")) {
    renameSync(".earshot", dir);
    console.error("moved .earshot/ → .mq/ — same data, current name");
  }
  return dir;
}

export const FILES = [
  "items.jsonl", "checks.jsonl", "reads.jsonl", "replies.jsonl",
  "sources.jsonl", "found.jsonl", "verdicts.jsonl", "marks.jsonl",
  "contacted.jsonl", "drafts.jsonl",
];

export function store(dir, onError = (m) => { throw new Error(m); }) {
  const F = (n) => join(dir, n);

  const readJsonl = (name) => {
    const p = F(name);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim())
      .map((l, i) => { try { return JSON.parse(l); } catch { return onError(`${name}:${i + 1} is not JSON`); } });
  };

  const firstById = (name) => {
    const m = new Map();
    for (const r of readJsonl(name)) if (!m.has(r.id)) m.set(r.id, r);
    return m;
  };
  const lastById = (name) => {
    const m = new Map();
    for (const r of readJsonl(name)) m.set(r.id, r);
    return m;
  };

  const roomPath = (place) => join(dir, "rooms", `${String(place).toLowerCase()}.md`);

  return {
    dir, F, readJsonl, lastById,
    append: (name, obj) => appendFileSync(F(name), JSON.stringify(obj) + "\n"),
    rewrite: (name, rows) => writeFileSync(F(name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")),

    /** Your own comments. */
    items: () => firstById("items.jsonl"),
    /** Other people's posts. A different table on purpose: yours are yours,
     *  theirs are what the 48-hour retention rule is actually about. */
    found: () => firstById("found.jsonl"),
    verdicts: () => lastById("verdicts.jsonl"),
    marks: () => lastById("marks.jsonl"),
    drafts: () => readJsonl("drafts.jsonl"),
    sources: () => [...lastById("sources.jsonl").values()].filter((s) => !s.deleted),

    checksById: () => {
      const m = new Map();
      for (const c of readJsonl("checks.jsonl")) (m.get(c.id) ?? m.set(c.id, []).get(c.id)).push(c);
      return m;
    },

    /**
     * Everybody you have ever replied to. Permanent, across every project —
     * showing you the same human twice is what makes a queue feel like a
     * lottery.
     *
     * Permanent, but not irreversible: a `{author, removed: true}` row lifts
     * the retirement, which is what the Undo on /people writes. The file stays
     * append-only and the last word about a person wins, so the history of a
     * misclick is still on disk rather than edited out of it. Without this a
     * single stray click deleted somebody from every future queue forever, with
     * no screen that could even show you it had happened.
     */
    contacted: () => {
      const s = new Set();
      for (const r of readJsonl("contacted.jsonl")) {
        const a = String(r.author ?? "").toLowerCase();
        if (!a) continue;
        if (r.removed) s.delete(a); else s.add(a);
      }
      return s;
    },

    account: () => (existsSync(F("account.json")) ? JSON.parse(readFileSync(F("account.json"), "utf8")) : null),

    roomPath,
    roomState: (place) => {
      const p = roomPath(place);
      return existsSync(p) ? readRoomFile(readFileSync(p, "utf8")) : { state: "unanswered" };
    },
    writeRoom: (place, body) => {
      mkdirSync(join(dir, "rooms"), { recursive: true });
      writeFileSync(roomPath(place), body);
    },

    /** A rubric hash on every verdict, so "the queue changed" is answerable
     *  with "your rule" or "the model" rather than a shrug. */
    ruleHash: () => {
      const p = F("rule.md");
      if (!existsSync(p)) return onError("no rule.md — run `mq init`");
      return createHash("sha256").update(readFileSync(p, "utf8")).digest("hex").slice(0, 8);
    },

    /** Every reply you logged as sent, with the room it went to. The burst
     *  governor and the mix both read this, from the CLI and the dashboard —
     *  so it lives here rather than being written out twice with one of the
     *  two quietly missing the url fallback. */
    sentLog() {
      const all = this.found();
      // The LAST mark on each item, not every row ever appended: an answer that
      // was marked sent and then undone must stop counting against the burst
      // budget, or the undo silently leaves the governor holding a reply that
      // never happened.
      return [...this.marks().values()].filter((m) => m.mark === "sent")
        .map((m) => ({ at: m.at, place: all.get(m.id)?.place ?? roomOf(all.get(m.id)?.url ?? "") ?? "?" }));
    },

    pending: () => (existsSync(F("pending.json")) ? JSON.parse(readFileSync(F("pending.json"), "utf8")) : []),
    setPending: (v) => writeFileSync(F("pending.json"), JSON.stringify(v)),
  };
}
