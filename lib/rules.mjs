// Whether a room's own rules forbid what you would be doing there.
//
// This is the refusal no competitor ships, and §05 records why it matters:
// ReddGrow's picker returned r/languagelearningjerk — a parody community, the
// `-jerk` suffix is Reddit's own convention — as an "Excellent Match" at
// 100/100, and beside it r/slp at 80/100, with that subreddit's own rule
// rendered on the card: "No recruiters ever. Seriously. Never. Don't self-…".
// It displayed the rule prohibiting its use case and scored it Excellent.
//
// ## What is reachable without an account — measured 2026-08-28
//
//   /r/<sub>/about.rss     404 (and a 404 dressed as well-formed Atom)
//   /r/<sub>/about.json    403, like every .json path
//   /r/<sub>/new/.rss      200, carries <subtitle> — the SHORT description
//
// **And the short description is not the rules.** Measured on r/slp, which is
// the roadmap's own example of a room that must be refused: its `<subtitle>` is
// the community blurb — "A community of Speech-Language Pathologists…" — and
// contains no rule at all. The sentence that forbids recruiters lives in the
// sidebar, which Reddit does not serve to a logged-out reader.
//
// So a keyless rules check would have returned `clear` for the exact subreddit
// the whole refusal exists to catch. That is the ReddGrow failure with the sign
// flipped, and shipping it would have been worse than shipping nothing.
//
// Hence the design: the description is checked because it is free and does
// catch the blunt cases, and everything else is UNANSWERED until a human or a
// browser-lane agent reads the sidebar once and writes it down. §07 already has
// the shape for that — `rooms/<sub>.md`, "the rules as read, your standing
// there, your history". A room whose file is unanswered cannot be watched.

import { bansPromotion } from "./sources.mjs";

export const RULES = {
  banned: "its own words forbid it",
  unanswered: "nobody has read this room's rules yet",
  allowed: "you read the rules and recorded that they permit it",
};

/**
 * What the free, keyless read can tell us — which is less than it looks.
 *
 * Never returns "clear". The strongest thing an absent phrase supports is
 * `unanswered`, because the text being searched is the wrong text.
 */
export function fromDescription(subtitle) {
  const hit = bansPromotion(subtitle);
  if (hit) return { state: "banned", quote: hit, source: "the public description" };
  return {
    state: "unanswered",
    why: String(subtitle ?? "").trim()
      ? "nothing in the public description forbids promotion — but the description is not the rules list, and Reddit does not serve the sidebar to a logged-out reader"
      : "this subreddit publishes no description a logged-out reader can see",
  };
}

/** Reddit's own convention for parody communities — the class a competitor's
 *  picker put at the top of its list at 100/100. Free to check. */
export const isParody = (place) => /jerk$/i.test(String(place ?? ""));

/** Where a person goes to settle it in fifteen seconds. */
export const sidebarUrl = (place) => `https://www.reddit.com/r/${place}/about/rules`;

/** The room file, in the markdown shape §07 specifies: the file always wins,
 *  and it is correctable line by line by the person who owns the account. */
export const roomFile = (place, found) => `# r/${place}

## Do the rules permit promotion here?

promotion_allowed: UNANSWERED

Reddit does not serve this subreddit's rules to a logged-out reader, and the
public description is not the rules list — measured, and the reason this line
exists rather than being guessed at.

**Read them once:** ${sidebarUrl(place)}

Then set the line above to \`yes\` or \`no\`. Until it says something, this room
cannot be watched — \`es watch\` refuses it, deliberately.

${found ? `> The public description already says: "${found}"\n>\n> That alone is enough to answer \`no\`.\n` : ""}
## Your standing here

comments: unknown — \`es ready\` measures this once you have history
`;

/** UNANSWERED is a state, not a default to be quietly treated as yes. */
export function readRoomFile(text) {
  const m = String(text ?? "").match(/^promotion_allowed:\s*(\S+)/mi);
  const v = (m?.[1] ?? "").toLowerCase();
  if (v === "yes" || v === "true") return { state: "allowed" };
  if (v === "no" || v === "false") return { state: "banned", source: "your own note in the room file" };
  return { state: "unanswered" };
}
