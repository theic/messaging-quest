// The card — one question on screen, one primary action. This is the HITL
// protocol the whole product speaks: the extension's side panel renders one of
// these at a time, the dashboard can render the same JSON, a Telegram relay
// can send the same JSON, and none of them decide anything — the deck is built
// here, from the store, deterministically.
//
// The contract is inherited from the predecessor (messaging-quest,
// docs/onboarding-cards.md + lib/ui/card.ts), which drove real users through
// it and wrote down what it learned. The rules that survived contact:
//
//   * One card. One question. One primary action. A step that collects four
//     fields is four cards.
//   * Every card can be answered by pressing an option shown. Free text is
//     available where the answer might not be on the list, never required —
//     an empty box asks the user to invent a vocabulary before they can answer.
//   * The site read fires FIRST and runs in the background while the user
//     answers the cards that need nothing from it (the nine voice habits).
//     "What you sell" moved from the first question to a proof-read of what
//     the scout found, with the address it was read off named on the card.
//   * The flow never dead-ends. No key, no site, a failed scout — every state
//     has a card with a door in it.
//   * The deck never lies about progress: totals are recomputed from what is
//     actually left, and cards that are not questions are not counted.
//
// A card:
//   { id,                stable — the answer is stored under it
//     kind,              what the surface should do with it (see KINDS below)
//     eyebrow?,          small label above the question ("Setup · 3 of 14")
//     question,          the one thing being asked
//     help?,             at most a line or two under it
//     choices?: [{id, label, specimen?, note?}],
//     multi?,            several choices at once — still one question
//     field?: {placeholder, value, multiline?, secret?},
//     primary: {id, label},
//     secondary?: {id, label},
//     actions?: [{id, label, disabled?, why?}],   // beyond two: the reply card
//     links?: [{href, label}],                    // open elsewhere, no state
//     data?,             what a client-side action needs (draft text, url)
//     progress?: {step, of} }
//
// An answer (POST /api/cards/act):
//   { card, action, choice?, choices?, text? }
//
// This module is PURE — it reads a snapshot object the server assembles and
// returns cards. The one exception is the stash (cards.json): tiny state that
// exists only to carry the flow between cards (the URL waiting for a key, which
// voice habits were answered, whether the welcome was shown). It lives here so
// every surface shares one flow position.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { voiceQuestions } from "./voice.mjs";
import { FLOOR, pct } from "./probe.mjs";
import { PER_ROOM_24H, OVERALL_24H } from "./ready.mjs";
import { MENTIONS } from "./campaigns.mjs";
import { styleLabel, YOURS } from "./writing.mjs";

/* ------------------------------------------------------------- the drafts */

/**
 * A round of drafts as the card's TABS (0.8.0): one per style, each with
 * the text in the field and its flags said in words under it. An older row
 * — one text, no `drafts` — is one tab, labelled as the operator's own.
 * The flags are not a rejection: the human decides, so they are shown,
 * in plain words, next to the text they are about.
 */
export function draftTabs(draft) {
  if (!draft) return [];
  const list = Array.isArray(draft.drafts) && draft.drafts.length ? draft.drafts : [{ style: YOURS.id, text: draft.text, flags: draft.flags }];
  return list.filter((d) => String(d?.text ?? "").trim()).map((d) => ({ id: d.style, label: styleLabel(d.style), value: d.text, warnings: flagWords(d.flags) }));
}

function flagWords(flags) {
  const f = flags ?? {};
  const out = [];
  if ((f.repeat ?? 0) >= 8) out.push(`repeats ${f.repeat} words you have used before`);
  if (f.theirs) out.push(`says you built what THEY built — theirs, not yours`);
  if (f.claims) out.push(`${f.claims} claim${f.claims === 1 ? "" : "s"} about your history — check against me.md`);
  if (f.links) out.push(`${f.links} link${f.links === 1 ? "" : "s"} not in the thread`);
  if (f.tells) out.push(`${f.tells} template phrase${f.tells === 1 ? "" : "s"}`);
  return out;
}

/* -------------------------------------------------------------- platform */

/**
 * The deck carries no platform word of its own (0.6.0). What a card says when
 * it means "the room", "your account", "the rules page" comes from the
 * snapshot's `platform` — lib/platform.mjs labelsOf(), built off the active
 * adapter — and falls back to plain English so a snapshot without one (a
 * test, a platform that declares no labels) still reads.
 */
const GENERIC = {
  id: null, name: "the platform",
  room: (place) => String(place ?? ""),
  rulesUrl: () => null,
  account: { question: "Which account is yours?", help: "Your own public profile is read the way a logged-out stranger reads it. Nothing is posted, nothing is sent.", placeholder: "your-username" },
  roomAsk: { question: "Which room should it look in first?", help: "One room to start. It gets probed — one read, no commitment — and watched only if what comes back clears the floor.", placeholder: "a-room" },
  phrase: { placeholder: "how do I get clients" },
  rules: "A room's rules are read once by a human and the answer recorded. Until then nothing here counts this room as ready.",
  submit: "the platform's own button",
};
const labels = (snap) => ({ ...GENERIC, ...(snap?.platform ?? {}) });

/* ------------------------------------------------------------------- stash */

/** Flow state that is nobody's record: the URL stashed while the key card is
 *  answered, the probe being walked through, acks for shown-once cards. Losing
 *  this file costs a re-answer, never data — everything real lands in the
 *  store, the memory files or voice.json the moment it is answered. */
