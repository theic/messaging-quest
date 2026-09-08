#!/usr/bin/env node
// The voice fingerprint, ported from the predecessor with its tests.
//
// §10 is explicit that this is a PORT and not a rewrite: "Port voice.ts
// verbatim with its test file, because those tests pin a deletion and a
// rewrite reintroduces exactly what was deleted."
//
// What they guard is that deletion. lib/signals/writing.ts used to assert, for
// every user of the product, that lowercase starts are fine, that they write
// "the way a non-native speaker writes", and that emoji are banned. That is one
// person's voice shipped as a fact about writing. These tests are what stops it
// growing back.
//
// The modules were converted TypeScript -> JavaScript by the compiler rather
// than by hand, so the logic is byte-faithful and only the type annotations are
// gone. 31 of the original 38 tests come across; the 7 that are missing test
// the Supabase store and the starter-kit prompt, which §13 deletes.
//
//   node bin/voice-test.mjs

import "../lib/node.mjs";   // the Node host for lib/fs.mjs — first, before anything in lib/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABSENCE_MIN_SAMPLES, cleanVoice, lengthCeiling, measureVoice, mergeVoice,
  MIN_SAMPLE_CHARS, applyVoiceAnswers, voicePreview, voiceQuestions, voiceRules,
  voiceSummary, VOICE_UNSURE,
} from "../lib/voice.mjs";
import { AI_TELLS, signalWritingRules } from "../lib/writing.mjs";
import { tells } from "../lib/guards.mjs";
import { buildSignalDraftPrompt } from "../lib/draft-prompt.mjs";

/**
 * The voice fingerprint (AGENTS.md).
 *
 * What this file is really guarding is a DELETION. `lib/signals/writing.ts`
 * used to assert, for every user of the product, that lowercase starts are
 * fine, that they write "the way a non-native speaker writes", and that emoji
 * are banned. That is one person's voice shipped as a fact about writing, and
 * the tests below exist so it cannot come back by accident.
 */
/** Four short lowercase sentences, last line with no full stop. */
const LOWER = "yeah we hit this too. the fix was to move the migration to a separate step and run it before the deploy, not during. took about an hour to work out. if you are on a managed db check the connection limit as well, that bit us";
/** Three long, properly punctuated sentences. */
const UPPER = "We ran into the same problem last quarter, and the thing that finally fixed it was moving the migration out of the deploy step entirely. It runs on its own now, ahead of the rollout, which means a failure there never takes the service down with it. Worth checking your connection limits too.";
const times = (text, n) => Array.from({ length: n }, () => text);
/* ------------------------------------------------------- what it measures */

test("casing and length are read off the samples, not asked about", () => {
    const fp = measureVoice([LOWER]);
    assert.equal(fp.casing?.value, "lowercase-starts");
    assert.equal(fp.casing?.source, "measured");
    assert.equal(fp.length?.value, "short");
    const tidy = measureVoice(times(UPPER, ABSENCE_MIN_SAMPLES));
    assert.equal(tidy.casing?.value, "sentence-case");
    assert.equal(tidy.length?.value, "mid");
    assert.equal(tidy.roughness?.value, "tidy");
});

test("a sample too short to measure is not a sample", () => {
    assert.deepEqual(measureVoice(["sure", "sounds good, thanks!", ""]), {});
    assert.ok(MIN_SAMPLE_CHARS >= 200, "the floor was 20 chars, which admits text that proves nothing");
});
/**
 * The asymmetry that shapes the whole module. A writer who uses an emoji in
 * one message out of four shows zero across three samples about 42% of the
 * time, so silence is not evidence — but a single emoji is proof.
 */

test("presence is decisive at one sample; absence is not decisive below the floor", () => {
    const once = measureVoice([`${UPPER} 👍`]);
    assert.equal(once.emoji?.value, "yes", "one emoji proves they use emoji");
    assert.equal(once.emoji?.n, 1);
    assert.deepEqual(once.emoji_seen, ["👍"], "the inventory is kept so a rule can name it back");
    const few = measureVoice(times(UPPER, ABSENCE_MIN_SAMPLES - 1));
    assert.equal(few.emoji, undefined, "four clean samples do not prove they never use emoji");
    assert.equal(few.exclamations, undefined);
    const enough = measureVoice(times(UPPER, ABSENCE_MIN_SAMPLES));
    assert.equal(enough.emoji?.value, "no");
    assert.equal(enough.exclamations?.value, "no");
});

