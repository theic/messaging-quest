import { voiceRules } from "./voice.mjs";
/**
 * How a reply to a public post gets written. These rules are DELIBERATELY not
 * the cold-email rules in lib/copy.ts — that prompt demands a yes/no question,
 * which is exactly wrong here. This person asked for something in public. The
 * winning move is to answer them.
 *
 * The rules are handed to the connected assistant (it is the writer, on the
 * user's own AI subscription) rather than run through our own model, so this
 * module is plain text and costs nothing.
 *
 * ── THE FIRST MESSAGE NEVER PROMOTES (owner, 20260811, again 20260813) ──────
 * This is a REVERSAL of what this file used to say, so both sides are written
 * down. Read them before softening it back.
 *
 * What it said: the mention is the point, a reply without one is a comment that
 * grows karma and sells nothing, and a draft with nowhere honest to name the
 * product should be ABANDONED rather than posted. That came from a real
 * observation — a 96/100 lead answered with three paragraphs of free
 * landing-page critique and the product never named, which the owner called
 * "warming up the account" and meant as a complaint.
 *
 * What is true now: warming the account IS the job of message one. Not as a
 * consolation prize for a lead that did not qualify, but on purpose, for a lead
 * that did. The qualification has not moved an inch — ./browsing.ts still asks
 * whether what the user built is the honest answer to this post, and a lead
 * that cannot pass it is still thrown away. What moved is WHERE that clause is
 * said: it goes on the card the user reads (`why`, `why_them`), and it stays
 * out of the message the stranger reads.
 *
 * Why that is not the same failure with a nicer name:
 *   - The account is the asset, and every mention spends a little of it. On the
 *     platforms this product actually reads, a first-contact plug from an
 *     account nobody recognises is the single most reportable thing available.
 *   - A reply that helps and asks for nothing is the only kind a stranger can
 *     read without deciding what you want. The mention has somewhere to go
 *     afterwards: they reply, and ./draft-prompt.ts's conversation branch is
 *     where naming what you built is expected rather than intrusive.
 *   - The thing the old rule was protecting against was free consulting for
 *     somebody who was never a buyer. The gate protects against that, upstream,
 *     and it did before this change.
 *
 * THE COST, stated plainly because it is real: nothing this product writes now
 * asks for anything on a first touch, so revenue depends entirely on people
 * writing back. If the reply rate does not carry it, this is the decision to
 * revisit — not the gate, and not by quietly re-admitting a small mention.
 *
 * ── THE SPLIT (Track A) ────────────────────────────────────────────────────
 * There are two kinds of rule in here and they used to be one list, which is
 * how a house style ended up shipping as if it were a fact about writing.
 *
 * UNIVERSAL_RULES are ethics and channel mechanics: answer the person, give
 * something real, invent nothing, do not trash the tool they are leaving. They
 * are not overridable by anybody's voice, and the prompt says so out loud.
 *
 * Everything that is TASTE — casing, register, sentence length, punctuation,
 * greeting, hedging, emoji — has left this file for ./voice.ts, where it is
 * measured off the user's own messages instead of asserted about everybody.
 * "Lowercase starts are fine" and "the way a non-native speaker writes" went
 * into every draft this product has ever written, and they were one person's
 * voice wearing the clothes of a fact.
 */
/**
 * Phrases that mark a message as machine-written. The assistant is asked to
 * check its own draft against this list and rewrite anything it hits — a
 * cheaper and more reliable guard than hoping the style instructions held.
 *
 * Punctuation is NOT on this list any more. It was ("em dashes, exclamation
 * marks, emoji"), and it was also a rule below, so the model stripped emoji
 * again after the rules had allowed them — lifting the ban in one place did
 * nothing, which is exactly the bug that made this list worth re-reading.
 * The fingerprint owns punctuation now, in one place, with an override.
 */
export const AI_TELLS = [
    "I hope this message finds you well",
    "I hope you're doing well",
    "I noticed you're / I came across your post (as an opener)",
    "I'd love to / I would love to",
    "Let me know if you have any questions",
    "Feel free to reach out",
    "I'm reaching out because",
    "Happy to help!",
    "delve, leverage, streamline, robust, seamless, elevate, unlock, empower",
    "In today's fast-paced world",
    "rule-of-three lists (fast, reliable, and scalable)",
    "a closing line that restates the opening line",
    "Best regards / Looking forward to hearing from you",
];
/**
 * The rules a voice may not overrule. Ethics, honesty, and what a comment in
 * somebody else's thread is allowed to be — none of it is a matter of style,
 * and a fingerprint that says otherwise is a fingerprint we measured wrong.
 */
