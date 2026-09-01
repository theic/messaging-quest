// The platform door.
//
// A platform is a skill folder whose SKILL.md declares `provides:
// platform:<id>` and whose adapter.mjs exports the mechanics: how to read the
// place, how fast it may be read, which shapes of reading it refuses.
// Discovery, rings and slot resolution live in lib/skills.mjs — this file
// only imports the adapters of skills the registry says are ACTIVE, validates
// their shape, and answers the engine's platform questions.
//
// The direction rule that keeps this honest: lib/ never executes skill code
// except through a named door (this is the adapter door; bin/serve.mjs is the
// page door; agent/strategist.mjs is the agent door), and a skill may import
// from lib/. A platform that needs a core change is a contract gap to fix in
// skills/README.md, not a reason to reach around the seam.

import { pathToFileURL } from "node:url";
import { loadSkills, activeSeat } from "./skills.mjs";

/** What every adapter must export (as `default`). Optional capabilities — the
 *  own-visibility set reddit carries (userFeed, threadFeed, commentFeed,
 *  threadOf) — are documented in skills/README.md and simply absent elsewhere. */
const REQUIRED = ["id", "name", "gapMs", "read", "sourceUrl", "refuse", "roomOf", "roomLabel"];

const loaded = [];

async function importAdapters() {
  loaded.length = 0;
  for (const s of activeSeat("adapter")) {
    try {
      const mod = await import(pathToFileURL(s.seats.adapter).href);
      const p = mod.default;
      const missing = REQUIRED.filter((k) => p?.[k] === undefined);
      if (missing.length) {
        console.error(`skill ${s.id}: adapter.mjs is missing ${missing.join(", ")} — not loaded`);
        continue;
      }
      const at = loaded.findIndex((x) => x.id === p.id);
      if (at >= 0) loaded.splice(at, 1);   // later wins: local overrides built-in
      loaded.push({ ...p, origin: s.ring });
    } catch (e) {
      // A broken local skill must not take the tool down with it — say so and
      // carry on with the platforms that do load.
      console.error(`skill ${s.id}: ${e.message} — not loaded`);
    }
  }
}

// Built-ins load at import, not on request. The registry being empty is a
// QUIET failure — every room resolves to "?", standing goes blank, and nothing
// errors — so the only safe default is that importing this module is enough.
// The explicit call below exists for the one thing import time cannot know:
// where the data directory with local skills and the choice file is.
await importAdapters();

/** Called at startup by each entrypoint, with the data directory so LOCAL
 *  skills and the instance's slot choices are found too. Idempotent — a
 *  second call reloads from scratch. */
export async function loadPlatforms(dir) {
  loadSkills(dir);
  await importAdapters();
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