test("a fragment with no letters in it is not a sentence", () => {
    // A trailing "👍" used to count toward the mean and drag the length band.
    assert.equal(measureVoice([`${UPPER} 👍`]).length, undefined, "three sentences plus an emoji is still three");
});

test("thin evidence produces no claim at all rather than a guess", () => {
    assert.deepEqual(measureVoice([UPPER]), {}, "three sentences is not enough to call a casing habit");
});
/* --------------------------------------------------- what it tells the model */
/**
 * THE REGRESSION TEST FOR THE WHOLE TRACK. An unmeasured user gets no voice
 * instructions whatsoever, because "not yet known" means write normally — it
 * must never quietly mean "apply the house default".
 */

test("an unmeasured voice imposes no style at all", () => {
    const rules = voiceRules(null).join("\n");
    assert.doesNotMatch(rules, /lowercase/i, "no lowercase default");
    assert.doesNotMatch(rules, /non-native/i, "no non-native-speaker default");
    assert.doesNotMatch(rules, /no emoji/i, "no emoji ban without evidence");
    assert.doesNotMatch(rules, /comma splice/i);
    assert.doesNotMatch(rules, /exclamation/i);
    // The one exception, and it is stated as an absence of evidence rather than
    // as a fact about the person.
    assert.match(rules, /No em dashes/);
    assert.doesNotMatch(rules, /never been seen/, "we have measured nothing about this person");
    assert.equal(voiceRules(null).length, 1, "and nothing else");
});

test("the em-dash ban lifts for somebody who actually types them", () => {
    const uses = { dashes: { value: "yes", source: "measured", n: 3 } };
    assert.equal(voiceRules(uses).length, 0, "no instruction at all once it is allowed");
    const doesNot = { dashes: { value: "no", source: "measured", n: 6 } };
    assert.match(voiceRules(doesNot).join("\n"), /never been seen typing one/);
});

test("emoji become a rule only when the samples show them", () => {
    const with_ = voiceRules({ emoji: { value: "yes", source: "measured", n: 2 }, emoji_seen: ["😅"] }).join("\n");
    assert.match(with_, /They use emoji/);
    assert.match(with_, /😅/);
    assert.doesNotMatch(with_, /No emoji/);
    assert.match(voiceRules({ emoji: { value: "no", source: "measured", n: 8 } }).join("\n"), /No emoji/);
});
/** The block is an instruction not to use punctuation it then demonstrates. */

test("the rule text does not use the punctuation it forbids", () => {
    const everything = voiceRules(measureVoice([LOWER])).join("\n");
    assert.doesNotMatch(everything, /—/, "a block full of em dashes teaches the opposite of what it says");
    assert.doesNotMatch(everything, /!/);
});

test("the length band sets the reply's ceiling instead of one number for everybody", () => {
    assert.equal(lengthCeiling(measureVoice([LOWER])), 600);
    assert.equal(lengthCeiling(null), 900, "the old hardcoded value is the not-yet-known case");
    assert.equal(lengthCeiling({ length: { value: "long", source: "user", n: 0 } }), 1200);
});
/* --------------------------------------------------------------- ownership */

test("a human correction wins per field, and does not freeze the rest", () => {
    const measured = measureVoice([LOWER]);
    const corrected = mergeVoice(measured, { casing: { value: "sentence-case", source: "user", n: 0 } });
    assert.equal(corrected.casing?.value, "sentence-case");
    assert.equal(corrected.casing?.source, "user");
    assert.equal(corrected.length?.value, "short", "the fields they did not touch keep their measurement");
    assert.equal(corrected.length?.source, "measured");
});

test("a fingerprint arriving from a form is as untrusted as a hand-typed competitor", () => {
    const cleaned = cleanVoice({
        casing: { value: "SHOUTING", source: "measured", n: 3 },
        emoji: { value: "yes", source: "made-up", n: -4 },
        length: { value: "mid", source: "user", n: 2 },
        banned: { value: ["delve", 42, "  leverage  "] },
        nonsense: "dropped",
    });
    assert.equal(cleaned.casing, undefined, "an unknown value is not a value");
    assert.equal(cleaned.emoji?.source, "measured", "an unknown source falls back rather than being stored");
    assert.equal(cleaned.emoji?.n, 0);
    assert.equal(cleaned.length?.value, "mid");
    assert.deepEqual(cleaned.banned?.value, ["delve", "leverage"]);
    assert.equal(cleaned.nonsense, undefined);
});
/* ------------------------------------------------------- the rules it joins */

