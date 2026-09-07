// The skill registry — discovery, slots, and the choice that resolves them.
//
// A skill is a folder with a SKILL.md. That file's prose teaches every agent
// seat (the strategist reads it natively; an MCP client or an OpenClaw agent
// reads the same bytes), and its frontmatter declares what the folder IS:
//
//   ---
//   name: reddit
//   description: one honest sentence
//   provides: platform:reddit        ← optional: the slot this skill fills
//   ---
//
// Beside the SKILL.md, a skill may carry executable seats, detected by file
// name and nothing else:
//
//   adapter.mjs   a platform: how to read somewhere (lib/platform.mjs is the door)
//   page.mjs      a dashboard page (bin/serve.mjs is the door)
//   agent.mjs     a subagent for the strategist, in bare-Node form
//                 (agent/strategist.mjs is the door and carries the runtime)
//   agent.md      a COLLEAGUE — a background worker on its own thread, in
//                 markdown: frontmatter name/description/tools/model, body the
//                 prompt (agent/tasks.mjs is the door). The knowledge and the
//                 one who uses it live in one folder; there is no agents/.
//
// This file only DISCOVERS and RESOLVES. It never imports seat code — each
// door imports its own seat from the active set, so a broken page cannot take
// the platform loader down with it, and lib/ still never executes skill code
// except through a named door. (Reading agent.md is reading a manifest, not
// running a seat: `agentDefinition` below parses it and executes nothing.)
//
// SLOTS are how two implementations of the same purpose coexist in one tree.
// Skills that `provides:` the same slot are candidates; the instance's choice
// lives in <dir>/skills.json as {"<slot>": "<skill id>"}. One candidate needs
// no choice, and a SOLE local candidate wins its slot without one — dropping
// a folder into your own ring is itself the choice, the same doctrine as the
// id override. Anything else unresolved means NONE of the candidates is
// active — the conflict is surfaced (dashboard, CLI) instead of one being
// guessed, because a guess here is somebody's dashboard quietly running code
// they did not pick. A skill with no `provides` is knowledge, and knowledge
// is always active.
//
// Two rings, same as always: the repo's skills/ ships with the tool, and
// <dir>/skills/ is yours — same folder id in yours replaces the built-in
// entirely, before slots are even considered. That is the override mechanism;
// there is no other.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

const SEATS = ["adapter.mjs", "page.mjs", "agent.mjs", "agent.md"];

/**
 * A colleague's definition, read off `agent.md`: frontmatter `name`,
 * `description`, `tools` (a comma-separated line — browser families such as
 * `browser.read`, the question list `ask_person`, and engine verbs by name)
 * and `model` (a SEAT — scout, judge or writer — never a model id: the seats
 * in lib/models.mjs give every agent its model, and there is no second way);
 * the body is the prompt. Null, with the reason on stderr, when the file is
 * not a definition — a colleague that fails to load must fail somewhere a
 * person reads.
 */
export function agentDefinition(skill) {
  const path = skill?.seats?.["agent.md"];
  if (!path) return null;
  const text = readFileSync(path, "utf8");
  const fm = frontmatter(text);
  if (!fm.name || !fm.description) {
    console.error(`skill ${skill.id}: agent.md frontmatter must carry name and description — not seated`);
    return null;
  }
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  if (!body) {
    console.error(`skill ${skill.id}: agent.md has no prompt below its frontmatter — not seated`);
    return null;
  }
  const tools = String(fm.tools ?? "").split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const model = ["scout", "judge", "writer"].includes(String(fm.model ?? "").trim()) ? String(fm.model).trim() : "scout";
  return { id: skill.id, ring: skill.ring, skillDir: skill.path, path, name: String(fm.name), description: String(fm.description), tools, model, prompt: body };
}

/** The frontmatter dialect is `key: value` scalars between --- fences, on
 *  purpose: it is what SKILL.md files already carry, it needs no YAML
 *  dependency, and a manifest you cannot misread is a manifest nobody
 *  argues with. Unknown keys pass through; nesting does not exist. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** Scan the rings. Returns every skill folder that qualifies, later rings
 *  replacing earlier on the same id, plus the folders that did NOT qualify
 *  and the reason — a skill that fails to load must fail somewhere a person
 *  will read, not vanish. */
