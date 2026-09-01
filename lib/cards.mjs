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
  const deck = [...triageCards(snap), ...onboardingCards(snap), ...nudgeCards(snap)];
  if (!deck.length) deck.push(quietCard(snap));
  // The specialist's proposal rides SECOND, always — behind the system's own
  // top action, never instead of it, and during onboarding too. The first
  // live proposal was stashed while the deck was mid-onboarding and simply
  // never rendered, which made the strategist's "it's on your deck now" a
  // lie; a proposal that can be invisible is worse than no propose tool.
  const prop = proposalCard(snap.stash ?? {});
  if (prop) deck.splice(Math.min(1, deck.length), 0, prop);
  return deck.slice(0, 8);
}

function proposalCard(stash) {
  const proposal = stash.agent_card;
  const parsed = proposal ? proposable(proposal.verb) : null;
  if (!parsed) return null;
  return {
    id: "agent.propose", kind: "agent.propose",
    eyebrow: "Your specialist suggests",
    question: trim(proposal.question, 140) || parsed.label,
    help: `${trim(proposal.why, 400)}\n\n— runs: es ${proposal.verb}`,
    primary: { id: "do", label: parsed.label },
    secondary: { id: "dismiss", label: "Not now" },
  };
}

/* ------------------------------------------------------------- onboarding */

