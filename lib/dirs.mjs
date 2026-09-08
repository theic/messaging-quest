// Where the data lives — and, from 0.6.0, which of it is the PROJECT's and
// which is the MACHINE's.
//
// `.mq/` (or MQ_DIR) is the root, and the root IS the default project: every
// file an older build wrote there keeps its meaning, nothing migrates. A
// second project is a complete data directory of its own under
// `<root>/projects/<id>/` — its own memory files, store, voice, cards, tasks,
// threads, inbox — so every verb, every screen and every agent runs on a
// project directory without knowing whether it is the root or a child.
//
// Three things are the machine's, not the project's, and resolve to the root
// from any project directory (`sharedDir`):
//   openrouter.key, models.json   the seats and the bill are the operator's
//   contacted.jsonl               everybody ever answered — permanent, and
//                                 across every project, because showing the
//                                 same human twice is what makes a queue feel
//                                 like a lottery (lib/store.mjs)
//   skills/, skills.json          the local ring and its slot choices
//
// This file imports only the filesystem door (lib/fs.mjs) so that anything —
// the model layer, the store, the CLI — can ask it where things are without
// pulling the platform door in.

import { existsSync, renameSync, basename, dirname, join, env } from "./fs.mjs";

/** The root: ".mq" unless MQ_DIR says otherwise. A directory written under
 *  the tool's earlier name is carried over once, by rename — the brand grew
 *  up; nobody's queue starts over for that. */
export function dataDir() {
  const dir = env("MQ_DIR") || ".mq";
  if (dir === ".mq" && !existsSync(dir) && existsSync(".earshot")) {
    renameSync(".earshot", dir);
    console.error("moved .earshot/ → .mq/ — same data, current name");
  }
  return dir;
}

/** Is this directory a child project — `<root>/projects/<id>` with the
 *  registry beside it? Structural, so a directory copied elsewhere is simply
 *  a root of its own. */
export const isChildProject = (dir) =>
  basename(dirname(String(dir))) === "projects" && existsSync(join(dirname(dirname(String(dir))), "projects.json"));

/** The directory that holds the machine's files for this project: the root
 *  for a child project, the directory itself otherwise. */
export const sharedDir = (dir) => (isChildProject(dir) ? dirname(dirname(String(dir))) : String(dir));

/** The files that live in the shared directory, by name. The store routes
 *  reads and writes of these there; everything else stays with the project. */
export const SHARED_FILES = new Set(["contacted.jsonl", "openrouter.key", "models.json", "skills.json", "feed-tokens.json"]);
