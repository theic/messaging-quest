// The adapter seat: a platform — how to read somewhere. Delete this file if
// your skill reads nothing. The full contract, including the optional
// own-visibility set, the labels and the composer, is skills/README.md; the
// reference implementation with its dated page shapes is skills/reddit/.
//
// The lines that matter most:
//   Reads happen in the operator's own browser and nowhere else: read() is
//   handed a `browse` (lib/browse.mjs) on a leased tab and asks it for rows
//   by a declared spec — a selector and a field map the extension executes
//   in the page. There is no fetch, and no platform code runs in the page.
//   read() has three outcomes, never two — a page that could not be read is
//   not a page that said nothing.
//   gapMs is what the engine shows as the platform's pace; the control lane
//   holds the real gap between page turns.

export default {
  id: "example",
  name: "Example",
  gapMs: 6_000,

  /** One page, in the operator's browser. {ok:false, error} | {ok:true,
   *  entries, redirected, finalUrl, truncated}. Entries: {id, kind:
   *  "post"|"comment", url, author, title, body, at} with a
   *  platform-prefixed stable id — an id collision is silent data loss. */
  read: async (url, { browse }) => {
    const opened = await browse.open(url);
    if (opened.error) return { ok: false, error: opened.error };
    const got = await browse.extract({ items: "article", limit: 50, fields: { href: "href:a", title: "text:h2", body: "text:p", at: "attr:datetime@time" } });
    if (got.error) return { ok: false, error: got.error };
    return { ok: true, entries: [], redirected: false, finalUrl: got.url ?? url, truncated: false };
  },

  /** The page a person opens for a watched source — a room's new posts, or
   *  a phrase scoped to that room. */
  sourceUrl: ({ place, q }) => `https://example.com/${place}/new`,

  /** Reason-string or null. The shapes of reading this platform refuses,
   *  with the measurement that says why. */
  refuse: (src) => null,

  /** Which community a URL belongs to, or null — never a guess. */
  roomOf: (url) => null,

  /** What the platform's people actually write: "r/smallbusiness". */
  roomLabel: (place) => place,

  /** Optional: what the deck says when it means this platform, and the
   *  composer the Insert button looks for. Plain fallbacks apply when absent. */
  labels: { account: { question: "Which Example account is yours?", placeholder: "your-handle" } },
  composer: { opens: ["write a reply"], replies: ["reply"], hosts: [] },
};