function onboardingCards(snap) {
  const stash = snap.stash ?? {};
  const cards = [];

  /* 1. Who you are on Reddit. First because sync/check need it, and because
     it is the cheapest possible first question. Skippable honestly — the
     finding half works without an account; only the visibility half reads one. */
  if (!snap.account?.name && !stash.account_skipped) {
    cards.push({
      id: "onboard.account", kind: "onboard.account",
      question: "Which Reddit account is yours?",
      help: "Your own public profile is read the way a logged-out stranger reads it. Nothing is posted, nothing is sent.",
      field: { placeholder: "your-username", value: "" },
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
  if (needFiles && !stash.manual && scoutState === "none" && stash.url && !snap.hasKey) {
    cards.push({
      id: "onboard.key", kind: "onboard.key",
      eyebrow: `Ready to read ${hostOf(stash.url)}`,
      question: "The scout needs a model.",
      help: "Paste an OpenRouter key. It is stored in .mq/openrouter.key on this machine and never leaves it except to call the model.",
      field: { placeholder: "sk-or-…", value: "", secret: true },
      primary: { id: "save", label: "Save it and read my site" },
      secondary: { id: "manual", label: "Skip — I'll write the files myself" },
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
        question: "Which room should it look in first?",
        help: "One subreddit to start. It gets probed — one read, no commitment — and watched only if what comes back clears the floor.",
        field: { placeholder: "smallbusiness", value: "" },
        primary: { id: "next", label: "Next" },
      });
    } else if (stash.probe.q === undefined && !snap.probe?.running && !stash.probe.fired) {
      cards.push({
        id: "onboard.phrase", kind: "onboard.phrase",
        eyebrow: `r/${stash.probe.place}`,
        question: "The phrase somebody types when they have the problem.",
        help: "Scoped search is the workhorse: 42% of what it returns fits, against 29% for just reading new posts. Measured, not guessed.",
        field: { placeholder: "how do I get clients", value: "" },
        primary: { id: "probe", label: "Probe it" },
        secondary: { id: "new", label: "Just read its new posts" },
      });
    } else if (snap.probe?.running) {
      cards.push({
        id: "onboard.probing", kind: "onboard.probing",
        question: `Probing r/${stash.probe.place}.`,
        help: "One request, at the platform's own pace. A minute is normal.",
        primary: { id: "wait", label: "Waiting…" },
      });
    } else if (stash.probe.fired) {
      // The probe read landed. What it found sits in pending until judged, so
      // the honest next action depends on where the numbers are.
      const rate = snap.probe?.fitRate; // null until judged
      if (snap.pendingCount > 0) {
        // Nothing from here: the triage deck already leads with the judge
        // card, and dealing a second copy would put the same button twice.
      } else if (rate !== null && rate !== undefined) {
        const good = rate >= FLOOR;
        cards.push({
          id: "onboard.watch", kind: "onboard.watch",
          eyebrow: `r/${stash.probe.place} · ${pct(rate)} fit`,
          question: good ? "Worth watching." : "Below the floor.",
          help: good
            ? `${pct(rate)} of what the probe read fits your rule — the floor is ${pct(FLOOR)}. Committing it means it is read on every tick.`
            : `${pct(rate)} of what came back fits, and the floor is ${pct(FLOOR)}. Watching a room this quiet spends your minute-per-request budget on almost.`,
          primary: good ? { id: "watch", label: `Watch r/${stash.probe.place}` } : { id: "another", label: "Try another room" },
          secondary: good ? { id: "another", label: "Try another room" } : { id: "watch", label: "Watch it anyway" },
        });
      } else {
        cards.push({
          id: "onboard.empty_probe", kind: "onboard.empty_probe",
          question: `r/${stash.probe.place} had nothing new to read.`,
          help: "An empty read is an answer about today, not about the room. Another phrase or another room both work.",
          primary: { id: "another", label: "Try another room" },
        });
      }
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

/* ----------------------------------------------------------------- triage */

const judgeCard = (snap, lead) => ({
  id: "work.judge", kind: "work.judge",
  question: `${snap.pendingCount} post${snap.pendingCount === 1 ? "" : "s"} waiting on a verdict.`,
  help: `${lead ? lead + " " : ""}${snap.hasKey
    ? "The judge reads each against rule.md and nothing else."
    : "No model key here — judge them from your assistant over MCP, or add a key on Settings."}`,
  primary: snap.hasKey ? { id: "judge", label: "Judge them" } : { id: "open", label: "Open Settings" },
  links: snap.hasKey ? undefined : [{ href: "/settings", label: "Settings" }],
});

/**
 * The work that exists, whatever state the setup is in. Deliberately NOT
 * gated on `onboarded()`: the queue fills through probes, pulls and adds as
 * well as through watched sources, and every card here carries its own
 * prerequisites — a judged person implies a rule that judged them.
 */
function triageCards(snap) {
  const cards = [];

  /* Rules before replies: a room whose rules were never read can neither be
     judged ready nor honestly replied in. The refusal is the product. */
  for (const room of snap.rooms.filter((r) => r.state === "unanswered")) {
    cards.push({
      id: `room.rules.${room.place}`, kind: "room.rules",
      eyebrow: `r/${room.place}`,
      question: `Does r/${room.place} allow what you would post?`,
      help: "Reddit does not serve a room's rules to a logged-out reader — measured, not assumed — so a human reads them once and the answer is recorded. Until then nothing here counts this room as ready.",
      links: [{ href: `https://www.reddit.com/r/${room.place}/about/rules`, label: "Open its rules" }],
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
      cards.push({
        id: `work.reply.${it.id}`, kind: "work.reply",
        eyebrow: `r/${it.place} · u/${it.author ?? "?"} · ${it.readyState}`,
        question: it.title || "Somebody worth answering.",
        help: `${trim(it.body, 360)}\n\n— judged fit: ${it.why ?? ""}`,
        field: { placeholder: "", value: it.draft.text, multiline: true },
        primary: { id: "insert", label: "Open the thread & type it in" },
        secondary: { id: "skip", label: "Not this one" },
        actions: [
          it.blockedWhy
            ? { id: "posted", label: "I posted it", disabled: true, why: it.blockedWhy }
            : { id: "posted", label: "I posted it" },
        ],
        data: { url: it.url, draft: it.draft.text, id: it.id, client: "insert",
          flags: it.draft.flags ?? null },
      });
    } else {
      cards.push({
        id: `work.draft.${it.id}`, kind: "work.draft",
        eyebrow: `r/${it.place} · u/${it.author ?? "?"}`,
        question: it.title || "Somebody worth answering.",
        help: `${trim(it.body, 360)}\n\n— judged fit: ${it.why ?? ""}`,
        primary: snap.hasKey ? { id: "draft", label: "Write the draft" } : { id: "skip", label: "Not this one" },
        secondary: snap.hasKey ? { id: "skip", label: "Not this one" } : undefined,
        links: snap.hasKey ? undefined : [{ href: "/queue", label: "Draft it from the dashboard or MCP" }],
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

  if (snap.itemCount === 0 && snap.account?.name && !snap.syncRunning && !stash.sync_later) {
    cards.push({
      id: "work.sync", kind: "work.sync",
      question: "Read your own words the way a stranger sees them.",
      help: `u/${snap.account.name}'s public history, checked for what is visible, filtered or removed. This is the half that needs no model at all.`,
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
  question: "Nobody is waiting for an answer.",
  help: `${snap.sources.length} source${snap.sources.length === 1 ? "" : "s"} watched, ${snap.contactedCount} ${snap.contactedCount === 1 ? "person" : "people"} answered so far. An empty queue is an answer, not a failure.`,
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
