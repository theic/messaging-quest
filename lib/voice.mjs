/**
 * THE VOICE FINGERPRINT — how this one person writes, measured off their own
 * words (AGENTS.md, docs/quality-plan.md §1).
 *
 * What it replaces: `signal_prefs.style`, an adjective picked once, plus three
 * hardcoded rules in ./writing.ts that imposed a single house voice — lowercase
 * starts, non-native roughness, no emoji — on every user of the product. That
 * is a house style wearing a fingerprint's clothes, and it is simply wrong for
 * somebody who writes in careful sentence case.
 *
 * Pure module — string arithmetic over strings, no imports at all — for two
 * reasons. It rides into the Codex worker image (fly/Dockerfile), so every
 * transitive import would have to ride with it. And measuring casing, sentence
 * length and emoji rate is counting, not judgement: per the repo's
 * deterministic-first rule, a model call here would cost money to be worse.
 * Only `moves` (what this person's replies characteristically DO) needs a
 * model, and it is filled in from elsewhere.
 *
 * ── THE ONE RULE THAT SHAPES EVERYTHING BELOW ──────────────────────────────
 * Presence is decisive at one sample. Absence is never decisive at five.
 *
 * A writer who uses an emoji in one message out of four shows zero across
 * three samples about 42% of the time. So one emoji anywhere proves they use
 * emoji; three clean samples prove nothing at all. Every field is therefore
 * THREE-valued — yes / no / unknown — and `unknown` means WRITE NORMALLY. It
 * must never quietly mean "fall back to the old default", because the old
 * default is the house style this module exists to delete.
 */
/**
 * How many samples must agree before an ABSENCE counts as evidence. Presence
 * needs one; the asymmetry is the point.
 */
export const ABSENCE_MIN_SAMPLES = 5;
/**
 * Shortest sample worth MEASURING. It was 20 characters, which admits "sounds
 * good, thanks" — enough to prove presence of nothing and to measure no rate
 * at all. Two or three real sentences is the floor for a mean.
 *
 * IT IS NOT A FLOOR ON STORING ONE, and the difference cost a setup card. Used
 * as a gate, it refused to save a short reply and told the user how many
 * characters they still owed — on a screen asking how they would answer a
 * stranger, where four blunt words are frequently the honest answer and often
 * the better one. A sample below this measures nothing; it still goes into
 * every draft prompt verbatim as an example of how this person writes, which is
 * the half that actually stops the drafts sounding like a machine.
 *
 * So: `measureVoice` filters on it, and nothing else may.
 */