const UNIVERSAL_RULES = [
    "Write it as a reply to THIS post, in the same place they posted. Not an email, not a pitch.",
    // The campaign's `language` is a filter on what gets HUNTED and deliberately
    // says nothing here (lib/signals/campaigns.ts). Which language to reply in is
    // not a setting — it is a fact about the post, readable off the post, and a
    // campaign-wide answer to it would eventually reply in English to somebody
    // who wrote in German, which reads worse than never answering at all.
    "Write in the language the post is written in. If they wrote in German, reply in German; if they mixed two, follow the one their question is in. Never switch a thread into another language.",
    "First line: answer them or say the useful thing. No introducing yourself, no restating their question back at them.",
    "Give something real, and give it first. A concrete first step, the specific gotcha they are about to hit, a number, a link to the exact doc section, the two-line version of the fix. If you can solve part of it in the message, solve it.",
    "Be specific to their post. If the same sentence would fit any other post on the forum, cut it.",
    "It is a comment in a thread, not a post of your own. One or two short paragraphs, and stop when the useful part stops. No bullet lists, no headings, no bold.",
    "Ordinary words. No marketing register, nothing that reads as copy.",
    "No sign-off and no signature.",
    "Never claim you did something you did not do, never invent experience, never invent numbers.",
    // The second half of this used to say "say the one concrete way yours is
    // different", which is a comparison to the user's product and therefore a
    // mention. It moved to CONVERSATION_RULES; what is left is the part that
    // holds on any message.
    "If they name a tool they are leaving or comparing against, do not trash it. Everyone in that thread knows that tool better than a stranger's opinion of it, and running it down is the fastest way to look like a vendor.",
    "Check the finished draft against the AI tells list. If it contains any of them, rewrite that part.",
];
/**
 * MESSAGE ONE: HELP THEM, SELL NOTHING.
 *
 * Same for both intents, and that is not laziness — "answer the person and say
 * nothing about yourself" is one job whether the user sells their time or a
 * product. The intent only starts to matter once somebody writes back.
 *
 * The rule is absolute rather than graded on purpose. "Keep the mention small",
 * "only if it fits", "one clause at the end" are all instructions a model
 * satisfies by writing a small pitch, and a small pitch from a stranger is the
 * same object as a large one to the person reading it. There is no dial here.
 */
const OPENER_RULES = [
    "THIS IS THE FIRST MESSAGE TO THIS PERSON AND IT SELLS NOTHING. Do not name what the user built, do not link to it, do not describe it, and do not gesture at it. Not in the first line, not in the last, not as a PS, not as 'something I've been working on', not as 'I had this exact problem so I made a thing'. There is no small version of this that is allowed.",
    "That is not a softer pitch, it is a different message. Write the reply the user would write if they had nothing to sell at all.",
    "So it has to be worth posting on its own merits: the concrete first step, the specific gotcha they are about to hit, the number, the exact doc section, the two-line version of the fix. If you can solve part of their problem inside the message, solve it.",
    "No ask of any kind. Do not ask for a call, do not ask them to DM you, do not ask them to look at anything, do not offer to help further in a way that is a pitch wearing a question mark.",
    "One small concrete question about their setup is allowed and is usually the best ending — a real question you would want the answer to, not a hook. It is also the thing most likely to get a reply, which is where the rest of this goes.",
    "If there is genuinely nothing useful to say without naming the product, report it as a no-fit and take the next lead. That is a real answer. A reply that is obviously an ad with the ad removed is worse than no reply.",
];
/**
 * ONCE THEY HAVE WRITTEN BACK, and only then.
 *
 * This is the branch the openers exist to reach, and the mention rules that
 * used to run on every draft live here now, unchanged in substance: name it
 * once, plainly, and say it is yours.
 *
 * The failure mode these still guard is covert promotion — recommending your
 * own product while sounding like a passer-by who just happens to like it. It
 * is deceptive to everyone else reading the thread, most communities ban it
 * outright, and it is the single most detectable thing you can do. In the very
 * thread this rule set came from, a top commenter was already asking the poster
 * "how many different accounts have you posted this same slop with". An
 * undisclosed plug is a ban with a delay on it, and the account is the asset.
 *
 * Disclosed beats hidden on the merits anyway. "i built X for exactly this" is
 * a stronger recommendation than "you should try X", because the reader can see
 * who is talking and weigh it.
 */