test("the universal rules are ethics and channel mechanics, and say they are not style", () => {
    const rules = signalWritingRules({ intent: "leads", pitch: "X", problem: "Y" });
    assert.match(rules, /THESE HOLD WHATEVER THE VOICE ABOVE SAYS/);
    assert.match(rules, /never invent numbers/);
    assert.match(rules, /do not trash it/);
    assert.match(rules, /Give something real, and give it first/);
    // "before asking for anything" was the old wording, and it implied an ask was
    // coming — under a heading claiming these outrank everything above, on a
    // message whose own rules say to ask for nothing at all.
    assert.equal(/before asking for anything/.test(rules), false);
});

test("the house voice is gone from the shared rules", () => {
    const rules = signalWritingRules({ intent: "leads", pitch: "X", problem: "Y" });
    assert.doesNotMatch(rules, /non-native speaker/, "somebody else's voice, asserted about everybody");
    assert.doesNotMatch(rules, /Lowercase starts are fine/);
    assert.doesNotMatch(rules, /comma splice/);
    assert.doesNotMatch(rules, /Three to six sentences/, "sentence count is a measured band now");
});
/**
 * The ban used to be a rule AND a rewrite trigger, so lifting it in one place
 * did nothing: the model stripped the emoji again on the self-check pass.
 */

test("punctuation is enforced in exactly one place", () => {
    assert.ok(!AI_TELLS.some((t) => /em dash|exclamation|emoji/i.test(t)), "the tells list must not re-ban what the fingerprint just allowed");
    const allowsEmoji = signalWritingRules({
        intent: "leads",
        pitch: "X",
        voice: { emoji: { value: "yes", source: "measured", n: 2 } },
    });
    assert.doesNotMatch(allowsEmoji, /no emoji/i);
});

test("the fingerprint outranks the learned rules, which outrank the chosen tone", () => {
    const rules = signalWritingRules({
        intent: "leads",
        pitch: "X",
        voice: { casing: { value: "sentence-case", source: "user", n: 0 } },
        styleNotes: ["open with the answer"],
        style: "warm and chatty",
    });
    assert.match(rules, /HOW THIS PERSON WRITES/);
    assert.match(rules, /outranks every style instruction below it/);
    assert.ok(rules.indexOf("HOW THIS PERSON WRITES") < rules.indexOf("LEARNED FROM THEIR OWN EDITS"), "measured beats distilled");
    assert.ok(rules.indexOf("LEARNED FROM THEIR OWN EDITS") < rules.indexOf("THE TONE THEY CHOSE"), "distilled beats the adjective they picked");
});

test("an unmeasured dimension is named as unknown rather than left to a default", () => {
    const rules = signalWritingRules({
        intent: "leads",
        pitch: "X",
        voice: { casing: { value: "lowercase-starts", source: "measured", n: 3 } },
    });
    assert.match(rules, /Anything not named here is not known/);
});
/* ---------------------------------------------------------- the two prompts */
/**
 * The step that discovers a voice was sampling from a single point: the drafts
 * the user picks FROM were written under the same house rules as every other
 * draft, so both options were already in one voice.
 */

test("the drafting run gets the fingerprint and a ceiling that follows it", () => {
    const prompt = buildSignalDraftPrompt({
        reportUrl: "https://x.test/r",
        thread: { url: "https://news.ycombinator.com/item?id=1", title: "t", excerpt: "body", author: "a" },
        intent: "leads",
        pitch: "I build X",
        problem: null,
        notFor: null,
        proof: [],
        style: null,
        voiceSamples: [],
        voice: measureVoice([LOWER]),
    });
    assert.match(prompt, /They start sentences in lowercase/);
    assert.match(prompt, /under 600 characters/, "a clipped writer does not get a 900-character budget");
});
/* -------------------------------------------------------- the confirm screen */
/**
 * The other half of measuring somebody: showing them the measurement.
 *
 * Silently writing every reply in a voice inferred from three samples is
 * presumptuous the moment the inference is wrong, and invisible when it is —
 * the user would see an off draft and conclude the product writes badly.
 */

