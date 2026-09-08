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

import { moduleUrl } from "./fs.mjs";
import { loadSkills, activeSeat } from "./skills.mjs";

/** What every adapter must export (as `default`). Optional capabilities — the
 *  own-visibility set reddit carries (userFeed, threadFeed, commentFeed,
 *  threadOf) — are documented in skills/README.md and simply absent elsewhere. */
const REQUIRED = ["id", "name", "gapMs", "read", "sourceUrl", "refuse", "roomOf", "roomLabel"];

const loaded = [];

/** Adapter modules a host imported itself, by skill id — the extension's
 *  worker (0.10.0): a service worker may not import() at run time, so
 *  skills/index.mjs imports the built-ins statically and the worker hands
 *  them in through loadPlatforms. A skill named here skips the import. */
let provided = {};

async function importAdapters() {
  loaded.length = 0;
  for (const s of activeSeat("adapter")) {
    try {
      const mod = provided[s.id] ?? await import(moduleUrl(s.seats.adapter));
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

// Nothing loads at import. Every entry point — the CLI, the dashboard, the
// tests, the extension's worker — calls loadPlatforms(dir) before its first
// platform question, with the one thing import time cannot know: where the
// data directory with local skills and the choice file is. Built-ins used to
// load here too, at the top of the module; a service worker may not await
// there (0.10.0), and the extension runs this same file. The registry being
// empty stays a QUIET failure — every room resolves to "?", standing goes
// blank, nothing errors — which is why each entry point loads first.

/** Called at startup by each entrypoint, with the data directory so LOCAL
 *  skills and the instance's slot choices are found too. Idempotent — a
 *  second call reloads from scratch. */
export async function loadPlatforms(dir, { modules = {} } = {}) {
  provided = modules ?? {};
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

/** The same question, asked by an instance that has said which one it means
 *  (the stash's `platform`). Everything that does not name a platform of its
 *  own — a probe, a new campaign, the words on the panel — goes through here,
 *  so that adding a second skill adds a choice rather than a surprise. An id
 *  naming a platform that is not loaded falls back rather than failing: a
 *  skill can be turned off long after something chose it. */
export const preferred = (id) => (id ? platform(id) : null) ?? first();

/**
 * What THIS BROWSER can already say about your account here, before anything
 * is read. Two optional declarations, both data:
 *
 *   cookies  the names Chrome would be holding if you were signed in, and
 *            the site to look on. Presence only — no value is ever read out
 *            of a cookie, and nothing is requested from the network.
 *   whoami   an address that redirects to your own profile when you are
 *            signed in, so the handle arrives in the URL bar and no page has
 *            to be parsed for it.
 *
 * A platform that declares neither simply asks the person, as every platform
 * did before 0.11.0.
 */
export function accountOf(p = first()) {
  const a = p?.account ?? {};
  const c = a.cookies;
  return {
    cookies: c?.url && Array.isArray(c.names) && c.names.length ? { url: String(c.url), names: c.names.map(String).slice(0, 8) } : null,
    whoami: a.whoami?.url && typeof a.whoami.of === "function" ? String(a.whoami.url) : null,
  };
}

/** The handle that address landed on, by the platform's own reading of it. */
export const whoamiOf = (p, url) => {
  try { return p?.account?.whoami?.of?.(String(url ?? "")) || null; } catch { return null; }
};

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
    /** The inverse: a room as the store keeps it, from whatever a person
     *  typed. Whatever roomLabel decorates a place with ("r/" here, "~"
     *  somewhere else) is taken off again, so no core file has to know the
     *  decoration and "r/saas", "saas" and " R/SAAS " are one room. */
    bare: (typed) => {
      let v = String(typed ?? "").trim();
      const [pre, post] = (p?.roomLabel ? String(p.roomLabel("\u0001")) : "\u0001").split("\u0001");
      if (pre && v.toLowerCase().startsWith(pre.toLowerCase())) v = v.slice(pre.length);
      if (post && v.toLowerCase().endsWith(post.toLowerCase())) v = v.slice(0, -post.length);
      return v.replace(/[^\w-]/g, "");
    },
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
    /** Whether this platform can be ASKED who you are, rather than you being
     *  asked (accountOf().whoami). The cards use it to offer the browser
     *  before they offer a text field. */
    whoami: Boolean(p?.account?.whoami?.url && typeof p.account.whoami.of === "function"),
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