const CONVERSATION_RULES = {
    freelance: [
        "They wrote back, so this is a conversation and not a cold comment. Answer what they actually said first.",
        "Saying you do this for a living is now honest and expected, once, in one plain clause ('i do this kind of thing for people, happy to help if useful'). Never a rate card, never a portfolio dump, never 'I have X years of experience'.",
        "Only if it answers what they asked. If they wrote back about something else, answer that and say nothing about hiring you.",
        "If you have done the exact thing before, one sentence of proof is allowed. One.",
        "Do not ask for a call. A small concrete question about their setup is better and gets replies.",
    ],
    leads: [
        "They wrote back, so this is a conversation and not a cold comment. Answer what they actually said first.",
        "Naming what the user built is now allowed, and this is the only place in the product where it is: once, plainly, as the answer to what they asked. One clause, no feature list, no pitch, no marketing adjectives.",
        "SAY IT IS YOURS. 'i built X for this' or 'i make X'. Never recommend it as though you were a neutral passer-by who just happens to know a good tool — that is undisclosed advertising, it is against the rules of most communities, it is what gets accounts banned, and readers spot it far more often than people writing it believe.",
        "A link only if they asked for one or it is genuinely the fastest way to answer. Otherwise the name is enough; anyone interested will search it.",
        "If they named a tool they are leaving, say the one concrete way yours is different for what THEY described, and leave the rest of the comparison alone.",
        "Allowed is not required. If what they wrote back does not give the mention an honest place to sit, leave it out and answer them — there will be another turn, and there is no turn after being ignored.",
        "Never post the same product mention twice in one forum in a day. Communities ban that, and a ban costs more than a hundred ignored messages.",
    ],
};
/**
 * The full rule block for one intent, handed to the assistant per signal.
 *
 * THE PRECEDENCE, strongest first, and it is stated in the prompt as well as
 * enforced by the order here — a model reading four style blocks needs to be
 * told which one wins:
 *
 *   1. voice samples (attached separately, by the caller) — the writing itself
 *   2. the FINGERPRINT — measured off that writing, or corrected by the user
 *   3. style_notes — distilled from what they changed in our drafts
 *   4. style — the adjective they picked from the setup drafts
 *
 * It used to be 3 over 4 with nothing above either. A user-edited fingerprint
 * has to outrank both: it is the one place the person has said, in their own
 * words about themselves, how they write.
 */
export function signalWritingRules(ctx) {
    const { intent, pitch, problem, style, styleNotes, voice } = ctx;
    const fingerprint = ctx.omitVoice ? [] : voiceRules(voice ?? null);
    const opener = (ctx.stage ?? "opener") === "opener";
    return [
        `You are writing as the user. What they do: ${pitch?.trim().replace(/[.\s]+$/, "") || "(not set — ask them)"}.`,
        // WHAT THE PITCH IS FOR, ON AN OPENER: knowing what the user sells is how
        // you know which part of this person's problem is worth answering well. It
        // is not a thing to put in the message. Said here rather than only in the
        // rules below, because it sits directly under the pitch and that is where a
        // model decides what the pitch was handed to it for.
        opener
            ? "That is context for choosing what to say. It does not go in this message: see the first-message rules below."
            : "",
        problem?.trim()
            ? opener
                ? `The problem they fix, in a sufferer's words: "${problem.trim().replace(/[.\s]+$/, "")}". This post got here because it is that problem — which is why answering it well is worth the user's time. Do not say the connection out loud; just be unusually useful about exactly that.`
                : `The problem they fix, in a sufferer's words: "${problem.trim().replace(/[.\s]+$/, "")}". This post got here because it is that problem — so the reply has to connect the two out loud.`
            : "",
        // Measured from their own messages, so it beats anything anybody described.
        // A dimension missing from this list is a dimension we have not measured:
        // write normally there, and do NOT reach for a house default.
        fingerprint.length > 0
            ? `HOW THIS PERSON WRITES — measured from their own messages, or corrected by them. This outranks every style instruction below it. Anything not named here is not known, so write it however reads naturally:\n${fingerprint
                .map((r) => `- ${r}`)
                .join("\n")}`
            : "",
        // The voice loop's output (lib/signals/retro.ts): rules distilled from what
        // this user actually changed before posting.
        styleNotes && styleNotes.length > 0
            ? `LEARNED FROM THEIR OWN EDITS — rules distilled from what this user changed in past drafts before posting. They outrank the tone below:\n${styleNotes
                .slice(0, 8)
                .map((r) => `- ${r}`)
                .join("\n")}`
            : "",
        style?.trim()
            ? `THE TONE THEY CHOSE, and it is not optional: ${style.trim()}. They picked this from written-out examples, so write in it — if the draft you have does not sound like that, rewrite it before showing anybody.`
            : "",
        "",
        ...(opener ? OPENER_RULES : CONVERSATION_RULES[intent]),
        "",
        "THESE HOLD WHATEVER THE VOICE ABOVE SAYS — they are not style, and no fingerprint overrides them:",
        ...UNIVERSAL_RULES,
        "",
        "AI tells to check the draft against and remove:",
        ...AI_TELLS.map((t) => `- ${t}`),
        "",
        "If voice samples are provided, match their rhythm, length and roughness over any rule above. They are how this person actually writes.",
    ]
        .filter(Boolean)
        .join("\n");
}
/** Community-etiquette reminder attached to every signal, per source kind. */
export function etiquetteNote(kind) {
    if (kind === "reddit") {
        return "Reddit: reply in the thread. Most subreddits ban unsolicited DMs and self-promo — read the sidebar rules before mentioning anything you built.";
    }
    return "Forum: reply in the thread where they asked. A public useful answer is worth more than a DM, and it stays findable for the next person with the same problem.";
}
/**
 * What can go WRONG on this particular site, named before the reply is written.
 *
 * The generic etiquette note above says where to put the message. This says
 * what gets the message removed and the account banned, and it is site-specific
 * because the rules are: the mention that reads as a helpful aside on Hacker
 * News is deleted as promotion on Stack Overflow, and the DM that is normal on
 * LinkedIn is a bannable offence in most subreddits.
 *
 * It is attached to the LEAD rather than only to the browse plan on purpose.
 * The browse plan is read while hunting, several steps before anybody writes
 * anything, and by the time the draft is being written the risk has scrolled
 * out of the conversation — which is exactly when it matters.
 *
 * Matched on host, like `recipeFor` in ./browsing.ts, so a forum registered
 * under any of our `kind` values still gets its own rules.
 */