export function discoverSkills(dir, rings) {
  rings = rings ?? [
    { root: BUILTIN, ring: "built-in" },
    ...(dir ? [{ root: join(dir, "skills"), ring: "local" }] : []),
  ];
  const found = [];
  const refused = [];
  for (const { root, ring } of rings) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const path = join(root, entry.name);
      const manifest = join(path, "SKILL.md");
      if (!existsSync(manifest)) {
        refused.push({ id: entry.name, ring, why: "no SKILL.md — a folder without one is not a skill" });
        continue;
      }
      const fm = frontmatter(readFileSync(manifest, "utf8"));
      if (!fm.name || !fm.description) {
        refused.push({ id: entry.name, ring, why: "SKILL.md frontmatter must carry name and description" });
        continue;
      }
      const seats = {};
      for (const s of SEATS) if (existsSync(join(path, s))) seats[s.replace(".mjs", "")] = join(path, s);
      const skill = { id: entry.name, ring, path, name: fm.name, description: fm.description, provides: fm.provides || null, seats };
      const at = found.findIndex((x) => x.id === skill.id);
      if (at >= 0) found.splice(at, 1); // later ring wins: yours replaces built-in
      found.push(skill);
    }
  }
  return { found, refused };
}

/* ------------------------------------------------------------- the choice */

const choicesFile = (dir) => join(dir, "skills.json");

export function readChoices(dir) {
  try { return JSON.parse(readFileSync(choicesFile(dir), "utf8")) ?? {}; } catch { return {}; }
}

export function writeChoice(dir, slot, id) {
  const c = readChoices(dir);
  if (id === null) delete c[slot]; else c[slot] = id;
  writeFileSync(choicesFile(dir), JSON.stringify(c, null, 2) + "\n");
  return c;
}

/** Pure resolution: which skills are active, and which slots are stuck.
 *  A conflict deactivates every candidate rather than promoting one —
 *  refusing loudly beats guessing quietly, and the refusal names the fix. */
export function resolveSkills(found, choices = {}) {
  const bySlot = new Map();
  for (const s of found) {
    if (!s.provides) continue;
    if (!bySlot.has(s.provides)) bySlot.set(s.provides, []);
    bySlot.get(s.provides).push(s);
  }
  const active = found.filter((s) => !s.provides);
  const conflicts = [];
  for (const [slot, candidates] of bySlot) {
    if (candidates.length === 1) { active.push(candidates[0]); continue; }
    const chosen = choices[slot];
    const hit = candidates.find((c) => c.id === chosen);
    if (hit) { active.push(hit); continue; }
    // A sole local candidate against built-ins: dropping the folder into your
    // own ring was the choice. A stale explicit choice still surfaces instead —
    // the person asked for something that is gone, and silence would hide it.
    const local = candidates.filter((c) => c.ring === "local");
    if (!chosen && local.length === 1) { active.push(local[0]); continue; }
    conflicts.push({
      slot,
      candidates: candidates.map((c) => c.id),
      chosen: chosen ?? null,
      why: chosen
        ? `skills.json chooses "${chosen}" for ${slot}, but no loaded skill has that id`
        : `${candidates.length} skills provide ${slot} — none is active until skills.json (or the Skills page) picks one`,
    });
  }
  return { active, conflicts };
}

/* ------------------------------------------------------------- the state */

let state = { all: [], active: [], conflicts: [], refused: [] };

/** Called at startup by each entrypoint (and again after a choice is written —
 *  idempotent, reloads from scratch). Everything downstream — the platform
 *  door, the page door, the agent door — reads the result of the last call. */
export function loadSkills(dir) {
  const { found, refused } = discoverSkills(dir);
  const { active, conflicts } = resolveSkills(found, dir ? readChoices(dir) : {});
  state = { all: found, active, conflicts, refused };
  return state;
}

export const skillState = () => ({ ...state, all: [...state.all], active: [...state.active], conflicts: [...state.conflicts], refused: [...state.refused] });
export const activeSkills = () => [...state.active];
export const activeSeat = (seat) => state.active.filter((s) => s.seats[seat]);

// The registry being empty is a QUIET failure — rooms stop resolving and
// nothing errors — so importing this module is enough for built-ins, same
// promise lib/platform.mjs has always made.
loadSkills(null);
