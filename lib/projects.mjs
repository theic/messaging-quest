// Projects — one brand, one isolated context each (0.6.0).
//
// The operator works on more than one thing, and a queue judged against the
// wrong rule.md is worse than no queue. So a project is a whole data
// directory: its own memory files, its own store, voice, deck, tasks and
// threads. The root (`.mq/`) IS the default project — the first onboarding
// happens there, as it always did, and an older directory needs no migration.
// Every other project lives under `<root>/projects/<id>/` and is created
// here, complete, from the seeds every `mq init` writes.
//
// What crosses the line is decided in lib/dirs.mjs and it is short: the key
// and the seats, the people already answered, the local skills ring. What a
// new project inherits at birth — and only at birth, as a copy — is the
// operator's own account, their measured voice, me.md and the persona: those
// are about the person, and the person is the same across brands. They are
// copied rather than shared because a second brand may well need a different
// account or a different tone, and a shared file would make that impossible.
//
// `projects.json` at the root is the registry and the pointer: which project
// the dashboard, the panel and a bare `mq` command act on. Every surface
// resolves the same pointer, so switching in one place switches everywhere.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { FILES } from "./store.mjs";
import { seedMissing } from "./memory.mjs";
import { isChildProject, SHARED_FILES } from "./dirs.mjs";

export const DEFAULT = "default";
const REGISTRY = (root) => join(root, "projects.json");

/** What a new project takes from the default one, once, as a copy. */
const INHERITED = ["account.json", "voice.json", "me.md", "persona.md"];

/** An id from a name: lowercase, hyphens, at most 40 characters. "default"
 *  and "projects" are taken by the layout itself. */
export function slug(name) {
  const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s && s !== DEFAULT && s !== "projects" ? s : "";
}

function readRegistry(root) {
  let raw = {};
  try { if (existsSync(REGISTRY(root))) raw = JSON.parse(readFileSync(REGISTRY(root), "utf8")) || {}; } catch { raw = {}; }
  const projects = { [DEFAULT]: { name: "default", added: null, ...(raw.projects?.[DEFAULT] ?? {}) } };
  for (const [id, p] of Object.entries(raw.projects ?? {})) if (id !== DEFAULT && slug(id) === id) projects[id] = { name: String(p?.name ?? id).slice(0, 80), added: p?.added ?? null };
  const current = projects[raw.current] ? raw.current : DEFAULT;
  return { current, projects };
}

const writeRegistry = (root, reg) => writeFileSync(REGISTRY(root), JSON.stringify(reg, null, 2) + "\n");

const projectDir = (root, id) => (id === DEFAULT ? String(root) : join(root, "projects", id));

export function listProjects(root) {
  const reg = readRegistry(root);
  return Object.entries(reg.projects).map(([id, p]) => ({ id, name: p.name, added: p.added, dir: projectDir(root, id), current: id === reg.current }));
}

export function currentProject(root) {
  const reg = readRegistry(root);
  return { id: reg.current, name: reg.projects[reg.current].name, dir: projectDir(root, reg.current) };
}

/** The directory a bare command acts on: the current project's. A child
 *  project directory named directly (MQ_DIR pointed at it) is its own
 *  answer — there is no registry inside one. */
export function currentDir(root) {
  if (isChildProject(root) || !existsSync(REGISTRY(root))) return String(root);
  return currentProject(root).dir;
}

/** Make a project, complete, and make it current. Returns {id, name, dir} or
 *  {error}. Nothing is read from the network and nothing is judged: the new
 *  project's deck starts at the first onboarding card, like a fresh root. */
export function createProject(root, name, { rename = false } = {}) {
  const id = slug(name);
  if (!id) return { error: `"${String(name ?? "").trim() || ""}" does not make a project id — letters and digits, please (and "default" is taken)` };
  const reg = readRegistry(root);
  if (reg.projects[id] && !rename) return { error: `a project "${id}" already exists` };
  const dir = projectDir(root, id);
  mkdirSync(join(dir, "rooms"), { recursive: true });
  for (const f of FILES) if (!SHARED_FILES.has(f) && !existsSync(join(dir, f))) writeFileSync(join(dir, f), "");
  seedMissing(dir);
  for (const f of INHERITED) {
    const from = join(root, f);
    if (existsSync(from) && !existsSync(join(dir, f))) { try { copyFileSync(from, join(dir, f)); } catch { /* a seed is fine too */ } }
  }
  reg.projects[id] = { name: String(name).trim().slice(0, 80) || id, added: new Date().toISOString() };
  reg.current = id;
  writeRegistry(root, reg);
  return { id, name: reg.projects[id].name, dir };
}

/** Point every surface at another project. */
export function useProject(root, id) {
  const reg = readRegistry(root);
  const key = String(id ?? "").trim().toLowerCase();
  if (!reg.projects[key]) return { error: `no project "${key}" — \`mq projects\` lists them` };
  reg.current = key;
  writeRegistry(root, reg);
  return { id: key, name: reg.projects[key].name, dir: projectDir(root, key) };
}