export function communityRisks(url, kind, stage = "opener") {
    let host = "";
    if (url) {
        try {
            host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.replace(/^www\./, "").toLowerCase();
        }
        catch {
            host = "";
        }
    }
    const site = riskTable(host, kind);
    // A LINE ABOUT WHERE TO PUT THE MENTION IS PERMISSION TO MAKE ONE, and on a
    // first message there is none to place. Reddit's list carried "One mention,
    // in the thread, disclosed as theirs" — read straight, that is an instruction
    // to mention the product, sitting a few hundred words under a rule saying not
    // to. Same reasoning as the proof block in ./draft-prompt.ts: the fix is to
    // leave it out rather than to leave it in and forbid it.
    return stage === "conversation" ? [...site.always, ...site.whenMentioning] : site.always;
}
function riskTable(host, kind) {
    if (host.endsWith("reddit.com") || kind === "reddit") {
        return {
            always: [
                "Read the subreddit's sidebar rules before you write. A lot of them ban self-promotion outright, and some ban links from accounts under an age or karma threshold.",
                "Never DM this person. Unsolicited DMs off the back of a public post are reportable in most subreddits and are the fastest route to a site-wide ban.",
            ],
            whenMentioning: [
                "One mention, in the thread, disclosed as theirs. Reddit removes the same product name posted across several threads as spam even when each reply is genuinely useful.",
            ],
        };
    }
    if (host.endsWith("stackoverflow.com") || host.endsWith("stackexchange.com")) {
        return {
            always: [
                "Anything that reads as promotion is removed here, and repeat offences get the account suspended.",
                "The answer has to stand entirely on its own. If it does not, do not post it.",
            ],
            whenMentioning: [
                "Affiliation must be disclosed in the answer itself — Stack Exchange requires it explicitly.",
            ],
        };
    }
    if (host === "news.ycombinator.com") {
        return {
            always: [
                "HN readers are unusually good at spotting a plug, including one dressed as a helpful aside.",
                "No links unless the link is genuinely the answer. A bare name is safer and reads better.",
            ],
            whenMentioning: ["Say it is yours in plain words and keep it to one clause."],
        };
    }
    if (host.endsWith("discord.com") || host.endsWith("slack.com") || kind === "discord") {
        return {
            always: ["Answer in the channel they asked in. Do not DM, and do not @-mention them to get attention."],
            whenMentioning: [
                "Many servers have a dedicated self-promo channel and ban it everywhere else — check the rules channel first.",
            ],
        };
    }
    if (host.endsWith("linkedin.com")) {
        return {
            always: [
                "Comment publicly on the post. Do not send a connection request and do not open with a DM.",
                "Whatever is claimed here is attached to the user's real name and employer. No exaggeration at all.",
            ],
            whenMentioning: [],
        };
    }
    if (host.endsWith("github.com")) {
        return {
            always: [
                "This is somebody's issue tracker, not a channel. Answer their actual problem and nothing else.",
                "Never open a new issue to pitch, and never comment on an unrelated thread.",
            ],
            whenMentioning: ["Name the product only where it is the direct fix for the issue they filed."],
        };
    }
    if (host.endsWith("indiehackers.com") || host.endsWith("producthunt.com")) {
        return {
            always: ["Everyone here is already selling something, so the bar for being useful first is higher, not lower."],
            whenMentioning: ["One mention. A reply that reads as a swap ('check mine out too') gets ignored at best."],
        };
    }
    return {
        always: [
            "Read the community's own rules before you post — every forum has them and they differ.",
            "Reply publicly in the thread rather than by DM unless the post asked for DMs.",
        ],
        whenMentioning: [
            "Say the thing is yours. Undisclosed promotion is against the rules almost everywhere and is what gets an account banned.",
        ],
    };
}
