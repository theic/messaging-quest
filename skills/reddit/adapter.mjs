// The Reddit platform, as a skill.
//
// Everything mechanical about Reddit lives in this folder: the anonymous
// transport and its measured rate (feed.mjs), the shapes worth reading and the
// ones refused (shapes.mjs), and this file, which is the contract the engine
// sees. The engine — the store, the pacing loop, the judge, the dashboard —
// knows none of those details; it asks for `read`, `sourceUrl`, `refuse`,
// `roomOf`, and holds `gapMs` between requests. Connect a second platform by
// writing this same folder for it; skills/README.md is the contract.

import { ANON_GAP_MS, waitFor, read, parseFeed, userFeed, threadFeed, commentFeed, threadOf, subredditOf } from "./feed.mjs";
import { scoped, submissions, refuse } from "./shapes.mjs";
import { sidebarUrl, isParody } from "../../lib/rules.mjs";

export default {
  id: "reddit",
  name: "Reddit",

  /* ------------------------------------------------------------- reading */

  /** One anonymous request per 65s, per address — Reddit's own number, read
   *  off its rate-limit headers, not a politeness setting. See feed.mjs. */
  gapMs: ANON_GAP_MS,
  waitFor,

  /** Three outcomes, never two: {ok:false, error} | {ok:true, entries, ...}.
   *  "Nothing there" is only ever expressible by the second. */
  read,
  parseFeed,

  /* ------------------------------------------------------------- finding */

  /** The feed URL for a watched source. A phrase makes it a scoped search;
   *  none makes it the room's new submissions. */
  sourceUrl: ({ place, q, window }) => (q ? scoped(place, q, window) : submissions(place)),

  /** Shapes this platform refuses to read, with the measurement that says why. */
  refuse,

  /* --------------------------------------------------------------- rooms */

  roomOf: subredditOf,
  roomLabel: (place) => `r/${place}`,
  /** Where a human reads the room's rules — Reddit does not serve them to a
   *  logged-out reader, so a person has to look once. */
  rulesUrl: sidebarUrl,
  /** Reddit's own convention for parody communities. */
  parody: isParody,

  /* ------------------------------------- own-visibility (optional set) --- */
  // The capability the tool was born from: reading YOUR account the way a
  // stranger reads it. A platform without these simply cannot run sync/check/
  // back, and the engine says so instead of guessing.

  userFeed,
  threadFeed,
  commentFeed,
  threadOf,
};
