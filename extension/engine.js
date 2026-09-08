// The engine, inside the extension — the hosted product's whole backend.
//
// The same lib/engine.mjs the dashboard server runs, on a memory filesystem
// (lib/fs-memory.mjs) that IndexedDB keeps between the worker's lives
// (extension/disk.js). No server anywhere: the deck is dealt here, the verbs
// run here, the models are called from here with the operator's own key, and
// every read of a platform goes through the control lane's broker in this
// same worker — the tabs, the mouse, the pauses and the refusals exactly as
// before, minus the HTTP between the verb and the tab.
//
// Booting is: the files off the disk into memory; the built-in skills out of
// the package into the memory host's /skills (the registry lists a folder,
// and this host has none to list — skills/index.mjs names them); the
// platform adapters, imported statically by that same file (a service
// worker may not import() at run time) and handed to the door; `init` on
// the data root (idempotent — the memory files, the empty ledgers); the
// engine. Once.
//
// What is deliberately not here: the brain (agent/ needs Node — a local
// install has it), the dashboard's pages (the panel's tabs are the product),
// a second way to read anything.

import { install } from "../lib/fs.mjs";
import { memoryHost } from "../lib/fs-memory.mjs";
import { loadPlatforms } from "../lib/platform.mjs";
import { engine } from "../lib/engine.mjs";
import { verbs } from "../lib/verbs.mjs";
import { BUILTIN_SKILLS, BUILTIN_ADAPTERS } from "../skills/index.mjs";
import { disk } from "./disk.js";

/** The data root on the memory host — one directory, the default project,
 *  child projects under it, as on a disk. */
export const ROOT = "/mq";

/** The files a skill folder may carry that the registry looks for. The
 *  manifest is read; a seat only has to exist — it is imported by URL. */
const SKILL_FILES = ["SKILL.md", "adapter.mjs", "page.mjs", "agent.mjs", "agent.md"];

let booting = null;
let HOST = null;
let DISK = null;
let E = null;
const listeners = new Set();

/** The engine, booted once per worker life. */
export function booted() {
  return (booting ??= boot());
}

/** The memory host and the disk, for the account sync. */
export const parts = () => ({ host: HOST, disk: DISK, engine: E });

/** Be told of every change to a file under the data root: (path, content
 *  or null). The disk is the first listener; the account sync the second. */
export function onFileChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function boot() {
  DISK = disk();
  const saved = await DISK.all();
  HOST = memoryHost({
    onChange: (path, content) => {
      if (!(path === ROOT || path.startsWith(ROOT + "/"))) return;
      for (const fn of listeners) { try { fn(path, content); } catch (e) { console.error("file listener:", e?.message ?? e); } }
    },
    moduleUrl: (path) => chrome.runtime.getURL(String(path).replace(/^\//, "")),
  });
  listeners.add((path, content) => DISK.write(path, content));
  await loadBuiltinSkills(HOST);
  HOST.load(saved);
  install(HOST);
  // The adapters were imported statically (skills/index.mjs): a service
  // worker may not import() at run time.
  await loadPlatforms(ROOT, { modules: BUILTIN_ADAPTERS });
  // `init`, every boot: the directory, the empty ledgers, the seeded memory
  // files — all idempotent, and the first boot has none of them.
  await verbs({ root: ROOT, dir: ROOT, log: () => {}, warn: () => {} }).init([]);
  E = engine({ root: ROOT, base: null });
  return E;
}

/** The built-in ring, out of the package: each skill's manifest by content,
 *  each seat by presence. A file the package does not carry is simply not a
 *  seat — the registry sees the folder the way it would on a disk. */
async function loadBuiltinSkills(host) {
  for (const id of BUILTIN_SKILLS) {
    for (const f of SKILL_FILES) {
      const url = chrome.runtime.getURL(`skills/${id}/${f}`);
      let res;
      try { res = await fetch(url); } catch { continue; }
      if (!res.ok) continue;
      host.load([[`/skills/${id}/${f}`, f.endsWith(".md") ? await res.text() : `// ${f}: imported from the package by URL`]]);
    }
  }
}
