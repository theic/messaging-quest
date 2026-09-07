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

/** The platform a surface means when it says nothing else: the first
 *  active one. One today, on purpose; when there are two, the source, the
 *  account and the campaign each name theirs and this is only the default. */
export const first = () => loaded[0] ?? null;

/** The platform a URL belongs to, by whoever recognises one of its rooms. */
export const platformFor = (url) => loaded.find((p) => p.roomOf?.(url)) ?? null;

/**
 * What a surface says when it means this platform — the heart carries no
 * platform word of its own (lib/cards.mjs, bin/serve.mjs). Every label has a
 * plain fallback so a platform that declares none still reads as English,
 * and `room(place)` is the one function: "r/saas", "~lobsters", whatever the
 * platform's people actually write.
 */
export function labelsOf(p = first()) {
  const L = p?.labels ?? {};
  return {
    id: p?.id ?? null,
    name: p?.name ?? "the platform",
    room: (place) => (p?.roomLabel ? p.roomLabel(place) : String(place ?? "")),
    rulesUrl: (place) => (p?.rulesUrl ? p.rulesUrl(place) : null),
    account: {
      question: L.account?.question ?? (p ? `Which ${p.name} account is yours?` : "Which account is yours?"),
      help: L.account?.help ?? "Your own public profile is read the way a logged-out stranger reads it. Nothing is posted, nothing is sent.",
      placeholder: L.account?.placeholder ?? "your-username",
    },
    roomAsk: {
      question: L.room?.question ?? "Which room should it look in first?",
      help: L.room?.help ?? "One room to start. It gets probed — one read, no commitment — and watched only if what comes back clears the floor.",
      placeholder: L.room?.placeholder ?? "a-room",
    },
    phrase: { placeholder: L.phrase?.placeholder ?? "how do I get clients" },
    rules: L.rules ?? "A room's rules are read once by a human and the answer recorded. Until then nothing here counts this room as ready.",
    submit: L.submit ?? "the platform's own button",
    /** Where an account appeals a suspension or a shadowban, when the
     *  platform has such a page — the door on the 404 finding. */
    appeals: L.appeals ?? null,
  };
}

/** The composer the Insert flow looks for on this platform's pages — the
 *  words that open one, the words on a reply box, the elements that host a
 *  composer and the elements that hold one comment (so a comment on the
 *  post lands in the thread's box and a reply under the person's own
 *  comment). The words that may never be pressed are the extension's, not
 *  a platform's. */
export const composerOf = (url) => {
  const p = platformFor(url) ?? first();
  const c = p?.composer ?? {};
  const list = (v) => (Array.isArray(v) ? v : []);
  return { opens: list(c.opens), replies: list(c.replies), hosts: list(c.hosts), comments: list(c.comments) };
};

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