export const MIN_SAMPLE_CHARS = 200;
/** Sentences needed before a rate over sentences (casing, length) is called. */
const MIN_SENTENCES = 4;
/* ------------------------------------------------------------- the counting */
// Codepoint ranges rather than \p{Extended_Pictographic}: the same answer, and
// it survives a downlevel target without a lib bump.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F900}-\u{1F9FF}]/u;
const EMOJI_ALL = new RegExp(EMOJI.source, "gu");
/** Openers that are a greeting rather than the start of an answer. */
const GREETINGS = /^\s*(hey+|hi+|hello|yo|heya|howdy|good (morning|afternoon|evening)|hey there|hi there)\b[\s,!.-]*/i;
/** Hedges — the words that turn a claim into a maybe. */
const HEDGES = /\b(i think|i guess|i believe|maybe|perhaps|probably|kind of|kinda|sort of|sorta|might be|i'?d say|it seems|possibly|arguably|to be honest|tbh|not sure but)\b/gi;
const CONTRACTIONS = /\b\w+['’](s|t|re|ve|ll|d|m)\b/gi;
/** Split on sentence enders, keeping fragments a line break made. */
function sentences(text) {
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1);
}
const words = (text) => text.split(/\s+/).filter(Boolean);
/** First alphabetic character of a sentence, or null if it starts with a
 *  number, a quote or a bullet — those say nothing about casing. */
function firstLetter(sentence) {
    const match = sentence.match(/\p{L}/u);
    return match ? match[0] : null;
}
/**
 * A field the samples PROVED. `hits` is how many samples showed the thing;
 * one is enough for "yes", and "no" waits for ABSENCE_MIN_SAMPLES.
 */
function habit(hits, n) {
    if (hits > 0)
        return { value: "yes", source: "measured", n };
    if (n >= ABSENCE_MIN_SAMPLES)
        return { value: "no", source: "measured", n };
    return undefined;
}
/**
 * Read a fingerprint off real messages this person wrote.
 *
 * Samples under MIN_SAMPLE_CHARS are dropped before anything is counted: a
 * one-line reply drags every mean it touches and proves nothing it lacks.
 */
export function measureVoice(rawSamples) {
    const samples = rawSamples.map((s) => (s ?? "").trim()).filter((s) => s.length >= MIN_SAMPLE_CHARS);
    const n = samples.length;
    if (n === 0)
        return {};
    const fp = {};
    /* --- presence/absence, one sample is enough to say yes --------------- */
    const emojiSeen = new Set();
    const greetingsSeen = new Set();
    let emojiHits = 0;
    let exclaimHits = 0;
    let dashHits = 0;
    let contractionHits = 0;
    let hedgeHits = 0;
    let greetingHits = 0;
    let roughHits = 0;
    /* --- rates, counted over every sentence in every sample -------------- */
    let lowerStarts = 0;
    let upperStarts = 0;
    let sentenceCount = 0;
    let wordCount = 0;
    for (const sample of samples) {
        const found = sample.match(EMOJI_ALL);
        if (found) {
            emojiHits += 1;
            for (const e of found)
                emojiSeen.add(e);
        }
        if (/!/.test(sample))
            exclaimHits += 1;
        if (/[—–]|(?:\s--\s)/.test(sample))
            dashHits += 1;
        if (CONTRACTIONS.test(sample))
            contractionHits += 1;
        CONTRACTIONS.lastIndex = 0;
        if (HEDGES.test(sample))
            hedgeHits += 1;
        HEDGES.lastIndex = 0;
        const opener = sample.match(GREETINGS);
        if (opener) {
            greetingHits += 1;
            greetingsSeen.add(opener[0].trim().replace(/[\s,!.-]+$/, "").toLowerCase());
        }
        // Roughness, kept strictly TYPOGRAPHIC: a double space mid-line, a
        // sentence that ends with no full stop, a lowercase "i". Nothing here
        // looks at grammar — "rough" must never come to mean "writes badly".
        if (/\S {2,}\S/.test(sample) || /\bi\b/.test(sample) || /[a-z0-9)]\s*$/.test(sample))
            roughHits += 1;
        for (const sentence of sentences(sample)) {
            // A fragment with no letters in it — a trailing emoji, a bare URL, "+1"
            // — is not a sentence, and counting it drags the mean toward zero.
            const letter = firstLetter(sentence);
            if (!letter)
                continue;
            if (letter === letter.toLowerCase() && letter !== letter.toUpperCase())
                lowerStarts += 1;
            else
                upperStarts += 1;
            sentenceCount += 1;
            wordCount += words(sentence).length;
        }
    }
    fp.emoji = habit(emojiHits, n);
    fp.exclamations = habit(exclaimHits, n);
    fp.dashes = habit(dashHits, n);
    fp.contractions = habit(contractionHits, n);
    fp.hedging = habit(hedgeHits, n);
    fp.greeting = habit(greetingHits, n);
    if (emojiSeen.size > 0)
        fp.emoji_seen = [...emojiSeen].slice(0, 8);
    if (greetingsSeen.size > 0)
        fp.greetings_seen = [...greetingsSeen].slice(0, 4);
    if (roughHits > 0)
        fp.roughness = { value: "rough", source: "measured", n };
    else if (n >= ABSENCE_MIN_SAMPLES)
        fp.roughness = { value: "tidy", source: "measured", n };
    /* --- the two rates ---------------------------------------------------- */
    const starts = lowerStarts + upperStarts;
    if (starts >= MIN_SENTENCES) {
        const lowerShare = lowerStarts / starts;
        // A two-thirds majority is a habit; anything between is genuinely mixed,
        // and saying so is more useful than rounding to whichever side won.
        const casing = lowerShare >= 0.67 ? "lowercase-starts" : lowerShare <= 0.33 ? "sentence-case" : "mixed";
        fp.casing = { value: casing, source: "measured", n };
    }
    if (sentenceCount >= MIN_SENTENCES) {
        const mean = wordCount / sentenceCount;
        const band = mean < 12 ? "short" : mean <= 20 ? "mid" : "long";
        fp.length = { value: band, source: "measured", n };
    }
    // Drop the keys `habit` declined to fill, so `{}` really is an empty
    // fingerprint and a JSON round-trip cannot resurrect a null as a value.
    for (const key of Object.keys(fp)) {
        if (fp[key] === undefined)
            delete fp[key];
    }
    return fp;
}
/* -------------------------------------------------------------- the merge */
/**
 * What the drafts are actually written under.
 *
 * The same one-writer discipline `style_notes` already has, one level finer:
 * the analyser owns `measured`, the human owns `user`, and a human edit wins
 * per FIELD rather than wholesale — so confirming "yes, sentence case" does
 * not freeze every other field at whatever three samples happened to show.
 */
