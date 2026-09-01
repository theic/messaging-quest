// Platforms are skills.
//
// A platform is a folder holding a SKILL.md (what it is, its norms, its
// measured facts — readable by a person or by an agent driving the CLI) and an
// adapter.mjs (the mechanics: how to read it, how fast it may be read, which
// shapes of reading it refuses). Reddit is the first and, deliberately, for
// now the only one: the plan is to master one platform before connecting a
// second, and to let the contract grow by EXTRACTION from working code rather
// than by speculation about platforms nobody has measured yet.
//
// Two places are searched, in order:
//
//   skills/            shipped with the tool
//   <dir>/skills/      yours — drop a folder into .earshot/skills/ and it
//                      loads, and on an id collision yours wins. This is the
//                      whole extension story: connecting a platform is writing
//                      one folder, not forking the repo.
//
// The direction rule that keeps this honest: lib/ never imports from skills/
// (this loader is the one door), and a skill may import from lib/. A platform
// that needs core changes is a contract gap to fix here, not a reason to reach
// around the seam.

import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** What every adapter must export (as `default`). Optional capabilities — the
 *  own-visibility set reddit carries (userFeed, threadFeed, commentFeed,
 *  threadOf) — are documented in skills/README.md and simply absent elsewhere. */
const REQUIRED = ["id", "name", "gapMs", "read", "sourceUrl", "refuse", "roomOf", "roomLabel"];

const loaded = [];

async function loadDir(root, origin) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "adapter.mjs");
    // A folder with only a SKILL.md is documentation, not a platform yet.
    if (!existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      const p = mod.default;
      const missing = REQUIRED.filter((k) => p?.[k] === undefined);
      if (missing.length) {
        console.error(`skill ${entry.name}: adapter.mjs is missing ${missing.join(", ")} — not loaded`);
        continue;
      }
      const at = loaded.findIndex((x) => x.id === p.id);
      if (at >= 0) loaded.splice(at, 1);   // later wins: local overrides built-in
      loaded.push({ ...p, origin });
    } catch (e) {
      // A broken local skill must not take the tool down with it — say so and
      // carry on with the platforms that do load.
      console.error(`skill ${entry.name}: ${e.message} — not loaded`);
    }
  }
}

// Built-ins load at import, not on request. The registry being empty is a
// QUIET failure — every room resolves to "?", standing goes blank, and nothing
// errors — so the only safe default is that importing this module is enough.
// The explicit call below exists for the one thing import time cannot know:
// where the data directory with local skills is.
await loadDir(BUILTIN, "built-in");

/** Called at startup by each entrypoint, with the data directory so LOCAL
 *  skills are found too. Idempotent — a second call reloads from scratch. */
export async function loadPlatforms(dir) {
  loaded.length = 0;
  await loadDir(BUILTIN, "built-in");
  if (dir) await loadDir(join(dir, "skills"), "local");
  return loaded;
}

export const platforms = () => [...loaded];
export const platform = (id) => loaded.find((p) => p.id === id) ?? null;

/** Which room does this URL belong to, on whichever platform recognises it?
 *  This is the one platform question core code (the store, the standing
 *  calculation) has to ask about a bare URL, so it is answered here rather
 *  than by importing any one skill. */
export const roomOf = (url) => {
  for (const p of loaded) {
    const r = p.roomOf?.(url);
    if (r) return r;
  }
  return null;
};