export function readStash(dir) {
  const p = join(dir, "cards.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

export function patchStash(dir, patch) {
  const next = { ...readStash(dir), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
  writeFileSync(join(dir, "cards.json"), JSON.stringify(next, null, 2));
  return next;
}

/* ---------------------------------------------------------------- the deck */

const MEMORY_CORE = ["project.md", "icp.md", "rule.md"];

const filled = (snap, file) => snap.memory.files.find((f) => f.file === file)?.filled ?? false;

/** Set up enough that the work cards take over: an account to read, the three
 *  files every verdict hangs off, and at least one room being watched. */
export const onboarded = (snap) =>
  Boolean(snap.account?.name) && MEMORY_CORE.every((f) => filled(snap, f)) && snap.sources.length > 0;

const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url || "your site"; } };

/**
 * The deck, in order. The first card is the one to show; a panel renders [0]
 * and re-fetches after every act, so "advance" is just the deck rebuilding
 * shorter. Capped — a deck is a next action, not a backlog, and the backlog
 * views (queue, prospects) already exist on the dashboard.
 *
 * PEOPLE OUTRANK SETUP. Triage — a room's unanswered rules, posts waiting on
 * a verdict, a judged human with a draft — deals before any remaining
 * onboarding card, whatever state the setup is in. This was learned the hard
 * way on day one: probing from the dashboard filled a queue of twenty judged
 * people while the panel, whose work cards were gated behind "at least one
 * source watched", kept asking which room to look in first. A panel that
 * hides twenty humans behind a setup question is not a triage surface, it is
 * a wizard wearing one's clothes.
 */
export function nextCards(snap) {
  const stash = snap.stash ?? {};
  // A WORKER WAITING ON A PERSON OUTRANKS EVERYTHING: a paused thread in a
  // leased tab is the machine waiting, and nothing it could be waiting for
  // is more urgent than the answer (PLAN.md: "discretion for signal, none
  // for a person waiting"). Then a campaign the operator is in the middle of
  // settling — five cards they asked for, and the probe they started under
  // it (0.6.0: the first live walk sat behind six draft cards otherwise).
  // Then the people, then what workers brought back, then the specialist's
  // own questions, then setup, then nudges.
  // 0.7.0: a rewrite the operator just asked for, then the campaign walk,
  // then SOMEBODY WHO WROTE BACK — a reply going cold costs more than a
  // missed post, so the turn card deals before any new person.
  // The campaign walk still outranks the queue (0.6.0: the operator asked
  // for it), but a PERSON WHO WROTE BACK outranks the walk — a reply going
  // cold costs more than a campaign settled an hour later. The specialist's
  // status proposal is a suggestion and deals after the people.
  const deck = [
    ...grantCards(snap), ...taskCards(snap), ...rewriteCards(snap), ...conversationCards(snap), ...campaignCards(snap),
    ...triageCards(snap), ...campaignStatusCards(snap), ...taskResultCards(snap),
    ...cmoAskCards(stash), ...onboardingCards(snap), ...nudgeCards(snap),
  ];
  if (!deck.length) deck.push(quietCard(snap));
  // The specialist's proposal rides SECOND, always — behind the system's own
  // top action, never instead of it, and during onboarding too. The first
  // live proposal was stashed while the deck was mid-onboarding and simply
  // never rendered, which made the strategist's "it's on your deck now" a
  // lie; a proposal that can be invisible is worse than no propose tool. A
  // note from it takes the same seat when there is no proposal.
  const second = proposalCard(stash) ?? noteCard(stash);
  if (second) deck.splice(Math.min(1, deck.length), 0, second);
  return deck.slice(0, 8);
}

/** The specialist's one suggestion: a VERB card (0.4.x — re-parsed by the
 *  server at act time) or, from milestone 1, a TASK to start — a colleague
 *  by id, on an input; the click starts the thread and the specialist hears
 *  of it as an event. One at a time; the verb card wins when both exist. */
function proposalCard(stash) {
  const proposal = stash.agent_card;
  const parsed = proposal ? proposable(proposal.verb) : null;
  if (parsed) {
    return {
      id: "agent.propose", kind: "agent.propose",
      eyebrow: "Your specialist suggests",
      question: trim(proposal.question, 140) || parsed.label,
      help: `${trim(proposal.why, 400)}\n\n— runs: mq ${proposal.verb}`,
      primary: { id: "do", label: parsed.label },
      secondary: { id: "dismiss", label: "Not now" },
    };
  }
  const p = (stash.proposals ?? [])[0];
  if (!p?.task?.agent) return null;
  return {
    id: "cmo.propose", kind: "cmo.propose",
    eyebrow: "Your specialist suggests",
    question: trim(p.question, 140) || `Start ${p.task.agent}?`,
    help: `${trim(p.why, 400)}\n\n— starts the ${p.task.agent} colleague${p.task.input?.url ? ` at ${trim(p.task.input.url, 120)}` : ""}, in a tab of your own browser you can watch.`,
    primary: { id: "start", label: trim(p.label, 40) || "Start it" },
    secondary: { id: "dismiss", label: "Not now" },
  };
}

/** Something the specialist wanted said — a count, a finding — shown once. */
function noteCard(stash) {
  const n = stash.cmo_note;
  if (!n?.text) return null;
  const [first, ...rest] = String(n.text).trim().split(/\n+/);
  return {
    id: "cmo.note", kind: "cmo.note",
    eyebrow: "Your specialist says",
    question: trim(first, 140),
    help: rest.length ? trim(rest.join("\n"), 600) : undefined,
    primary: { id: "ok", label: "OK" },
  };
}

/* ------------------------------------------------------- the question list */

/**
 * ONE input primitive (PLAN.md 2026-09-03): any agent that needs something
 * from the person hands the deck a list of questions; the deck deals them one
 * card at a time and the answers go back together. A worker's captcha, a
 * room's missing rules line, a choice among drafts, the specialist's "which
 * of these first?" — the same shape, one or many questions. This function is
 * the dealing half: the first unanswered question as a card, or null when
 * the list is done.
 *
 * A question: { id, question, help?, choices?: [{id,label,note?}], multi?,
 *               field?: {placeholder?, multiline?}, primary?, optional? }
 */
export function questionCards(questions, answers = {}, { prefix, kind = "ask", eyebrow, image, data, actions, links } = {}) {
  const list = Array.isArray(questions) ? questions.filter((q) => q && /^[\w-]{1,40}$/.test(String(q.id ?? "")) && q.question) : [];
  const left = list.filter((q) => !(q.id in (answers ?? {})));
  if (!left.length) return null;
  const q = left[0];
  const choices = Array.isArray(q.choices) && q.choices.length
    ? q.choices.filter((c) => c && /^[\w-]{1,40}$/.test(String(c.id ?? ""))).map((c) => ({ id: c.id, label: trim(c.label, 80), note: c.note ? trim(c.note, 160) : undefined }))
    : null;
  return {
    id: `${prefix}.${q.id}`, kind,
    eyebrow: eyebrow || undefined,
    question: trim(q.question, 200),
    help: q.help ? trim(q.help, 600) : undefined,
    choices: choices ?? undefined,
    multi: q.multi ? true : undefined,
    // A field always (0.6.0): when asked for, when there is nothing to
    // press — and under the choices too, so an answer that is not on the
    // list can be typed rather than forced into the nearest option. An
    // empty box is never the ONLY way to answer unless the answer cannot be
    // listed; `field: false` on a question keeps a card to its choices.
    field: q.field === false ? undefined
      : q.field || !choices ? { placeholder: trim(q.field?.placeholder, 80), value: "", multiline: Boolean(q.field?.multiline) }
      : { placeholder: "Or answer in your own words", value: "", multiline: false, optional: true },
    primary: { id: "answer", label: trim(q.primary, 30) || "Next" },
    secondary: q.optional ? { id: "skip", label: "Skip" } : undefined,
    actions, links, image, data,
    progress: list.length > 1 ? { step: list.length - left.length + 1, of: list.length } : undefined,
  };
}

/** The specialist's own questions — dealt, never interrupting its thread;
 *  the answers reach it through the inbox. */
function cmoAskCards(stash) {
  const a = stash.cmo_ask;
  if (!a?.questions?.length) return [];
  const c = questionCards(a.questions, a.answers ?? {}, { prefix: "cmo.ask", kind: "cmo.ask", eyebrow: trim(a.eyebrow, 60) || "Your specialist asks" });
  return c ? [c] : [];
}

/* -------------------------------------------------------------- campaigns */

/**
 * A campaign proposed by the specialist (propose_campaign) or started by
 * hand on the dashboard walks through the deck the way setup does: one card
 * per thing to settle, each seeded with the proposal, each with a field so
 * the answer can be the operator's own words — and the file is written by
 * the last Save, never by the model (lib/campaigns.mjs). The stash carries
 * the draft and which steps are done; "Not now" on the first card drops it.
 */
const CAMPAIGN_STEPS = ["idea", "fit", "mention", "room", "phrase"];

/** The specialist's proposal to pause, resume or finish a campaign: one
 *  card, dealt after the people — it is a suggestion, and nobody is
 *  waiting on it. */
function campaignStatusCards(snap) {
  const st = snap.stash?.campaign_status_draft;
  if (!st?.id || !st.status) return [];
  const verb = st.status === "paused" ? "Pause" : st.status === "done" ? "Finish" : "Resume";
  return [{
    id: "campaign.status", kind: "campaign.status",
    eyebrow: `Your specialist proposes · ${trim(st.name ?? st.id, 50)}`,
    question: `${verb} “${trim(st.name ?? st.id, 60)}”?`,
    help: trim(st.why, 500) || undefined,
    primary: { id: "apply", label: st.status === "paused" ? "Pause it" : st.status === "done" ? "Mark it done" : "Resume it" },
    secondary: { id: "leave", label: "Leave it as it is" },
  }];
}

function campaignCards(snap) {
  const L = labels(snap);
  const d = snap.stash?.campaign_draft;
  if (!d?.name) {
    // No draft in the walk — but a probe may be in flight or landed on a
    // project whose onboarding is long done: a campaign's room, or a room
    // tried from the panel's Rooms tab (0.8.0). During onboarding the
    // setup deck deals the same cards itself.
    return snap.stash?.probe?.place && (snap.stash.probe.campaign || (snap.sources ?? []).length > 0) ? probeCards(snap, L) : [];
  }
  const done = new Set(d.done ?? []);
  const step = CAMPAIGN_STEPS.find((s) => !done.has(s));
  if (!step) return [];
  const progress = { step: CAMPAIGN_STEPS.indexOf(step) + 1, of: CAMPAIGN_STEPS.length };
  const eyebrow = `${d.by === "you" ? "New campaign" : "Your specialist proposes a campaign"} · ${trim(d.name, 50)}`;
  if (step === "idea") {
    return [{
      id: "campaign.idea", kind: "campaign.idea", eyebrow,
      question: "The idea, in your words.",
      help: `${d.why ? trim(d.why, 300) + "\n\n" : ""}A direction, never a template: the writer applies it to each person in its own words, and a draft that repeats eight words of an earlier one is flagged when it is saved.`,
      field: { placeholder: "What to say, and why it is honest to say it", value: d.idea ?? "", multiline: true },
      primary: { id: "keep", label: "Keep this" },
      secondary: { id: "drop", label: "Not now" },
      progress,
    }];
  }
  if (step === "fit") {
    return [{
      id: "campaign.fit", kind: "campaign.fit", eyebrow,
      question: "Who this campaign is for.",
      help: "Narrows the fit rule for what this campaign finds — the judge reads it beside rule.md. Leave it empty when the rule already says it.",
      field: { placeholder: "e.g. people asking where to find their first clients — not agencies selling it", value: d.fit ?? "", multiline: true },
      primary: { id: "keep", label: "Keep this" },
      secondary: { id: "skip", label: "The rule is enough" },
      progress,
    }];
  }
  if (step === "mention") {
    const order = d.mention === "disclosed" ? ["disclosed", "never"] : ["never", "disclosed"];
    return [{
      id: "campaign.mention", kind: "campaign.mention", eyebrow,
      question: "May the first message name what you built?",
      help: "The house rule is no: a first message helps and sells nothing. A campaign may lift that in one form only — disclosed, once, as yours. There is no undisclosed setting.",
      choices: order.map((id) => ({ id, label: MENTIONS[id].label, note: MENTIONS[id].note })),
      primary: { id: "record", label: "Record it" },
      progress,
    }];
  }
  if (step === "room") {
    const known = [...new Set([d.place, ...(snap.sources ?? []).map((s) => s.place), ...(snap.rooms ?? []).map((r) => r.place)].filter(Boolean))];
    return [{
      id: "campaign.room", kind: "campaign.room", eyebrow,
      question: "Where should it look?",
      help: known.length ? "A room it already knows, or another one — its rules are recorded before anything is drafted for it." : L.roomAsk.help,
      choices: known.length ? known.slice(0, 6).map((p) => ({ id: p, label: L.room(p) })) : undefined,
      field: { placeholder: known.length ? "Or another room" : L.roomAsk.placeholder, value: "" },
      primary: { id: "next", label: "Next" },
      progress,
    }];
  }
  return [{
    id: "campaign.phrase", kind: "campaign.phrase", eyebrow: `${eyebrow} · ${L.room(d.place)}`,
    question: "The phrase somebody types when they have the problem.",
    help: "Scoped search is the workhorse: 42% of what it returns fits, against 29% for just reading new posts. Measured, not guessed. This saves the campaign and watches the room under it.",
    field: { placeholder: L.phrase.placeholder, value: d.q ?? "" },
    primary: { id: "start", label: "Start the campaign" },
    secondary: { id: "new", label: "Just read its new posts" },
    progress,
  }];
}

/* ------------------------------------------------------------------ tasks */

/** A blocked worker's question, oldest first, one at a time — with what it
 *  saw (the screenshot the runtime took when it stopped) and the tab it is
 *  in, so "deal with it" is one glance and one press. */
/** A site the extension may not read yet. Chrome grants a site only inside
 *  a click on the extension's own page, so the ask is a card with the
 *  button on it — the panel does the asking, then tells the lane. Dealt
 *  before everything: a task blocked on it is the machine waiting, and the
 *  grant line under the card was invisible for a day (the card cleared it). */
function grantCards(snap) {
  return (snap.grants ?? []).slice(0, 1).map((origin) => {
    const host = String(origin).replace(/^https?:\/\//, "");
    return {
      id: `grant.${origin}`, kind: "grant.ask",
      eyebrow: "Your browser",
      question: `Allow the extension to read ${host}?`,
      help: `A task opened ${host} in its tab and this browser has not allowed the extension there yet. Chrome asks you once, in the click; nothing is read on that site until you do.`,
      data: { origin },
      primary: { id: "allow", label: `Allow ${host}` },
      secondary: { id: "later", label: "Not now" },
    };
  });
}

function taskCards(snap) {
  const blocked = (snap.tasks ?? [])
    .filter((t) => t.status === "blocked" && t.questions?.length)
    .sort((a, b) => String(a.askedAt ?? "").localeCompare(String(b.askedAt ?? "")));
  for (const t of blocked) {
    const c = questionCards(t.questions, t.answers ?? {}, {
      prefix: `task.ask.${t.id}`, kind: "task.ask",
      eyebrow: `${trim(t.title, 50)} · needs you`,
      image: t.shot ? `/api/tasks/${t.id}/screenshot` : undefined,
      data: { task: t.id, tabId: t.lease?.tabId ?? null, client: t.lease?.tabId ? "show" : undefined },
      actions: t.lease?.tabId ? [{ id: "show", label: "Show me the tab" }] : undefined,
      links: [{ href: "/tasks", label: "Its log" }],
    });
    if (c) return [c];
  }
  return [];
}

/** What a worker brought back — the count and one next action, not a
 *  report — or why it stopped. Acknowledged once, then gone. */
function taskResultCards(snap) {
  const done = (snap.tasks ?? [])
    .filter((t) => /^(done|failed)$/.test(t.status) && !t.acked)
    .sort((a, b) => String(a.finishedAt ?? "").localeCompare(String(b.finishedAt ?? "")));
  const t = done[0];
  if (!t) return [];
  if (t.status === "done") {
    const [first, ...rest] = String(t.result ?? "").trim().split(/\n+/);
    return [{
      id: `task.done.${t.id}`, kind: "task.done",
      eyebrow: `${trim(t.title, 50)} · done`,
      question: trim(first, 140) || "Done.",
      help: rest.length ? trim(rest.join("\n"), 600) : undefined,
      links: [{ href: "/tasks", label: "Its log" }],
      primary: { id: "ack", label: "Got it" },
    }];
  }
  return [{
    id: `task.failed.${t.id}`, kind: "task.failed",
    eyebrow: `${trim(t.title, 50)} · stopped`,
    question: "It could not finish.",
    help: trim(t.error, 400) || "It said nothing about why.",
    links: [{ href: "/tasks", label: "Its log" }],
    primary: { id: "retry", label: "Try again" },
    secondary: { id: "ack", label: "Dismiss" },
  }];
}

/* ------------------------------------------------------------- onboarding */

function onboardingCards(snap) {
  const stash = snap.stash ?? {};
  const L = labels(snap);
  const cards = [];

  /* 1. Who you are on Reddit. First because sync/check need it, and because
     it is the cheapest possible first question. Skippable honestly — the
     finding half works without an account; only the visibility half reads one. */
  if (!snap.account?.name && !stash.account_skipped) {
    cards.push({
      id: "onboard.account", kind: "onboard.account",
      question: L.account.question,
      help: L.account.help,
      field: { placeholder: L.account.placeholder, value: "" },
      primary: { id: "save", label: "That's me" },
      secondary: { id: "skip", label: "No account yet" },
    });
  }

  const scoutState = snap.scout?.status ?? "none";
  const needFiles = !MEMORY_CORE.every((f) => filled(snap, f));

  /* 2. The address. Fires the scout and advances immediately — the nine voice
     cards need nothing from it, so the read lands while they are answered.
     The predecessor measured this reordering as the difference between a
     wait-first wizard and one that never visibly waits. */
  if (needFiles && !stash.manual && scoutState === "none" && !stash.url) {
    cards.push({
      id: "onboard.url", kind: "onboard.url",
      question: "What are you selling?",
      help: "Paste its address. The scout reads it and proposes your brief — you correct it, nothing saves itself.",
      field: { placeholder: "https://example.com", value: "" },
      primary: { id: "read", label: "Read it" },
      secondary: { id: "manual", label: "I'll write the files myself" },
    });
  }

  /* 2b. A stashed URL waiting for a model. Only reachable when the URL card
     was answered without a key on file. */
  if (needFiles && !stash.manual && scoutState === "none" && stash.url && !snap.hasModel) {
    cards.push({
      id: "onboard.key", kind: "onboard.key",
      eyebrow: `Ready to read ${hostOf(stash.url)}`,
      question: "The scout needs a model — a free one is fine.",
      help: "Make a free OpenRouter key (no card, nothing is ever charged) and paste it here. Every seat runs on the free models unless you choose otherwise. The key is stored in .mq/openrouter.key on this machine and never leaves it except to call the model. Or run a model on this machine: pick Local on the Settings tab, then come back.",
      field: { placeholder: "sk-or-…", value: "", secret: true },
      primary: { id: "save", label: "Save it and read my site" },
      secondary: { id: "manual", label: "Skip — I'll write the files myself" },
      links: [{ href: "https://openrouter.ai/keys", label: "Get a free key" }, { href: "/settings", label: "Run it locally instead" }],
    });
  }

  /* 3. The nine habits, answerable while the scout reads. What makes drafts
     sound like this person rather than like the product — and the fastest
     cards in the flow: one tap on a worked example each. */
  const voiceDone = new Set(stash.voice_done ?? []);
  const habits = voiceQuestions(snap.voice).filter((q) => !voiceDone.has(q.key));
  if (habits.length && (snap.account?.name || !needFiles || scoutState !== "none" || stash.manual)) {
    const q = habits[0];
    const total = voiceQuestions(snap.voice).length;
    cards.push({
      id: `onboard.voice.${q.key}`, kind: "onboard.voice",
      eyebrow: `Your voice · ${total - habits.length + 1} of ${total}`,
      question: q.ask,
      help: q.note,
      choices: q.choices.map((c) => ({ id: c.value || "unsure", label: c.label, specimen: c.specimen })),
      primary: { id: "next", label: "Next" },
    });
  }

  /* 4. The wait — only when there is genuinely something to wait for, and it
     presses its own button (the panel polls it). */
  if (needFiles && scoutState === "running") {
    cards.push({
      id: "onboard.wait", kind: "onboard.wait",
      question: `Still reading ${hostOf(snap.scout?.url)}.`,
      help: "It is working out what you sell and who it is not for. Nothing is watched and nothing is saved until you press Save.",
      primary: { id: "wait", label: "Waiting…" },
    });
  }

  if (needFiles && scoutState === "error") {
    cards.push({
      id: "onboard.scout_failed", kind: "onboard.scout_failed",
      question: "The scout could not read your site.",
      help: snap.scout?.error ?? "It said nothing useful about why.",
      primary: { id: "retry", label: "Try again" },
      secondary: { id: "manual", label: "Write the files myself" },
    });
  }

  /* 5. The proof-read. One card per file, seeded with what the scout wrote,
     the address it was read off named on the card. A proposal nobody was
     shown is a fact about your product only a model has seen — these three
     cards exist so that cannot happen here. */
  if (scoutState === "ready" && snap.scout?.proposal) {
    const prop = snap.scout.proposal;
    const files = [
      ["project.md", "What you sell", prop.project_md, "The drafter writes from this."],
      ["icp.md", "Who it is for", prop.icp_md, "The person, and the sentence they type when they have the problem."],
      ["rule.md", "The fit rule", prop.rule_md, "Decides who reaches your queue. Every verdict is stamped with a hash of it."],
    ];
    for (const [file, title, body, why] of files) {
      if (filled(snap, file)) continue;
      cards.push({
        id: `onboard.file.${file}`, kind: "onboard.file",
        eyebrow: `Read off ${hostOf(snap.scout?.url)} — ${title}`,
        question: "Is this right?",
        help: `${why}${prop.unknown?.length && file === "rule.md" ? ` The site did not say: ${prop.unknown.join("; ")}.` : ""}`,
        field: { placeholder: "", value: String(body ?? ""), multiline: true },
        primary: { id: "save", label: "Save this" },
      });
      break; // one at a time — the deck rebuilds when it is saved
    }
  }

  /* 5b. The by-hand path: same destination, different writer. */
  if (needFiles && stash.manual) {
    cards.push({
      id: "onboard.manual", kind: "onboard.manual",
      question: "Write the three files, then come back.",
      help: "project.md (what you sell), icp.md (who it is for), rule.md (who reaches your queue). The memory editor on the dashboard has the seeds.",
      links: [{ href: "/memory", label: "Open the memory editor" }],
      primary: { id: "done", label: "I filled them" },
      secondary: { id: "scout", label: "Actually — read my site" },
    });
  }

  /* 6. Somewhere to look. Two cards because it is two questions; the phrase
     card can be skipped honestly (new posts is a real shape). */
  const memoryDone = MEMORY_CORE.every((f) => filled(snap, f));
  if (memoryDone && snap.sources.length === 0) {
    if (!stash.probe?.place) {
      cards.push({
        id: "onboard.room", kind: "onboard.room",
        question: L.roomAsk.question,
        help: L.roomAsk.help,
        field: { placeholder: L.roomAsk.placeholder, value: "" },
        primary: { id: "next", label: "Next" },
      });
    } else if (stash.probe.q === undefined && !snap.probe?.running && !stash.probe.fired) {
      cards.push({
        id: "onboard.phrase", kind: "onboard.phrase",
        eyebrow: L.room(stash.probe.place),
        question: "The phrase somebody types when they have the problem.",
        help: "Scoped search is the workhorse: 42% of what it returns fits, against 29% for just reading new posts. Measured, not guessed.",
        field: { placeholder: L.phrase.placeholder, value: "" },
        primary: { id: "probe", label: "Probe it" },
        secondary: { id: "new", label: "Just read its new posts" },
      });
    } else {
      cards.push(...probeCards(snap, L));
    }
  }

  /* 7. Shown once: the machine is on. */
  if (onboarded(snap) && !stash.welcomed) {
    cards.push({
      id: "onboard.welcome", kind: "onboard.welcome",
      question: "You are set up.",
      help: `${snap.sources.length} source${snap.sources.length === 1 ? "" : "s"} watched. From here the deck deals the next action: who to answer, what still needs a verdict, which room's rules to record. The limits stand: ${PER_ROOM_24H} replies per room, ${OVERALL_24H} overall, per day.`,
      primary: { id: "tick", label: "Read what is due" },
      secondary: { id: "later", label: "Later" },
    });
  }

  return cards;
}

/**
 * A probe in flight or landed: the wait, then the honest next action off
 * the numbers — watch, another room, or nothing to read. Dealt during
 * onboarding (the first room) and for a campaign's room on a project that
 * already watches something; the card ids are the same so one handler
 * answers both, and `stash.probe.campaign` rides along to the watch.
 */
function probeCards(snap, L) {
  const stash = snap.stash ?? {};
  const probe = stash.probe;
  if (!probe?.place) return [];
  const tag = probe.campaign ? ` · ${trim(probe.campaign, 30)}` : "";
  // Watch pressed, the job not landed yet: a wait, not the room question.
  if (probe.watching) {
    return [{
      id: "onboard.watching", kind: "onboard.probing",
      eyebrow: probe.campaign ? `Campaign${tag}` : undefined,
      question: `Watching ${L.room(probe.place)}.`,
      help: "Committing it to the list — a moment.",
      primary: { id: "wait", label: "Waiting…" },
    }];
  }
  if (snap.probe?.running) {
    return [{
      id: "onboard.probing", kind: "onboard.probing",
      eyebrow: probe.campaign ? `Campaign${tag}` : undefined,
      question: `Probing ${L.room(probe.place)}.`,
      help: "One page, in a tab of your own browser, then the new posts one by one at a person's pace. A minute or two is normal — you can watch it in the Messaging Quest window.",
      primary: { id: "wait", label: "Waiting…" },
    }];
  }
  if (!probe.fired) return [];
  // The probe read landed. What it found sits in pending until judged, so
  // the honest next action depends on where the numbers are.
  const rate = snap.probe?.fitRate; // null until judged
  if (snap.pendingCount > 0) return [];   // the triage deck already leads with the judge card
  if (rate !== null && rate !== undefined) {
    const good = rate >= FLOOR;
    return [{
      id: "onboard.watch", kind: "onboard.watch",
      eyebrow: `${L.room(probe.place)} · ${pct(rate)} fit${tag}`,
      question: good ? "Worth watching." : "Below the floor.",
      help: good
        ? `${pct(rate)} of what the probe read fits your rule — the floor is ${pct(FLOOR)}. Committing it means it is read on every tick, in your own browser${probe.campaign ? ", under the campaign" : ""}.`
        : `${pct(rate)} of what came back fits, and the floor is ${pct(FLOOR)}. Watching a room this quiet spends your browser's page-turns on almost.`,
      primary: good ? { id: "watch", label: `Watch ${L.room(probe.place)}` } : { id: "another", label: "Try another room" },
      secondary: good ? { id: "another", label: "Try another room" } : { id: "watch", label: "Watch it anyway" },
    }];
  }
  return [{
    id: "onboard.empty_probe", kind: "onboard.empty_probe",
    eyebrow: probe.campaign ? `Campaign${tag}` : undefined,
    question: `${L.room(probe.place)} had nothing new to read.`,
    help: "An empty read is an answer about today, not about the room. Another phrase or another room both work.",
    primary: { id: "another", label: "Try another room" },
  }];
}

/* ----------------------------------------------------------------- triage */

const judgeCard = (snap, lead) => ({
  id: "work.judge", kind: "work.judge",
  question: `${snap.pendingCount} post${snap.pendingCount === 1 ? "" : "s"} waiting on a verdict.`,
  help: `${lead ? lead + " " : ""}${snap.hasModel
    ? "The judge reads each against rule.md and nothing else."
    : "No model key here — judge them from your assistant over MCP, or add a key on Settings."}`,
  primary: snap.hasModel ? { id: "judge", label: "Judge them" } : { id: "open", label: "Open Settings" },
  links: snap.hasModel ? undefined : [{ href: "/settings", label: "Settings" }],
});

/**
 * The work that exists, whatever state the setup is in. Deliberately NOT
 * gated on `onboarded()`: the queue fills through probes, pulls and adds as
 * well as through watched sources, and every card here carries its own
 * prerequisites — a judged person implies a rule that judged them.
 */
/* ---------------------------------------------------------- the return */

/**
 * Somebody the operator answered has written back (0.7.0). One card, the
 * oldest reply first — that is the one going cold. With a draft for THIS
 * turn it is the same control panel as the reply card: the exchange, the
 * draft in a field the operator edits, Insert, "I posted it", Rewrite.
 * Without one it offers to write it, or just the thread when there is no
 * model. No judge on a reply: they are already talking to you.
 */
function conversationCards(snap) {
  const L = labels(snap);
  const c = (snap.conversations ?? [])[0];
  if (!c) return [];
  const who = c.author ? `u/${c.author}` : "Somebody";
  const eyebrow = `${who} wrote back · ${L.room(c.place)} · turn ${c.turn}${c.campaign ? ` · ${trim(c.campaign, 30)}` : ""}`;
  const theirs = String(c.latest?.text ?? "").trim();
  const question = trim(theirs.split(/\n/)[0], 140) || "They wrote back.";
  const help = `You said: ${trim(c.said, 260)}\n\nThey wrote back: ${trim(theirs, 600)}`;
  if (c.draft) {
    const tabs = draftTabs(c.draft);
    return [{
      id: `work.turn.${c.id}`, kind: "work.turn", eyebrow, question, help,
      tabs,
      field: { placeholder: "", value: tabs[0]?.value ?? c.draft.text, multiline: true },
      primary: { id: "insert", label: "Open the thread & type it in" },
      secondary: { id: "skip", label: "Let it go" },
      actions: [{ id: "posted", label: "I posted it" }, { id: "rewrite", label: "Rewrite" }],
      data: { url: c.url, draft: tabs[0]?.value ?? c.draft.text, id: c.id, client: "insert", flags: c.draft.flags ?? null, insert: c.composer ?? null, submit: L.submit, turn: c.turn, round: c.draft.round ?? 1 },
    }];
  }
  return [{
    id: `work.turn.${c.id}`, kind: "work.turn", eyebrow, question, help,
    primary: snap.hasModel ? { id: "draft", label: "Write the reply" } : { id: "open", label: "Open the thread" },
    secondary: { id: "skip", label: "Let it go" },
    actions: [{ id: "posted", label: "I answered it myself" }],
    links: [{ href: c.url, label: "Open the thread" }],
    data: { url: c.url, id: c.id, turn: c.turn },
  }];
}

/** "Rewrite" pressed on a reply or a turn: one card for the note. The note
 *  and the rejected draft go to the writer as a critique; the deck comes
 *  back to the same person with the new draft. */
function rewriteCards(snap) {
  const r = snap.stash?.rewrite;
  if (!r?.id) return [];
  const which = r.style ? styleLabel(r.style) : null;
  return [{
    id: `work.rewrite.${r.id}`, kind: "work.rewrite",
    eyebrow: `${r.who ?? "the draft"} · rewrite${which ? ` · ${which}` : ""}`,
    question: "What should change?",
    help: `Your note goes to the writer with the draft you were looking at${which ? ` (${which})` : ""}, and all three come back written again — the one you commented on most of all.\n\n${trim(r.prior, 700)}`,
    field: { placeholder: "e.g. shorter, and lead with the thing that worked for me — drop the offer", value: "", multiline: true },
    primary: { id: "rewrite", label: "Rewrite all three" },
    secondary: { id: "keep", label: "Keep the drafts" },
  }];
}

function triageCards(snap) {
  const L = labels(snap);
  const cards = [];

  /* Rules before replies: a room whose rules were never read can neither be
     judged ready nor honestly replied in. The refusal is the product. */
  for (const room of snap.rooms.filter((r) => r.state === "unanswered")) {
    const rules = L.rulesUrl(room.place);
    cards.push({
      id: `room.rules.${room.place}`, kind: "room.rules",
      eyebrow: L.room(room.place),
      question: `Does ${L.room(room.place)} allow what you would post?`,
      help: L.rules,
      links: rules ? [{ href: rules, label: "Open its rules" }] : undefined,
      choices: [
        { id: "yes", label: "Promotion is tolerated", note: "Disclosed, on-topic, within the limits." },
        { id: "no", label: "Its rules forbid it", note: "The room stays watched for reading; drafts for it are refused." },
      ],
      primary: { id: "record", label: "Record it" },
    });
  }

  /* Judging blocks the queue, so it outranks it. */
  if (snap.pendingCount > 0) cards.push(judgeCard(snap, ""));

  /* The queue, one person at a time. The card is a control panel, not a
     summary: what they said, why the judge let them through, the draft, and
     the gate's answer about whether sending is even allowed right now. */
  for (const it of snap.queue.slice(0, 3)) {
    if (it.draft) {
      const tabs = draftTabs(it.draft);
      cards.push({
        id: `work.reply.${it.id}`, kind: "work.reply",
        eyebrow: `${L.room(it.place)} · ${it.author ?? "?"} · ${it.readyState}${it.campaign ? ` · ${trim(it.campaign, 30)}` : ""}`,
        question: it.title || "Somebody worth answering.",
        // Standing said in words when it is not ready (0.8.0): the eyebrow
        // alone said NOT READY and nothing else, and the person deciding
        // whether to post is the one who needs the reason.
        help: `${trim(it.body, 360)}\n\n— judged fit: ${it.why ?? ""}${it.readyState === "not ready" && it.readyWhy ? `\n\n— not ready here: ${trim(it.readyWhy, 220)}` : ""}`,
        // The three drafts as tabs (0.8.0), the field holding the one on
        // top; the panel keeps each tab's edits and says which was pressed.
        tabs,
        field: { placeholder: "", value: tabs[0]?.value ?? it.draft.text, multiline: true },
        primary: { id: "insert", label: "Open the thread & type it in" },
        secondary: { id: "skip", label: "Not this one" },
        actions: [
          it.blockedWhy
            ? { id: "posted", label: "I posted it", disabled: true, why: it.blockedWhy }
            : { id: "posted", label: "I posted it" },
          { id: "rewrite", label: "Rewrite" },
        ],
        // The composer the Insert flow looks for is the platform's
        // (lib/platform.mjs composerOf) and rides on the card, so the
        // extension holds no platform words of its own.
        data: { url: it.url, draft: tabs[0]?.value ?? it.draft.text, id: it.id, client: "insert",
          flags: it.draft.flags ?? null, insert: it.composer ?? null, submit: L.submit, round: it.draft.round ?? 1 },
      });
    } else {
      cards.push({
        id: `work.draft.${it.id}`, kind: "work.draft",
        eyebrow: `${L.room(it.place)} · ${it.author ?? "?"}${it.campaign ? ` · ${trim(it.campaign, 30)}` : ""}`,
        question: it.title || "Somebody worth answering.",
        help: `${trim(it.body, 360)}\n\n— judged fit: ${it.why ?? ""}`,
        primary: snap.hasModel ? { id: "draft", label: "Write the draft" } : { id: "skip", label: "Not this one" },
        secondary: snap.hasModel ? { id: "skip", label: "Not this one" } : undefined,
        links: snap.hasModel ? undefined : [{ href: "/queue", label: "Draft it from the dashboard or MCP" }],
        data: { url: it.url, id: it.id },
      });
    }
    break; // one person on screen; skip/posted rebuilds the deck
  }

  return cards;
}

/* ----------------------------------------------------------------- nudges */

/** Nudges, in the order they start to matter — after the work and after the
 *  setup, because a nudge that outranks either is a nag. Each is dismissible
 *  and stays dismissed. */
function nudgeCards(snap) {
  if (!onboarded(snap)) return [];
  const stash = snap.stash ?? {};
  const cards = [];

  /* The clock (0.7.0). What is due is computed, not remembered: watched
     rooms past their cadence, conversations not looked at in twelve hours.
     The card is the one place the tick runs from; "later" snoozes it. */
  const due = snap.due ?? { sources: 0, conversations: 0, unbound: 0, running: false };
  const n = (due.sources ?? 0) + (due.conversations ?? 0);
  const snoozed = stash.due_later && Date.now() - Date.parse(stash.due_later) < 6 * 3600_000;
  if (n > 0 && !due.running && !snoozed) {
    const parts = [];
    if (due.sources) parts.push(`${due.sources} watched room${due.sources === 1 ? "" : "s"}`);
    if (due.conversations) parts.push(`${due.conversations} conversation${due.conversations === 1 ? "" : "s"} to look at`);
    cards.push({
      id: "work.due", kind: "work.due",
      question: `${n} read${n === 1 ? " is" : "s are"} due.`,
      help: `${parts.join(" and ")} — each a tab in your own browser, a page turn every few seconds${due.unbound ? `; ${due.unbound} posted repl${due.unbound === 1 ? "y" : "ies"} not yet found on your profile, which a profile read binds` : ""}. Chrome has to be open with the extension attached; a reply that is waiting reaches this deck as a card.`,
      primary: { id: "tick", label: "Read what is due" },
      secondary: { id: "later", label: "Later" },
    });
  }

  if (snap.itemCount === 0 && snap.account?.name && !snap.syncRunning && !stash.sync_later) {
    cards.push({
      id: "work.sync", kind: "work.sync",
      question: "Read your own words the way a stranger sees them.",
      help: `${snap.account.name}'s public history, checked for what is visible, filtered or removed — in an Incognito tab of your own browser, the stranger's seat. This is the half that needs no model at all.`,
      primary: { id: "sync", label: "Read my profile" },
      secondary: { id: "later", label: "Later" },
    });
  }

  if (!filled(snap, "me.md") && snap.queue.length > 0 && !stash.me_later) {
    cards.push({
      id: "work.me", kind: "work.me",
      question: "me.md is still empty.",
      help: "Every first-person claim in a draft is checked against it. While it is empty, the check has nothing to hold a claim against — and an invented \"I used this at my last job\" is the thing that ends accounts.",
      links: [{ href: "/memory?file=me.md", label: "Write what is true" }],
      primary: { id: "later", label: "Later" },
    });
  }

  return cards;
}

/** The honest empty state — dealt only when nothing else is, which is what
 *  makes "nothing worth your name" a fact and not a shrug. */
const quietCard = (snap) => ({
  id: "work.quiet", kind: "work.quiet",
  question: snap.focus ? `Nobody is waiting under ${snap.focus === "none" ? "“no campaign”" : `“${trim(snap.focus, 40)}”`}.` : "Nobody is waiting for an answer.",
  help: `${snap.sources.length} source${snap.sources.length === 1 ? "" : "s"} watched, ${snap.contactedCount} ${snap.contactedCount === 1 ? "person" : "people"} answered so far. ${snap.focus ? "The deck is showing one campaign — pick “Everything” above the card to see the rest." : "An empty queue is an answer, not a failure."}`,
  primary: { id: "tick", label: "Read what is due" },
  links: [{ href: "/", label: "Open the dashboard" }],
});

const trim = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/* ------------------------------------------------------- agent proposals */

/**
 * The verbs the strategist may PUT ON A CARD — parsed here, in the zero-dep
 * heart, because this list is a security boundary and the suite that guards
 * it must run without the brain installed.
 *
 * This is how the "no reading verbs from chat" doctrine resolves rather than
 * chafes: the agent cannot run a probe, but it can deal a card that offers
 * one — the human clicks, the server spawns it on its own clock, the
 * governor paces it. Every verb here is one the dashboard already exposes as
 * a button; a proposal is the specialist reaching for a button it can see
 * but not press.
 */
export function proposable(verb) {
  const v = String(verb ?? "").trim();
  if (v === "judge") return { verb: "judge", args: [], label: "Judge them" };
  if (v === "tick") return { verb: "tick", args: [], label: "Read what is due" };
  if (v === "sync") return { verb: "sync", args: [], label: "Read my profile" };
  let m;
  if ((m = v.match(/^draft (t\d_[a-z0-9]+)$/i))) return { verb: "draft", args: [m[1]], label: "Write the draft" };
  if ((m = v.match(/^probe ([\w-]{2,30})(?: (.{2,80}))?$/)))
    return { verb: "probe", args: m[2] ? [m[1], "--q", m[2]] : [m[1]], label: `Probe r/${m[1]}` };
  return null;
}