export function mergeVoice(measured, user) {
    const out = { ...(measured ?? {}) };
    for (const [key, field] of Object.entries(user ?? {})) {
        if (field !== undefined && field !== null)
            out[key] = field;
    }
    return out;
}
/* -------------------------------------------------------------- the render */
const LENGTH_LINE = {
    short: "Short sentences, under about 12 words. They write in clipped lines, not paragraphs.",
    mid: "Ordinary sentence length, around 12-20 words.",
    long: "Longer sentences, over 20 words. They think out loud and let a sentence run.",
};
/**
 * The fingerprint as prompt lines. A field that is not known emits NOTHING —
 * that is the whole three-valued contract, and the reason this function is a
 * long list of `if` rather than a table with defaults in it.
 *
 * One deliberate exception, and it is the only one: EM DASHES. Absent evidence
 * every other field stays quiet and the model writes however it writes, which
 * is fine, because "however a model writes" is not by itself a giveaway. The
 * em dash is: it is the single most reliable machine signature in a forum
 * reply, and a model left alone reaches for it every time. So its unknown
 * state is a ban rather than a silence, and one sample containing an em dash
 * lifts it, which is exactly the override every other field gets for free.
 *
 * The rule text avoids em dashes and exclamation marks itself. A block of
 * instructions punctuated the way it forbids is an instruction competing with
 * a demonstration, and the demonstration usually wins.
 */
export function voiceRules(fp) {
    const v = fp ?? {};
    const lines = [];
    if (v.casing) {
        if (v.casing.value === "lowercase-starts")
            lines.push("They start sentences in lowercase. Write it that way, and do not tidy it into sentence case.");
        if (v.casing.value === "sentence-case")
            lines.push("They write in proper sentence case, capital at the start of each sentence. Keep it.");
        if (v.casing.value === "mixed")
            lines.push("Their casing is inconsistent and that is fine. Do not standardise it.");
    }
    if (v.length)
        lines.push(LENGTH_LINE[v.length.value]);
    if (v.emoji?.value === "yes") {
        const seen = v.emoji_seen?.length ? ` They use: ${v.emoji_seen.join(" ")}.` : "";
        lines.push(`They use emoji. At most one, where it lands naturally.${seen}`);
    }
    if (v.emoji?.value === "no")
        lines.push("No emoji. They never use them.");
    if (v.exclamations?.value === "yes")
        lines.push("Exclamation marks are fine, they use them.");
    if (v.exclamations?.value === "no")
        lines.push("No exclamation marks.");
    // The exception documented above: silence here is not neutral. The two
    // wordings are not interchangeable — claiming "they have never typed one"
    // about somebody we have never measured is a fact we do not have.
    if (v.dashes?.value === "no")
        lines.push("No em dashes. This person has never been seen typing one. Use a comma, a full stop or a bracket.");
    else if (!v.dashes)
        lines.push("No em dashes. Use a comma, a full stop or a bracket instead. Nothing else marks a text as machine-written as reliably, and there is no sample yet showing this person uses them.");
    if (v.contractions?.value === "yes")
        lines.push("They use contractions (don't, it's, that's). Write the same way.");
    if (v.contractions?.value === "no")
        lines.push("They write words out in full rather than contracting them.");
    if (v.hedging?.value === "yes")
        lines.push("They hedge: 'i think', 'probably', 'might be'. Leave the hedges in.");
    if (v.hedging?.value === "no")
        lines.push("No hedging. They say the thing straight, without 'i think' or 'maybe'.");
    if (v.greeting?.value === "yes") {
        const seen = v.greetings_seen?.length ? ` Theirs: ${v.greetings_seen.join(", ")}.` : "";
        lines.push(`They open with a greeting.${seen}`);
    }
    if (v.greeting?.value === "no")
        lines.push("No greeting. The first line goes straight into the answer.");
    if (v.roughness?.value === "rough")
        lines.push("Their typing is rough in the ordinary way: a stray double space, a lowercase 'i', a last line with no full stop. Do not tidy that up. It is what makes it read as typed rather than generated.");
    if (v.roughness?.value === "tidy")
        lines.push("They write cleanly and punctuate properly. Do not add roughness to make it look human.");
    if (v.moves?.value.length)
        lines.push(`What their replies do: ${v.moves.value.join("; ")}.`);
    if (v.banned?.value.length)
        lines.push(`Words they would never write: ${v.banned.value.join(", ")}.`);
    return lines;
}
/** How long a reply should run, in characters, given the measured length. The
 *  draft prompt hardcoded 900 for everybody, which is a long message for
 *  somebody who writes in three clipped lines. */
