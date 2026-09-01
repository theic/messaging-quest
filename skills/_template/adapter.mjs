// The adapter seat: a platform — how to read somewhere. Delete this file if
// your skill reads nothing. The full contract, including the optional
// own-visibility set and the browser-relay lane, is skills/README.md; the
// reference implementation with its measurements is skills/reddit/.
//
// The two lines that matter most:
//   gapMs is the platform's MEASURED pace, not a politeness guess.
//   read() has three outcomes, never two — a feed that could not be read is
//   not a feed that said nothing.

export default {
  id: "example",
  name: "Example",
  gapMs: 60_000, // measured on <date>, and the measurement belongs in SKILL.md

  /** One fetch. {ok:false, error} | {ok:true, entries, redirected, truncated}.
   *  Entries: {id, kind: "post"|"comment", url, author, title, body, at} with
   *  a platform-prefixed stable id — an id collision is silent data loss. */
  read: async (url) => ({ ok: false, error: "not implemented" }),

  /** The URL for a watched source — a room's new posts, or a phrase scoped
   *  to that room. */
  sourceUrl: ({ place, q }) => `https://example.com/${place}/new`,

  /** Reason-string or null. The shapes of reading this platform refuses,
   *  with the measurement that says why. */
  refuse: (src) => null,

  /** Which community a URL belongs to, or null — never a guess. */
  roomOf: (url) => null,

  /** What the platform's people actually write: "r/smallbusiness". */
  roomLabel: (place) => place,
};
