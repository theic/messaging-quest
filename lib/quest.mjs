// The customer's path through the engine, as data (Stage 1 of the Quest plan,
// 2026-09-18). Zero-dependency on purpose: the engine calls it on its clock,
// Quest's tools call it from agent/, and the tests hold it on a bare Node.
//
// THE OFFER is what the site reader (lib/agents.mjs scoutSite) understood,
// turned into the one question a customer is asked: "you sell X to Y; I'll
// look for people who say Z, in these communities — looks right?" It lives in
// the project's stash (lib/cards.mjs) while it is open, as a card in the chat
// (lib/chat.mjs), and — once confirmed — as the three memory files the judge
// and the writer already read (project.md, icp.md, rule.md). Nothing here
// asks a customer for a keyword, a subreddit or a campaign; the reader picks,
// they correct.

/** How many communities the first look tries. The reader proposes up to six;
 *  three is enough to find out which of them has the people, and each one is
 *  a real page turn in a real browser. */
export const FIRST_LOOK = 3;

const text = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const bare = (p) => String(p ?? "").trim().replace(/^\/?r\//i, "").replace(/[^\w-]/g, "").slice(0, 40);

/** The reader's proposal as an offer: the fields the card shows and the
 *  files a confirmation writes. Places are bare community names, deduped. */
export function offerFrom(p = {}) {
  const places = [...new Set((Array.isArray(p.places) ? p.places : []).map(bare).filter(Boolean))];
  return {
    name: text(p.name, 80),
    one_line: text(p.one_line, 300),
    problem: text(p.problem, 200),
    places: places.slice(0, 6),
    project_md: String(p.project_md ?? "").trim(),
    icp_md: String(p.icp_md ?? "").trim(),
    rule_md: String(p.rule_md ?? "").trim(),
    unknown: (Array.isArray(p.unknown) ? p.unknown : []).map((u) => text(u, 200)).filter(Boolean).slice(0, 5),
    leave_out: [],
  };
}

/** What a customer's own correction changes. Only the fields a person would
 *  ask to change in a chat; the long files are rewritten from them, never
 *  hand-edited here. `leave_out` adds to the list — "and not agencies" is
 *  said once and meant for good. */
export function revise(offer, patch = {}) {
  const next = { ...offer };
  if (patch.one_line) next.one_line = text(patch.one_line, 300);
  if (patch.problem) next.problem = text(patch.problem, 200);
  if (Array.isArray(patch.places) && patch.places.length) next.places = [...new Set(patch.places.map(bare).filter(Boolean))].slice(0, 6);
  if (Array.isArray(patch.leave_out)) next.leave_out = [...new Set([...(offer.leave_out ?? []), ...patch.leave_out.map((x) => text(x, 120)).filter(Boolean)])].slice(0, 12);
  return next;
}

/** rule.md as the judge will read it: the reader's rule, plus whoever the
 *  customer said to leave out, as a section the judge cannot miss. */
export function ruleOf(offer) {
  const base = offer.rule_md || `# Who to answer\n\nAnswer YES when somebody describes this problem: ${offer.problem}`;
  if (!offer.leave_out?.length) return base + "\n";
  return `${base}\n\n## Leave out — the customer said so\n\nAnswer NO for these, however well they fit otherwise:\n${offer.leave_out.map((x) => `- ${x}`).join("\n")}\n`;
}

/** The files a confirmation writes. */
export const filesOf = (offer) => ({
  "project.md": (offer.project_md || `# ${offer.name}\n\n${offer.one_line}`) + "\n",
  "icp.md": (offer.icp_md || `# Who it is for\n\nPeople who say: "${offer.problem}"`) + "\n",
  "rule.md": ruleOf(offer),
});

const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The confirm card — the message and the card on it. `room` turns a bare
 * name into what the platform's people write ("r/saas"); the engine hands
 * in the platform's own (lib/platform.mjs labelsOf).
 */
export function offerCard(offer, { room = (p) => p } = {}) {
  const where = offer.places.slice(0, FIRST_LOOK).map(room);
  const lines = [
    `Here's what I understood: ${offer.one_line || offer.name}`,
    `I'll look for people who say things like “${offer.problem}”${where.length ? ` — starting in ${list(where)}` : ""}.`,
    offer.leave_out?.length ? `Leaving out: ${list(offer.leave_out)}.` : "",
    "Looks right?",
  ].filter(Boolean);
  return {
    text: lines.join("\n\n"),
    card: {
      kind: "offer",
      state: "open",
      actions: [{ id: "confirm", label: "Looks right" }, { id: "change", label: "Change something" }],
    },
  };
}

/* ------------------------------------------------------ the first look */

/** How often a watched community is read again, in minutes: a few times a
 *  day. One browser at a person's pace reads a community in a minute or two,
 *  so hourly reads across many customers do not fit in an hour. */
export const EVERY_MIN = 240;

/** The campaign every customer's finds are made under. Campaigns are the
 *  operator's word and never reach a customer's screen; here it is the one
 *  switch the writer already reads for whether a first reply may name what
 *  they built — disclosed, as theirs, where it answers the question. */
export const CAMPAIGN = "quest";
export const campaignOf = (offer) => ({
  id: CAMPAIGN,
  name: "Quest",
  idea: `People describing this problem: "${offer.problem}". Answer what they asked first, in a sentence or two of real help. Where ${offer.name || "what they built"} genuinely answers it, say plainly that you built it and what it does — once, no link unless they ask.`,
  fit: offer.leave_out?.length ? `Not: ${offer.leave_out.join(", ")}.` : "",
  never: "Never pretend to be a customer or a neutral bystander. Never a link in a first reply.",
  mention: "disclosed",
  status: "active",
  platform: null,
});

/** me.md for a customer: what they may say about themselves in a reply —
 *  that they built the thing on their own site, and what it does. Written
 *  only when the file is still the seed; a customer's own words win. */
export const meOf = (offer) => `# What I have built\n\nI built ${offer.name || "this"}: ${offer.one_line}\n`;

/** The communities the first look takes, in order, each with its state:
 *  rules → todo | reading | allowed | banned | failed
 *  probe → todo | running | done | failed
 *  watch → todo | watched | refused */
export const lookRooms = (places, q) => places.map((place) => ({ place: bare(place), q, rules: "todo", probe: "todo", watch: "todo", tries: 0 }));

/** A communities list, as Quest's turn is told it. */
export function lookLine(look, { room = (p) => p } = {}) {
  const rooms = look?.rooms ?? [];
  if (!rooms.length) return "";
  const say = (r) => {
    const name = room(r.place);
    if (r.rules === "banned") return `${name} (skipped — its own rules forbid promotion)`;
    if (r.rules === "failed" || r.probe === "failed") return `${name} (could not be read)`;
    if (r.watch === "watched") return `${name} (read, and watched a few times a day)`;
    if (r.watch === "refused") return `${name} (read; too few people with this problem to watch)`;
    if (r.probe === "done") return `${name} (read; being judged)`;
    if (r.probe === "running" || r.rules === "reading") return `${name} (being read now)`;
    return `${name} (next)`;
  };
  return `Communities: ${rooms.map(say).join("; ")}.`;
}

/** An opportunity as plain text — what an email or a Telegram message would
 *  show, and what the transcript keeps for any reader that does not know
 *  this card's shape. */
export const opportunityText = (r, { room = (p) => p } = {}) =>
  [`${room(r.place)}${r.author ? ` · u/${r.author}` : ""} — “${text(r.title || r.body, 200)}”`, r.why ? `Why it fits: ${text(r.why, 300)}` : "", r.url].filter(Boolean).join("\n\n");

/**
 * Where things stand, in one line, for the front of Quest's turn — so it
 * never offers to read a site that is already being read, or asks a question
 * the card already asks.
 */
export function offerLine({ offer = null, scout = "none", url = null, attempts = 0, material = null } = {}) {
  if (offer?.state === "confirmed") return `They confirmed what they sell: ${offer.one_line} — looking for people who say "${offer.problem}"${offer.places?.length ? ` in ${offer.places.slice(0, FIRST_LOOK).join(", ")}` : ""}${offer.leave_out?.length ? `; leaving out ${offer.leave_out.join(", ")}` : ""}.`;
  if (offer) return `Your reading of what they sell is in the chat as a card, waiting for their answer: "${offer.one_line}", people who say "${offer.problem}", in ${offer.places.slice(0, FIRST_LOOK).join(", ") || "no communities yet"}. If they want something changed, use revise_offer — do not ask them to confirm again in words.`;
  const what = url ? `Their site (${url})` : material === "cv" ? "Their CV" : material === "about" ? "Their description of what they sell" : null;
  if (what && scout === "running") return `${what} is being read right now; what was understood arrives here as a card for them to confirm. Do not read it yourself.`;
  if (what && attempts >= 3) return `${what} could not be read after ${attempts} tries — ${url ? "ask whether the address is right, or" : "ask them"} to describe what they sell and who buys it in a sentence or two (then describe_offer).`;
  if (what) return `${what} is queued to be read and will be read by itself — do not read it yourself; say it is on its way.`;
  return "They have not given a site yet. Ask for its address (set_site), or for a sentence or two about what they sell and who buys it (describe_offer).";
}