export function lengthCeiling(fp) {
    const band = fp?.length?.value;
    if (band === "short")
        return 600;
    if (band === "long")
        return 1200;
    return 900;
}
/** Is there anything here to write under? Used to decide whether to show the
 *  user their fingerprint or ask for more samples. */
export function voiceIsEmpty(fp) {
    return voiceRules(fp).length <= 1; // the em-dash line is always there
}
const yesNo = (yes, no) => [
    { ...yes, value: "yes" },
    { ...no, value: "no" },
];
/**
 * Deliberately phrased as habits rather than settings. "Tone: professional" is
 * a preference nobody can answer accurately about themselves; "how you start a
 * sentence, with a capital or not" is a fact they can check by looking at their
 * own last message.
 */
const QUESTIONS = [
    {
        key: "casing",
        ask: "How you start a sentence",
        choices: [
            { value: "sentence-case", specimen: "We hit this too.", label: "Capital." },
            { value: "lowercase-starts", specimen: "we hit this too.", label: "Lowercase." },
            { value: "mixed", specimen: "We hit this. same here.", label: "Both, depending." },
        ],
    },
    {
        key: "length",
        ask: "How long your sentences run",
        choices: [
            { value: "short", specimen: "Move it out of the deploy.", label: "Short, under a dozen words." },
            {
                value: "mid",
                specimen: "Move it out of the deploy step so it runs on its own.",
                label: "Ordinary length.",
            },
            {
                value: "long",
                specimen: "Move it out of the deploy step so it runs on its own, ahead of the rollout, which means a failure there never takes the service down with it.",
                label: "Long. I think out loud.",
            },
        ],
    },
    {
        key: "emoji",
        ask: "Emoji",
        choices: yesNo({ value: "yes", specimen: "worked first try 🎉", label: "I use them." }, { value: "no", specimen: "worked first try", label: "Never." }),
    },
    {
        key: "exclamations",
        ask: "Exclamation marks",
        choices: yesNo({ value: "yes", specimen: "that fixed it!", label: "Sometimes." }, { value: "no", specimen: "that fixed it.", label: "Never." }),
    },
    {
        key: "dashes",
        ask: "Em dashes",
        choices: yesNo({ value: "yes", specimen: "it runs on its own — ahead of the rollout", label: "I type them." }, { value: "no", specimen: "it runs on its own, ahead of the rollout", label: "Never." }),
    },
    {
        key: "contractions",
        ask: "Contractions",
        choices: yesNo({ value: "yes", specimen: "it doesn't take the service down", label: "don't, it's, that's." }, { value: "no", specimen: "it does not take the service down", label: "Written out in full." }),
    },
    {
        key: "hedging",
        ask: "Hedging",
        choices: yesNo({ value: "yes", specimen: "i think the migration is the problem", label: "i think, probably, might be." }, { value: "no", specimen: "the migration is the problem", label: "I say it straight." }),
    },
    {
        key: "greeting",
        ask: "Opening a reply",
        choices: yesNo({ value: "yes", specimen: "hey — we hit this too.", label: "Hey or hi first." }, { value: "no", specimen: "we hit this too.", label: "Straight into the answer." }),
    },
    {
        key: "roughness",
        ask: "How tidy your typing is",
        choices: [
            { value: "tidy", specimen: "took about an hour to work out.", label: "Clean. Punctuated properly." },
            { value: "rough", specimen: "took about an  hour to work out", label: "A stray double space, no full stop." },
        ],
    },
];
/** What the third value looks like on a form: not an option we invented, the
 *  honest absence of an answer, and picking it hands the field back to the
 *  analyser rather than freezing it at whatever the samples happened to show. */
