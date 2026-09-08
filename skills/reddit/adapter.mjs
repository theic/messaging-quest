// The Reddit platform, as a skill.
//
// Everything mechanical about Reddit lives in this folder: the pages and
// their shapes (pages.mjs — read in the operator's own browser, the only
// mechanism there is), the shapes worth reading and the ones refused
// (shapes.mjs), and this file, which is the contract the engine sees. The
// engine — the store, the judge, the deck, the dashboard — knows none of
// those details; it asks for `read`, `sourceUrl`, `refuse`, `roomOf`, the
// labels a person sees, and the composer the Insert button looks for.
// Connect a second platform by writing this same folder for it;
// skills/README.md is the contract.

import { readPage, userPage, threadPage, commentPage, threadOf, subredditOf, postIdOf, itemOf, kindOf, SPECS, BODIES_PER_READ } from "./pages.mjs";
import { scoped, submissions, refuse, rulesUrl, isParody } from "./shapes.mjs";

export default {
  id: "reddit",
  name: "Reddit",

  /* ------------------------------------------------------------- reading */

  /** Reads happen in the operator's browser, paced by the control lane per
   *  site (lib/control.mjs: 6s plus up to 80% more between page turns — a
   *  guess at a person's tempo, dated 2026-09-04, not a measurement). This
   *  number is what the engine shows as the platform's pace. */
  gapMs: 6_000,

  /** Three outcomes, never two: {ok:false, error} | {ok:true, entries, ...}.
   *  `browse` is the engine's browser on a lease (lib/browse.mjs);
   *  `stranger` reads are the verbs' business, chosen when the lease opens. */
  read: (url, { browse }) => readPage(url, browse),
  /** One post's page — its full body and author, for a post a search or a
   *  listing only previewed. */
  readPost: (url, { browse }) => readPage(url, browse, { kind: "post" }),
  /** How many previewed posts one finding read opens for their bodies. */
  bodiesPerRead: BODIES_PER_READ,
  kindOf,
  specs: SPECS,

  /* ------------------------------------------------------------- finding */

  /** The page for a watched source. A phrase makes it a scoped search;
   *  none makes it the room's new submissions. */
  sourceUrl: ({ place, q, window }) => (q ? scoped(place, q, window) : submissions(place)),

  /** Shapes this platform refuses to read, with the measurement that says why. */
  refuse,

  /* --------------------------------------------------------------- rooms */

  roomOf: subredditOf,
  roomLabel: (place) => `r/${place}`,
  /** A post's stable id off its permalink (t3_…), and what a permalink
   *  names ({id, kind}) — the platform's to say, so a colleague cannot
   *  invent an id and first-write-wins stays honest. */
  idOf: postIdOf,
  itemOf,
  /** Where a human reads the room's rules — Reddit does not serve them to a
   *  logged-out reader, so a person has to look once. */
  rulesUrl,
  /** Reddit's own convention for parody communities. */
  parody: isParody,

  /* ------------------------------------------------------------- account */

  /** What the browser already knows, so nobody has to type their own name.
   *  The cookies are checked for PRESENCE only — Reddit's carry a session,
   *  not a handle, so they answer "signed in here" and nothing more. The
   *  handle comes from /user/me/, which Reddit redirects to your own profile
   *  when you are signed in and to a login page when you are not: the answer
   *  is in the address, and the page itself is never parsed. */
  account: {
    cookies: { url: "https://www.reddit.com/", names: ["reddit_session", "token_v2"] },
    whoami: {
      url: "https://www.reddit.com/user/me/",
      of: (url) => {
        const m = /^https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/user\/([^/?#]+)/i.exec(String(url ?? ""));
        const name = m ? decodeURIComponent(m[1]) : "";
        return /^[\w-]{3,20}$/.test(name) && !/^me$/i.test(name) ? name : null;
      },
    },
  },

  /* -------------------------------------------------------------- labels */

  /** What the deck and the dashboard say when they mean this platform. The
   *  heart's cards carry no platform word of their own (lib/cards.mjs). */
  labels: {
    account: { question: "Which Reddit account is yours?", help: "Your own public profile is read the way a logged-out stranger reads it — in an Incognito tab of your own Chrome. Nothing is posted, nothing is sent.", placeholder: "your-username" },
    room: { question: "Which subreddit should it look in first?", placeholder: "smallbusiness", help: "One subreddit to start. It gets probed — one read, no commitment — and watched only if what comes back clears the floor." },
    phrase: { placeholder: "how do I get clients" },
    rules: "Reddit does not show a subreddit's rules to a logged-out reader — measured, not assumed — so a human reads them once and the answer is recorded. Until then nothing here counts this room as ready.",
    submit: "Reddit's own Comment button",
    appeals: "https://www.reddit.com/appeals",
  },

  /** The composer the Insert flow looks for: the labels that open one and
   *  the labels of a reply box, the custom elements that host one, and the
   *  element that holds one comment — so a comment on the post goes into
   *  the thread's own box ("Join the conversation", a twenty-pixel textarea
   *  that a click swaps for the real editor, measured 2026-09-07) and never
   *  under the first comment's Reply. The words that may never be pressed
   *  are the extension's own list, not a platform's (extension/screen.js). */
  composer: {
    opens: ["add a comment", "add comment", "write a comment", "leave a comment", "join the conversation"],
    replies: ["reply", "write a reply", "reply to post", "comment"],
    hosts: ["shreddit-composer", "comment-composer-host"],
    comments: ["shreddit-comment"],
  },

  /* ------------------------------------- own-visibility (optional set) --- */
  // The capability the tool was born from: reading YOUR account the way a
  // stranger reads it — in an Incognito tab. A platform without these simply
  // cannot run sync/check/back, and the engine says so instead of guessing.

  userPage,
  threadPage,
  commentPage,
  threadOf,
};