test("the questions carry the measurement, and unmeasured fields say so", () => {
    const fp = measureVoice([LOWER, LOWER, LOWER]);
    const asked = new Map(voiceQuestions(fp).map((q) => [q.key, q]));
    const casing = asked.get("casing");
    assert.equal(casing.value, "lowercase-starts");
    assert.match(casing.note, /Measured from 3 samples/);
    // Nothing proves an absence at n=3, so emoji is still unknown — and the
    // screen has to say "not measured", never quietly show "never".
    assert.equal(asked.get("emoji").value, "");
    assert.match(asked.get("emoji").note, /Not measured yet/);
    // Every question offers the honest third answer.
    for (const q of asked.values()) {
        assert.ok(q.choices.some((c) => c.value === VOICE_UNSURE), `${q.key} has no "not sure"`);
    }
});

test("the em dash note admits the ban instead of claiming neutrality", () => {
    const asked = voiceQuestions({}).find((q) => q.key === "dashes");
    // voiceRules bans them absent evidence. A screen that said "not measured,
    // we write normally" while the prompt banned them would be lying about what
    // the product is doing.
    assert.match(asked.note, /we leave them out/);
});

test("an answer wins for its own field and pins nothing else", () => {
    const measured = measureVoice([LOWER, LOWER, LOWER]);
    const user = applyVoiceAnswers({}, { casing: "sentence-case" });
    assert.deepEqual(user.casing, { value: "sentence-case", source: "user", n: 0 });
    assert.equal(Object.keys(user).length, 1, "one answer writes one field");
    const merged = mergeVoice(measured, user);
    assert.equal(merged.casing?.source, "user");
    assert.equal(merged.length?.source, "measured", "the untouched field is still the analyser's");
});

test('"not sure" deletes the override rather than storing one', () => {
    const user = applyVoiceAnswers({}, { casing: "sentence-case" });
    const cleared = applyVoiceAnswers(user, { casing: VOICE_UNSURE });
    assert.equal(cleared.casing, undefined);
    // …and the measurement rules again, which is the whole point of clearing it.
    assert.equal(mergeVoice(measureVoice([LOWER, LOWER, LOWER]), cleared).casing?.value, "lowercase-starts");
});

test("a field the form did not carry is left exactly as it was", () => {
    const before = applyVoiceAnswers({}, { casing: "mixed", emoji: "yes" });
    const after = applyVoiceAnswers(before, { emoji: "no" });
    assert.equal(after.casing?.value, "mixed", "an absent key is not an answer");
    assert.equal(after.emoji?.value, "no");
});

test("an invented value is refused, not stored", () => {
    const out = applyVoiceAnswers({ casing: { value: "mixed", source: "user", n: 0 } }, { casing: "SHOUTING" });
    assert.equal(out.casing, undefined, "a form post is as untrusted as any other input");
});

test("banned words come in as a list and clear when emptied", () => {
    const set = applyVoiceAnswers({}, { banned: "Delve, leverage , , seamless" });
    assert.deepEqual(set.banned?.value, ["delve", "leverage", "seamless"]);
    assert.equal(set.banned?.source, "user");
    assert.match(voiceRules(set).join("\n"), /Words they would never write: delve, leverage, seamless/);
    assert.equal(applyVoiceAnswers(set, { banned: "" }).banned, undefined);
});

test("every choice that can demonstrate itself does", () => {
    for (const q of voiceQuestions({})) {
        for (const choice of q.choices) {
            if (choice.value === VOICE_UNSURE) {
                assert.equal(choice.specimen, undefined, "the opt-out has nothing to demonstrate");
                continue;
            }
            assert.ok(choice.specimen, `${q.key}/${choice.value} has no specimen`);
        }
    }
});

test("the casing and length specimens are actually what they claim", () => {
    const casing = voiceQuestions({}).find((q) => q.key === "casing");
    const lower = casing.choices.find((c) => c.value === "lowercase-starts").specimen;
    const upper = casing.choices.find((c) => c.value === "sentence-case").specimen;
    // The specimen is a demonstration, so it has to survive being MEASURED by
    // the analyser as the thing it is demonstrating. Otherwise the screen is
    // showing one thing and storing another.
    assert.equal(lower[0], lower[0].toLowerCase());
    assert.equal(upper[0], upper[0].toUpperCase());
    const length = voiceQuestions({}).find((q) => q.key === "length");
    const words = (v) => length.choices.find((c) => c.value === v).specimen.split(/\s+/).length;
    assert.ok(words("short") < 12, "the short specimen must be short");
    assert.ok(words("long") > 20, "the long one must run on");
    assert.ok(words("mid") > words("short") && words("mid") < words("long"));
});