export const VOICE_UNSURE = "";
const UNSURE_CHOICE = { value: VOICE_UNSURE, label: "Not sure, keep watching." };
function note(field, key) {
    if (field?.source === "user")
        return "You told us this.";
    if (field?.source === "proposed")
        return "Proposed from your edits. Confirm it or change it.";
    if (field)
        return `Measured from ${field.n} ${field.n === 1 ? "sample" : "samples"}.`;
    // The one field whose silence is not neutral, for the reason voiceRules
    // documents. Saying "not measured" and then quietly banning them would be a
    // screen that lies about what the product is doing.
    if (key === "dashes") {
        return "Not measured yet, so we leave them out. Nothing else reads as machine-written so reliably.";
    }
    return "Not measured yet. Until it is, we write normally.";
}
export function voiceQuestions(fp) {
    const v = fp ?? {};
    return QUESTIONS.map((q) => {
        const field = v[q.key];
        return {
            key: q.key,
            ask: q.ask,
            choices: [...q.choices, UNSURE_CHOICE],
            value: field?.value ?? VOICE_UNSURE,
            note: note(field, q.key),
        };
    });
}
/**
 * The measured habits as one sentence, for the top of that screen: "You write
 * in sentence case, in short sentences, with no emoji." Null when nothing has
 * been measured, because a headline asserting nothing is worse than no headline.
 */
export function voiceSummary(fp) {
    const v = fp ?? {};
    const parts = [];
    if (v.casing?.value === "sentence-case")
        parts.push("in sentence case");
    if (v.casing?.value === "lowercase-starts")
        parts.push("with lowercase starts");
    if (v.casing?.value === "mixed")
        parts.push("with casing that varies");
    if (v.length?.value === "short")
        parts.push("in short sentences");
    if (v.length?.value === "mid")
        parts.push("in ordinary sentences");
    if (v.length?.value === "long")
        parts.push("in long sentences");
    if (v.emoji?.value === "yes")
        parts.push("with the odd emoji");
    if (v.emoji?.value === "no")
        parts.push("with no emoji");
    if (v.greeting?.value === "yes")
        parts.push("opening with a hello");
    if (v.greeting?.value === "no")
        parts.push("straight into the answer");
    if (v.contractions?.value === "yes")
        parts.push("using contractions");
    if (parts.length === 0)
        return null;
    return `You write ${parts.slice(0, 4).join(", ")}.`;
}
/**
 * ONE REPLY, WRITTEN THE WAY THIS FINGERPRINT SAYS.
 *
 * The reason the screen has this at all: nine rows of controls with no output
 * is a form, and a form is something you complete. With a reply that visibly
 * re-forms under every press, the controls become the thing worth touching —
 * you change the casing and watch the sentence change, which is both more fun
 * and strictly more informative than the label ever was.
 *
 * It is assembled deterministically from one fixed answer so that pressing the
 * same control twice always gives the same two results. Nothing here is a
 * model call; that would be a bill for a decoration.
 *
 * Pure, so the web screen can recompute it on every keystroke and the server
 * can render the same string for a surface that cannot.
 */
export function voicePreview(fp) {
    const v = fp ?? {};
    const lower = v.casing?.value === "lowercase-starts";
    const cap = (s) => (lower ? s : s.charAt(0).toUpperCase() + s.slice(1));
    // The greeting gets its own line, which is where people actually put it —
    // run into the next sentence it reads as "Hey, We hit…", which is nobody.
    const greeting = v.greeting?.value === "yes" ? `${cap("hey,")}\n` : "";
    const lines = [];
    const opener = v.hedging?.value === "yes" ? "i think we hit this exact thing last year" : "we hit this exact thing last year";
    lines.push(`${cap(opener)}.`);
    // The middle sentence is where length actually shows, so it is the one that
    // grows and shrinks with the band.
    const band = v.length?.value ?? "mid";
    const dash = v.dashes?.value === "yes";
    const middle = band === "short"
        ? "the fix was moving the migration out of the deploy"
        : band === "long"
            ? `the fix was moving the migration out of the deploy step so it runs entirely on its own${dash ? " — " : ", "}ahead of the rollout, which means a failure there never takes the service down with it`
            : `the fix was moving the migration out of the deploy step${dash ? " — " : ", "}so it runs on its own`;
    lines.push(`${cap(middle)}.`);
    const contracted = v.contractions?.value === "no" ? "it does not go down mid-release now" : "it doesn't go down mid-release now";
    const bang = v.exclamations?.value === "yes" ? "!" : ".";
    const emoji = v.emoji?.value === "yes" ? ` ${v.emoji_seen?.[0] ?? "🎉"}` : "";
    // Roughness is the last line on purpose: a missing final stop is the
    // artifact people recognise instantly, and it can only show at the end.
    const last = `${cap(contracted)}${v.roughness?.value === "rough" ? "" : bang}${emoji}`;
    lines.push(last);
    return greeting + lines.join(" ");
}
/**
 * A form post becoming the user-owned half of the fingerprint.
 *
 * Pure, and it takes the CURRENT user-owned column rather than the merged view,
 * because the two are different things: unanswering a question has to delete the
 * override so the measurement rules again, and it can only do that if what it is
 * editing is the override itself. Merging first would bake every measured value
 * into `voice` the first time anybody pressed save, and the analyser would never
 * be able to move a field again.
 */
