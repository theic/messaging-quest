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

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, join, sha256 } from "./fs.mjs";
import { readRoomFile } from "./rules.mjs";
import { roomOf } from "./platform.mjs";
import { dataDir, sharedDir, SHARED_FILES } from "./dirs.mjs";

// Where the data lives, and which of it is the machine's rather than the
// project's, is decided in lib/dirs.mjs; the store only routes.
export { dataDir };

export const FILES = [
  "items.jsonl", "checks.jsonl", "reads.jsonl", "replies.jsonl",
  "sources.jsonl", "found.jsonl", "verdicts.jsonl", "marks.jsonl",
  "contacted.jsonl", "drafts.jsonl", "conversations.jsonl",
];

export function store(dir, onError = (m) => { throw new Error(m); }) {
  // The machine's files (contacted.jsonl above all) resolve to the root from
  // a child project; everything else is this project's own.
  const F = (n) => join(SHARED_FILES.has(n) ? sharedDir(dir) : dir, n);

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

    /** The last read of one URL, whatever came of it. This is where a 404 on
     *  your own profile survives: items.jsonl stays empty after one, and
     *  "empty" must never be reported as "never read" — that 404 is the
     *  loudest finding the tool has. */
    lastReadOf: (url) => { let hit = null; for (const r of readJsonl("reads.jsonl")) if (r.url === url) hit = r; return hit; },

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
      return sha256(readFileSync(p, "utf8")).slice(0, 8);
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

    /** Something the engine wants the specialist to hear — a reply that
     *  is waiting, the day's digest. The runtime reads inbox.jsonl from a
     *  cursor when it is idle (agent/strategist.mjs), so the CLI can say it
     *  without a runtime in the room: the file is the seam. */
    note: (type, detail = {}) => appendFileSync(F("inbox.jsonl"), JSON.stringify({ at: new Date().toISOString(), type, ...detail }) + "\n"),

    pending: () => (existsSync(F("pending.json")) ? JSON.parse(readFileSync(F("pending.json"), "utf8")) : []),
    setPending: (v) => writeFileSync(F("pending.json"), JSON.stringify(v)),
  };
}