test("the em dash and emoji specimens contain the thing itself", () => {
    const q = (key) => voiceQuestions({}).find((x) => x.key === key);
    assert.match(q("dashes").choices.find((c) => c.value === "yes").specimen, /—/);
    assert.doesNotMatch(q("dashes").choices.find((c) => c.value === "no").specimen, /—/);
    assert.match(q("emoji").choices.find((c) => c.value === "yes").specimen, /\p{Extended_Pictographic}/u);
    assert.match(q("exclamations").choices.find((c) => c.value === "yes").specimen, /!/);
});
/* ---------------------------------------------------------------- the preview */
/**
 * The reason the controls are worth pressing: they have an output. A row of
 * switches with nothing coming out of them is a form, and a form is something
 * you complete rather than something you play with.
 */

test("the preview obeys every control it claims to", () => {
    const set = (fp) => Object.fromEntries(Object.entries(fp).map(([k, v]) => [k, { value: v, source: "user", n: 0 }]));
    assert.match(voicePreview(set({ casing: "lowercase-starts" })), /^we hit/);
    assert.match(voicePreview(set({ casing: "sentence-case" })), /^We hit/);
    assert.match(voicePreview(set({ greeting: "yes" })), /^Hey,/);
    assert.doesNotMatch(voicePreview(set({ greeting: "no" })), /^Hey/);
    assert.match(voicePreview(set({ dashes: "yes" })), /—/);
    assert.doesNotMatch(voicePreview(set({ dashes: "no" })), /—/);
    assert.match(voicePreview(set({ exclamations: "yes" })), /!/);
    assert.match(voicePreview(set({ contractions: "no" })), /does not/);
    assert.match(voicePreview(set({ contractions: "yes" })), /doesn't/);
    assert.match(voicePreview(set({ hedging: "yes" })), /i think/i);
    assert.match(voicePreview(set({ emoji: "yes" })), /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(voicePreview(set({ emoji: "no" })), /\p{Extended_Pictographic}/u);
    // Roughness is the last line on purpose: a missing final stop only shows
    // at the end.
    assert.doesNotMatch(voicePreview(set({ roughness: "rough" })), /[.!]$/);
    assert.match(voicePreview(set({ roughness: "tidy" })), /[.!]$/);
});

test("the length band visibly changes the length", () => {
    const words = (band) => voicePreview({ length: { value: band, source: "user", n: 0 } }).split(/\s+/).length;
    assert.ok(words("short") < words("mid"), "a control that changes nothing visible is a control nobody presses");
    assert.ok(words("mid") < words("long"));
});

test("an unmeasured fingerprint still previews something", () => {
    // The screen exists to be looked at before anything is known, so an empty
    // fingerprint cannot render an empty box.
    const blank = voicePreview({});
    assert.ok(blank.length > 40);
    assert.equal(blank, voicePreview(null), "and null is the same as empty here");
});

/* --------------------------------------------------------- the register */

/**
 * How a comment sounds is channel mechanics and rides in UNIVERSAL_RULES;
 * how THIS person types is measured and outranks it. These pin both halves:
 * the register is there, and it never dictates the things the fingerprint
 * owns.
 */
test("the register is in every prompt, and the fingerprint still outranks it", () => {
    const rules = signalWritingRules({ intent: "leads", pitch: "x", problem: null, style: null, styleNotes: null, voice: null, stage: "opener" });
    assert.match(rules, /third comment under a real post/);
    assert.match(rules, /never their username, never 'OP'/);
    assert.match(rules, /Hope this helps/, "the tells list names the closer");
    assert.match(rules, /HOW THIS PERSON WRITES[\s\S]*outranks every style instruction below/);
    // Nothing in the register dictates what the fingerprint measures.
    assert.doesNotMatch(rules, /short sentences/i);
    assert.doesNotMatch(rules, /use contractions|no contractions/i);
});

test("the tells list is phrases people recognise, not a vocabulary ban", () => {
    assert.ok(AI_TELLS.some((t) => /Great question/.test(t)));
    assert.ok(AI_TELLS.some((t) => /game-changer/.test(t)));
    assert.ok(!AI_TELLS.some((t) => /^that said$/i.test(t)), "'that said' is what real people write");
});

test("the guard catches the closer the prompt forbids, and lets a real reply through", () => {
    assert.deepEqual(tells("Hope this helps! Good luck."), ["hope this helps", "good luck"]);
    assert.deepEqual(tells("Skip the BDR until you've closed five yourself. What's your close rate on the calls you did make?"), []);
});