export function applyVoiceAnswers(current, answers) {
    const next = { ...current };
    for (const q of QUESTIONS) {
        const answer = answers[q.key];
        if (answer === undefined)
            continue; // a field the form did not carry
        if (!answer || !q.choices.some((c) => c.value === answer)) {
            delete next[q.key];
            continue;
        }
        // n is 0 on purpose: this rests on no samples at all, it rests on the
        // person telling us, and pretending otherwise would put a sample count
        // behind a claim nothing counted.
        next[q.key] = { value: answer, source: "user", n: 0 };
    }
    if (answers.banned !== undefined) {
        const banned = strings((answers.banned ?? "").split(",").map((w) => w.trim().toLowerCase()), 20, 40);
        if (banned.length)
            next.banned = { value: banned, source: "user", n: 0 };
        else
            delete next.banned;
    }
    return next;
}
/* --------------------------------------------------------------- storage */
const HABITS = ["yes", "no"];
const SOURCES = ["measured", "user", "proposed"];
function field(raw, allowed) {
    const input = (raw ?? {});
    const value = input.value;
    if (!allowed.includes(value))
        return undefined;
    const source = SOURCES.includes(input.source) ? input.source : "measured";
    const n = typeof input.n === "number" && input.n >= 0 ? Math.floor(input.n) : 0;
    return { value, source, n };
}
function strings(raw, max, cap) {
    return (Array.isArray(raw) ? raw : [])
        .map((s) => (typeof s === "string" ? s.trim().slice(0, cap) : ""))
        .filter(Boolean)
        .slice(0, max);
}
/**
 * Everything we are willing to store, from anywhere — the analyser, a form
 * post, or a model. A fingerprint reaches the database from a user-editable
 * screen, so it is exactly as untrusted as a hand-typed competitor name.
 */
export function cleanVoice(raw) {
    const input = (raw ?? {});
    const out = {};
    const casing = field(input.casing, ["sentence-case", "lowercase-starts", "mixed"]);
    if (casing)
        out.casing = casing;
    const length = field(input.length, ["short", "mid", "long"]);
    if (length)
        out.length = length;
    const roughness = field(input.roughness, ["tidy", "rough"]);
    if (roughness)
        out.roughness = roughness;
    for (const key of ["emoji", "exclamations", "dashes", "contractions", "hedging", "greeting"]) {
        const parsed = field(input[key], HABITS);
        if (parsed)
            out[key] = parsed;
    }
    const emojiSeen = strings(input.emoji_seen, 8, 8);
    if (emojiSeen.length)
        out.emoji_seen = emojiSeen;
    const greetingsSeen = strings(input.greetings_seen, 4, 20);
    if (greetingsSeen.length)
        out.greetings_seen = greetingsSeen;
    const movesRaw = (input.moves ?? {});
    const moves = strings(movesRaw.value, 4, 120);
    if (moves.length) {
        out.moves = {
            value: moves,
            source: SOURCES.includes(movesRaw.source) ? movesRaw.source : "proposed",
            n: typeof movesRaw.n === "number" ? Math.floor(movesRaw.n) : 0,
        };
    }
    const bannedRaw = (input.banned ?? {});
    const banned = strings(bannedRaw.value, 20, 40);
    if (banned.length) {
        out.banned = {
            value: banned,
            source: SOURCES.includes(bannedRaw.source) ? bannedRaw.source : "user",
            n: typeof bannedRaw.n === "number" ? Math.floor(bannedRaw.n) : 0,
        };
    }
    return out;
}
