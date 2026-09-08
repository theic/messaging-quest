// The engine — the deck, the jobs, the panel's tabs, the control lane and
// the JSON API over them, as one factory: engine({ root, base }).
//
// This was the middle of bin/serve.mjs until 0.10.0. Two hosts run it now,
// on the same files: the dashboard server (bin/serve.mjs: HTTP in front,
// the HTML views beside it, the brain when agent/ is installed) and the
// extension's service worker (extension/engine.js: chrome.runtime messages
// in front, the memory filesystem underneath, no server anywhere). Nothing
// in here knows which; what differs is injected — the data root, this
// server's own address for the panel to show (null in the worker), and the
// filesystem behind lib/fs.mjs.
//
// The prose and the code below are serve.mjs's, moved not rewritten, except
// for the seams: the verbs run in-process (lib/verbs.mjs through the job
// store's start(), the judge and the writer through runVerb) where the
// dashboard used to spawn the CLI; every read the engine makes goes to the
// broker in this process (LANE), not over HTTP to itself; the timers do not
// hold a Node process open and do not mind a worker that has no unref.
//
// What the factory hands back is the API (handle, routes, deck) and the
// pieces the dashboard's views were already using (the stores, the project,
// the lane, the runtime, the deck's actions).

import { store, dataDir } from "./store.mjs";
import { history, STATES } from "./verdict.mjs";
import { standing, readiness, burst, mix, PER_ROOM_24H, OVERALL_24H, CQS_NOTE } from "./ready.mjs";
import { roomFile } from "./rules.mjs";
import { mergeVoice, voiceRules, voiceSummary, applyVoiceAnswers, VOICE_UNSURE } from "./voice.mjs";
import { nextCards, readStash, patchStash, proposable, onboarded, draftTabs } from "./cards.mjs";
import { styleOf } from "./writing.mjs";
import { controlBroker } from "./control.mjs";
import { jobStore } from "./jobs.mjs";
import { MEMORY, readMemory, readOne, writeMemory, seedMissing, memoryProgress } from "./memory.mjs";
import { PLANS, ROLES, LOCAL_URL, KEY_URL, plan, setPlan, chosen, choose, localConfig, setLocal, probeLocal, modelInfo, alternatesFor,
  readKey, writeKey, hasKey, hasModel, keySource, judgeEstimate, money } from "./models.mjs";
import { loadPlatforms, platforms, first, preferred, platform as platformById, platformFor, labelsOf, accountOf, composerOf } from "./platform.mjs";
import { skillState, readChoices, writeChoice } from "./skills.mjs";
import { browser } from "./browse.mjs";
import { readCampaigns, readCampaign, writeCampaign, setCampaignStatus, campaignDraft, MENTIONS } from "./campaigns.mjs";
import { listProjects, currentProject, currentDir, createProject, useProject } from "./projects.mjs";
import { conversationRows, openConversation, recordTurn, closeConversation, waiting as waitingRows, yourTurns, dueConversations, unbound, campaignDigest, digestText } from "./conversations.mjs";
import { host, existsSync, readFileSync, writeFileSync, join } from "./fs.mjs";
import { verbs } from "./verbs.mjs";
import { laneOf } from "./control.mjs";

export function engine({ root, base = null } = {}) {

  /** The root data directory: the default project, the project registry, and
   *  the machine's own files (lib/dirs.mjs). */
  const DATA = root;
  // Platform skills — the store resolves rooms through the registry; the local
  // ring is the machine's, so it loads from the root.
  // (the platforms were loaded by the host before this factory ran)
  /** The PROJECT every request acts on (lib/projects.mjs): the registry's
   *  pointer, read per call, so the panel, the CLI and this dashboard move
   *  together when it is switched. Everything below that reads or writes a
   *  project file goes through it. */
  const P = () => currentDir(DATA);
  const PJ = () => currentProject(DATA);
  /** The platform this project means when nothing names one: the first
   *  active skill, unless the project chose another (the stash's platform).
   *  Every word below is that platform's, never a platform's by name. */
  const PL = () => preferred(readStash(P()).platform);
  /** What the platform's people write — "r/saas" — and the other words a
   *  screen needs when it means the platform; the adapter's, with plain
   *  fallbacks (lib/platform.mjs labelsOf). */
  const LB = () => labelsOf(PL());
  /** …and what this browser can tell about the account there on its own. */
  const PLA = () => accountOf(PL());

  /** One store and one job store PER PROJECT, behind a proxy so every view
   *  reads `S.found()` as it always did and gets the current project's. A
   *  store is closures over a directory; one per directory is free to keep. */
  const perDir = (make) => {
    const m = new Map();
    return new Proxy({}, { get: (_, k) => { const d = P(); if (!m.has(d)) m.set(d, make(d)); const o = m.get(d); const v = o[k]; return typeof v === "function" ? v.bind(o) : v; } });
  };
  const S = perDir((d) => store(d, (m) => { throw new Error(m); }));
  const J = perDir((d) => jobStore(d, { verbs: (o) => verbs({ root: DATA, dir: d, browse: (x) => browser(LANE, x), ...o }) }));

  /** The control lane's broker (lib/control.mjs holds the law): tabs a task
   *  leased in the operator's own Chrome, the toolkit screened by grant,
   *  navigations paced per site. Idle leases are swept so a crashed task never
   *  keeps a tab. Its events go to the inbox once the runtime is up. */
  /** The control lane is the MACHINE's — one extension, one broker — and its
   *  events go to the inbox of the project whose lease raised them. */
  const CONTROL = controlBroker({ onEvent: (e) => INBOX(e, e.project ?? P()) });
  /** The lane as this process's own verbs and scout reach it: the broker
   *  directly, no HTTP (lib/control.mjs laneOf). A CLI in another process
   *  reaches the same broker over the server; the extension's worker IS this
   *  process. */
  const LANE = laneOf(CONTROL);
  const sweeper = setInterval(() => CONTROL.sweep(), 60_000);
  sweeper.unref?.();   // Node: never the reason the process stays up

  /* The runtime — workers on their own threads (agent/tasks.mjs), ONE PER
   * PROJECT: each project's colleagues, inbox and CMO are its own, and a task
   * started under one keeps running when the operator switches to another. It
   * lives in agent/, the one directory with dependencies, behind this one lazy
   * import: absent, the deck has no task cards, /tasks says how to install it,
   * and everything else runs exactly as before. Loaded AFTER the port is bound
   * — the LangChain tree takes seconds to import, and a dashboard that answers
   * late because a colleague might be needed later is the wrong trade. */
  const RUNTIMES = new Map();   // project dir → { RT(), why, inbox }
  const RT = () => RUNTIMES.get(P())?.T ?? null;
  const WHY = () => RUNTIMES.get(P())?.why ?? "the runtime is still loading";
  function INBOX(e, dir = P()) { try { RUNTIMES.get(dir)?.inbox?.(e); } catch { /* an event that could not be noted must not fail a request */ } }
  async function loadRuntime(dir = P()) {
    if (RUNTIMES.has(dir)) return RUNTIMES.get(dir);
    const entry = { T: null, why: "the runtime is still loading", inbox: null };
    RUNTIMES.set(dir, entry);
    try {
      if (host().kind !== "node") throw new Error("the colleagues run on a local install (npm run brain) — this host has no Node");
      const { taskManager } = await import("../agent/tasks.mjs");
      entry.T = taskManager(dir, { control: CONTROL });
      entry.inbox = (e) => entry.T.note(e.type, e);
      entry.why = "";
      // The CMO learns of the runtime — its tools for proposing, answering and
      // stopping tasks, and its read-only browser — and its inbox starts being
      // delivered when it is idle. Same directory, same seam.
      const { attachRuntime, startInboxLoop } = await import("../agent/strategist.mjs");
      attachRuntime(dir, { tasks: entry.T, control: CONTROL });
      entry.stop = startInboxLoop(dir);
    } catch (e) {
      entry.why = String(e?.message ?? e).split("\n")[0];
    }
    return entry;
  }
  /** After a switch or a new project: its files seeded, its runtime up. */
  const afterSwitch = () => { seedMissing(P()); loadRuntime(P()).catch(() => {}); };

  // An .mq/ made by an older build has no memory files. Grow them on boot
  // rather than making the first page load a migration the user has to notice.
  seedMissing(P());

  const acct = () => S.account();
  const who = () => (acct()?.name ? acct().name : "no account yet");

  /** The people waiting for an answer: every fit verdict not yet sent or
   *  skipped, whose author was never answered before, newest first. The deck
   *  and the dashboard's People page read the same rows. */
  const queueRows = () => {
    const v = S.verdicts(), marks = S.marks(), all = S.found(), gone = S.contacted();
    const rows = [];
    for (const [id, ver] of v) {
      if (!ver.fit) continue;
      const m = marks.get(id);
      if (m && m.mark !== "undo") continue;          // sent or skipped, and not undone
      const it = all.get(id);
      if (!it) continue;
      if (it.author && gone.has(it.author.toLowerCase())) continue;
      rows.push({ ...it, why: ver.why });
    }
    return rows.sort((a, b) => String(b.posted_at ?? b.seen_at).localeCompare(String(a.posted_at ?? a.seen_at)));
  };

  const SPAWNABLE = {
    me: "Finding your account",
    sync: "Reading your profile",
    check: "Re-reading your threads",
    back: "Finding who is waiting",
    voice: "Measuring your voice",
    add: "Adding a permalink",
    probe: "Probing a room",
    watch: "Committing a room",
    unwatch: "Stopping a source",
    tick: "Reading what is due",
    pull: "Taking what the hub found",
    sweep: "Dropping old bodies",
  };

  /** Verbs that need a model, and therefore run in this process. */
  const AGENTIC = { judge: "Judging what was found", draft: "Writing a draft" };

  /* What the deck needs to say about them (0.9.1): which person a draft is
   * being written for right now, and how the last judge or the last draft
   * ended when it did not end well. A card that read "Write the draft" after
   * the writer had failed twice, silently, was the panel's worst habit — the
   * button looked unpressed and the failure lived in a job log nobody opened.
   * Per project dir, this process only. */
  const DRAFTING = new Map();   // dir → the item a draft is being written for
  const LAST = new Map();       // dir → { judge: { error, at } | null, draft: { id, error, at } | null }
  const lastOf = (dir) => LAST.get(dir) ?? { judge: null, draft: null };
  const remember = (dir, patch) => LAST.set(dir, { ...lastOf(dir), ...patch });

  const startAgentic = (verb, args) => {
    const dir = P();
    if (verb === "judge") {
      return J.run("judge", async (ctl) => {
        try {
          const pend = S.pending();
          if (!pend.length) { ctl.log("nothing pending to judge"); return "nothing was pending"; }
          const all = S.found();
          const items = pend.map((x) => {
            const it = all.get(x.id) ?? {};
            return { n: x.n, place: it.place, author: it.author, title: it.title, body: it.body, crowd: it.comments ?? null, posted_at: it.posted_at ?? null };
          });
          ctl.log(`${items.length} to judge · ${chosen(dir).judge}`);
          const { judgeItems } = await import("./agents.mjs");
          const rule = readFileSync(S.F("rule.md"), "utf8");
          const verdicts = await judgeItems(dir, items, rule, ctl);
          // Nothing back is a failure, not a quiet success: the first live judge
          // run on the free plan finished "ok" in 0.8s with every batch refused
          // (400, a fallback list one entry too long) and the only trace was a
          // log the job store does not keep.
          if (!verdicts.length) throw new Error(`no verdicts came back — ${verdicts.failed?.[0] ?? "nothing written"}`);
          // Hand them to the verb rather than appending here: `judge` is what
          // stamps the rubric hash, clears pending and settles the probe, and two
          // implementations of that is how a queue starts disagreeing with itself.
          ctl.log(`\nwriting ${verdicts.length} verdicts`);
          await runVerb("judge", [], { stdin: JSON.stringify(verdicts), ctl });
          remember(dir, { judge: null });
          return `${verdicts.length} verdict${verdicts.length === 1 ? "" : "s"} written`;
        } catch (e) {
          remember(dir, { judge: { error: e?.message ?? String(e), at: Date.now() } });
          throw e;
        }
      }, { label: AGENTIC.judge });
    }

    if (verb === "draft") {
      const id = String(args[0] ?? "");
      if (!id) return { error: "no item" };
      return J.run("draft", async (ctl) => {
        DRAFTING.set(dir, id);
        try {
          ctl.log(`assembling the prompt for ${id}`);
          // The `draft <id>` verb already builds the whole thing — the post, the
          // measured voice, the community's risks, the three-moves instruction.
          // It printed it for a human to paste. This sends it.
          // Everything after the id rides through: "--note <text>" is the
          // operator's critique of the last draft (the rewrite card).
          const prompt = await capture("draft", [id, ...args.slice(1)]);
          const note = args.includes("--note") ? String(args[args.indexOf("--note") + 1] ?? "") : "";
          const style = args.includes("--style") ? String(args[args.indexOf("--style") + 1] ?? "") : "";
          if (note) ctl.log(`with the operator's note on the last round${style ? ` (the ${style} draft)` : ""}`);
          const { draftReply } = await import("./agents.mjs");
          const { drafts, no_fit } = await draftReply(dir, prompt, ctl);
          if (!drafts.length) {
            // The writer's no is an answer, not a failure — but the card must
            // carry it, or the button reads as if it was never pressed.
            const why = no_fit ? `the writer declined: ${no_fit}` : "nothing came back from the writer";
            ctl.log(why);
            remember(dir, { draft: { id, error: why, at: Date.now() } });
            return why;
          }
          ctl.log(`\n${drafts.length} draft${drafts.length === 1 ? "" : "s"}:`);
          for (const d of drafts) ctl.log(`\n— ${d.style}\n${d.text}`);
          // All three are saved as one round, so they land on the card as tabs.
          // Saving runs the refusals over each, which is the only reason to go
          // through the verb rather than appending a draft row here.
          ctl.log(`\nsaving the round, and running the refusals over each`);
          await runVerb("draft", [id, "--save"], { stdin: JSON.stringify({ drafts, ...(note ? { note, style } : {}) }), ctl });
          remember(dir, { draft: null });
          return `${drafts.length} draft${drafts.length === 1 ? "" : "s"} on the card`;
        } catch (e) {
          remember(dir, { draft: { id, error: e?.message ?? String(e), at: Date.now() } });
          throw e;
        } finally {
          if (DRAFTING.get(dir) === id) DRAFTING.delete(dir);
        }
      }, { label: AGENTIC.draft });
    }
    return { error: `${verb} is not a thing this can run` };
  };

  /* The judge starts by itself (0.9.1). A verdict is not a decision the
   * operator has to make — the rule is theirs, the reading is the model's —
   * and a deck that sat on "Judge them" was a deck that sat. Every ten
   * seconds: something pending, a model to judge with, no read still filling
   * the queue (a probe or a tick judged mid-read is two small runs where one
   * would do), no judge already running, and not within five minutes of a
   * failure — a 429 on the free plan asked again every ten seconds is how a
   * day's budget goes. The card says so while it runs and says why when it
   * failed; the strip at the top of the panel shows it either way. */
  const JUDGE_RETRY_MS = 5 * 60_000;
  function autoJudge() {
    try {
      const dir = P();
      if (!hasModel(dir) || J.busy("judge")) return;
      if (["probe", "tick", "pull", "add"].some((v) => J.busy(v))) return;
      if (!S.pending().length) return;
      const failed = lastOf(dir).judge;
      if (failed && Date.now() - failed.at < JUDGE_RETRY_MS) return;
      startAgentic("judge", []);
    } catch (e) {
      console.error(`the judge could not start by itself: ${e?.message ?? e}`);
    }
  }
  const judgeClock = setInterval(autoJudge, 10_000);
  judgeClock.unref?.();

  /** This server's own address — for the panel's Settings tab. Null where
   *  there is no server: the extension's worker. */
  const SELF = () => (typeof base === "function" ? base() : base) ?? null;

  const startScout = (siteUrl) => {
    const started = J.run("scout", async (ctl) => {
      const { scoutSite } = await import("./agents.mjs");
      // The site is read in the operator's own browser, like everything else.
      return await scoutSite(P(), siteUrl, ctl, { browse: browser(LANE, { task: "reading your site", project: P() }) });
    }, { label: "Reading your site" });
    if (!started.error) patchStash(P(), { url: siteUrl, scoutJob: started.id });
    return started;
  };

  function cardSnapshot() {
    let stash = readStash(P());
    // A watch the operator pressed: the probe is cleared once its source is
    // on the list, and un-marked if the watch job ended without writing one
    // (a refusal — the watch card comes back and the job log says why).
    if (stash.probe?.watching) {
      const landed = S.sources().some((s) => s.place === stash.probe.place && (s.q ?? null) === (stash.probe.q ?? null));
      if (landed) stash = patchStash(P(), { probe: null });
      else if (!J.busy("watch")) stash = patchStash(P(), { probe: { ...stash.probe, watching: false } });
    }
    const scoutJob = stash.scoutJob ? J.get(stash.scoutJob) : null;
    const scout = scoutJob
      ? {
          status: scoutJob.status === "running" ? "running" : scoutJob.status === "error" ? "error" : "ready",
          url: stash.url ?? null,
          error: scoutJob.error ?? null,
          proposal: scoutJob.status === "ok" ? J.result(stash.scoutJob) : null,
        }
      : { status: "none", url: stash.url ?? null, error: null, proposal: null };
    // A scout that "finished" with nothing to show is a failure wearing ok's
    // clothes — the retry card is the honest one to deal.
    if (scout.status === "ready" && !scout.proposal) scout.status = "error";

    const sources = S.sources();
    // The room a probe just read is on the list too: `mq watch` refuses a room
    // whose rules nobody has read, so its rules card must be dealt before the
    // watch card — not after a watch that quietly wrote nothing.
    const probed = stash.probe?.fired && stash.probe.place && !sources.some((x) => x.place === stash.probe.place) ? [{ place: stash.probe.place }] : [];
    const rooms = [...sources, ...probed].map((s) => ({ place: s.place, state: S.roomState(s.place).state }));

    // Probe economics for the room being walked through onboarding.
    let probe = { running: J.busy("probe"), last: null, fitRate: null };
    if (stash.probe?.place) {
      const rows = S.readJsonl("probes.jsonl").filter((r) => r.place === stash.probe.place);
      probe.last = rows[rows.length - 1] ?? null;
      const tag = `${stash.probe.place}:${stash.probe.q ?? "new"}`;
      const verdicts = S.verdicts();
      const judged = [...S.found().values()].filter((f) => f.probe === tag && verdicts.has(f.id));
      if (judged.length) probe.fitRate = judged.filter((f) => verdicts.get(f.id).fit).length / judged.length;
    }

    // The queue with everything the reply card needs to be a control panel.
    // Under a FOCUS (0.8.0, the panel's campaign picker) only the people who
    // came in under that campaign — or under none — are dealt; the rest wait
    // where they were. The pending count and the judge stay global.
    const focus = stash.campaign_focus ?? null;
    const inFocus = (row) => (focus === null ? true : focus === "none" ? !row.campaign : row.campaign === focus);
    const drafts = S.drafts();
    const stand = standing([...S.items().values()], S.checksById());
    const sent = S.sentLog();
    const queue = queueRows().filter(inFocus).map((it) => {
      const draft = drafts.filter((d) => d.id === it.id).pop() ?? null;
      const blocked = burst(sent, it.place);
      const ready = readiness(stand.get(it.place) ?? { place: it.place, comments: 0, visible: 0 }, S.roomState(it.place));
      // The composer the Insert flow looks for on this platform rides on the
      // card, so the extension carries no platform words of its own.
      return { ...it, draft, blockedWhy: blocked?.why ?? null, readyState: ready.state, readyWhy: ready.why ?? null, composer: composerOf(it.url) };
    });

    const rawVoice = existsSync(S.F("voice.json")) ? JSON.parse(readFileSync(S.F("voice.json"), "utf8")) : null;

    // The return (0.7.0): conversations waiting on the operator, oldest
    // first, each with the draft written for THIS turn if there is one.
    const conversations = waitingRows(S).filter(inFocus).map((c) => {
      const turn = yourTurns(c) + 1;
      const draft = drafts.filter((d) => d.id === c.id && (d.turn ?? 1) === turn).pop() ?? null;
      const said = (c.turns ?? []).filter((t) => t.by === "you").pop()?.text ?? "";
      const url = c.latest?.url ?? c.url;
      return { id: c.id, author: c.latest?.author ?? c.author ?? null, place: c.place, url, campaign: c.campaign ?? null, latest: c.latest, said, turn, draft, composer: composerOf(url) };
    });
    // The clock: what a tick would read now. Computed, never remembered.
    const lr = new Map(S.readJsonl("reads.jsonl").filter((r) => r.source).map((r) => [r.source, r]));
    const due = {
      sources: sources.filter((s) => { const r = lr.get(s.id); return !r || Date.now() - Date.parse(r.at) >= s.cadence_min * 60_000; }).length,
      conversations: dueConversations(S).length,
      unbound: unbound(S).length,
      running: J.busy("tick") || J.busy("back") || J.busy("sync"),
    };

    return {
      stash,
      focus,
      conversations,
      due,
      platform: LB(),
      account: acct(),
      hasModel: hasModel(P()),
      memory: memoryProgress(P()),
      voice: mergeVoice(rawVoice?.measured ?? null, rawVoice?.user ?? null),
      scout,
      probe,
      sources,
      rooms,
      pendingCount: S.pending().length,
      // The judge and the writer as the cards need them (0.9.1): running now,
      // or failed last — so a card never offers what is already being done,
      // and never hides a failure behind the same button.
      judging: J.busy("judge"),
      judgeFailed: lastOf(P()).judge && Date.now() - lastOf(P()).judge.at < 10 * 60_000 ? lastOf(P()).judge.error : null,
      drafting: DRAFTING.get(P()) ?? null,
      draftFailed: lastOf(P()).draft ? { id: lastOf(P()).draft.id, error: lastOf(P()).draft.error } : null,
      queue,
      itemCount: S.items().size,
      contactedCount: S.contacted().size,
      syncRunning: J.busy("sync"),
      // Colleagues at work: a blocked one's question outranks everything, a
      // finished one's result is a card once. No runtime, no tasks.
      tasks: RT() ? RT().list() : [],
      brain: Boolean(RT()),
      // Sites a leased tab is on that the extension may not read yet — the
      // panel's card carries the button Chrome needs the click from.
      grants: CONTROL.grantsNeeded(),
    };
  }

  /**
   * One act = one card answered. `action` is the pressed BUTTON'S ID — "save",
   * "skip", "posted" — never its slot. The watch card is why: whether "Watch it"
   * is the primary or the fallback depends on the probe's numbers, and a handler
   * that dispatched on "primary" would have to re-derive the numbers to know what
   * was pressed. The ids already say it.
   *
   * Returns {ok} or {error}; the client re-fetches the deck either way, because
   * the deck is the truth about what comes next.
   */
  async function actCard({ card, action, choice, choices, text, tab }) {
    const id = String(card ?? "");
    const act = String(action ?? "");
    const t = String(text ?? "").trim();
    const picked = String(choice ?? "");
    // Which of the three drafts the button was pressed from (0.8.0) — the
    // card's tab. Unknown is null; nothing below needs it to be known.
    const style = styleOf(tab)?.id ?? null;
    const tabText = (row) => (style && (row?.drafts ?? []).find((d) => d.style === style)?.text) || row?.text || "";
    const many = Array.isArray(choices) ? choices.map(String).filter(Boolean) : [];
    const spawn = (verb, args = []) => { J.start(verb, args, { label: SPAWNABLE[verb] }); return { ok: true }; };
    /** One question's answer, as the asker gets it back: a choice id, the list
     *  of them, free text, both when the card had both, null when skipped. */
    const answerValue = () => (act === "skip" ? null : many.length > 1 ? many : picked && t ? { choice: picked, text: t } : picked || t || null);

    /* ---- colleagues: a worker's question, its result, the specialist's own
       proposals, notes and questions. The runtime is the one that acts; the
       deck only carries the answer to it. */
    if (id.startsWith("task.ask.")) {
      if (!RT()) return { error: "the runtime is not installed — npm run brain" };
      const [, , taskId, qid] = id.split(".");
      if (act === "show") return { ok: true };            // client-side: the browser fronts the tab
      if (!qid) return { error: "which question?" };
      const out = RT().answerQuestion(taskId, qid, answerValue());
      return out.error ? { error: out.error } : { ok: true };
    }
    if (id.startsWith("task.done.") || id.startsWith("task.failed.")) {
      if (!RT()) return { error: "the runtime is not installed — npm run brain" };
      const taskId = id.split(".")[2];
      RT().ack(taskId);
      if (act === "retry") { const r = await RT().retry(taskId); if (r.error) return { error: r.error }; }
      return { ok: true };
    }
    if (id === "cmo.propose") {
      const list = readStash(P()).proposals ?? [];
      const p = list[0];
      patchStash(P(), { proposals: list.slice(1) });    // either way, the card is spent
      if (act !== "start" || !p?.task?.agent) { if (p && RT()) RT().note("proposal.dismissed", { agent: p.task?.agent, question: p.question }); return { ok: true }; }
      if (!RT()) return { error: "the runtime is not installed — npm run brain" };
      // The colleague and its input are re-read from the STASH, never taken
      // from the request — the click only ever says "start" to what the
      // specialist itself wrote there.
      const r = await RT().start(p.task.agent, p.task.input ?? {}, { title: p.task.title ?? p.question });
      if (r.error) return { error: r.error };
      RT().note("proposal.accepted", { task: r.id, agent: p.task.agent, question: p.question });
      return { ok: true };
    }
    if (id === "cmo.note") { patchStash(P(), { cmo_note: null }); return { ok: true }; }
    // The grant card: "allow" is answered in the panel (Chrome's own prompt,
    // then /api/control/granted); "later" puts the ask away until a task hits
    // that wall again.
    if (id.startsWith("grant.")) {
      if (act === "later") CONTROL.dismiss(id.slice("grant.".length));
      return { ok: true };
    }
    /* ---- a campaign, walked through: the specialist's proposal or the
       dashboard's form, one card per thing to settle, the file written by the
       last Save (lib/campaigns.mjs) and the room probed under it. */
    if (id === "campaign.status") {
      const st = readStash(P()).campaign_status_draft;
      patchStash(P(), { campaign_status_draft: null });
      if (!st?.id || act !== "apply") return { ok: true };
      const r = setCampaignStatus(P(), st.id, st.status);
      if (r.error) return { error: r.error };
      INBOX({ type: "campaign.status", title: `“${r.name}” (${r.id}) is now ${r.status} — the operator agreed`, campaign: r.id, status: r.status });
      return { ok: true };
    }

    if (id.startsWith("campaign.")) {
      const step = id.slice("campaign.".length);
      const d = readStash(P()).campaign_draft;
      if (!d) return { ok: true };
      const done = new Set(d.done ?? []);
      const next = (patch = {}) => { done.add(step); patchStash(P(), { campaign_draft: { ...d, ...patch, done: [...done] } }); return { ok: true }; };
      if (step === "idea") {
        if (act === "drop") { patchStash(P(), { campaign_draft: null }); return { ok: true }; }
        if (!t) return { error: "the idea is the campaign — write it in your words, or press Not now" };
        return next({ idea: t });
      }
      if (step === "fit") return next({ fit: act === "skip" ? "" : t });
      if (step === "mention") { if (!MENTIONS[picked]) return { error: "pick one" }; return next({ mention: picked }); }
      if (step === "room") {
        const place = (t || picked).replace(/^\/?r\//i, "").replace(/[^\w-]/g, "");
        if (!place) return { error: "name a room" };
        return next({ place });
      }
      if (step === "phrase") {
        const q = act === "new" ? "" : t;
        const place = d.place;
        if (!place) return { error: "no room picked" };
        const c = writeCampaign(P(), { id: d.id, name: d.name, platform: d.platform ?? first()?.id ?? null, status: "active", mention: d.mention, idea: d.idea, fit: d.fit, never: d.never });
        if (c.error) return { error: c.error };
        patchStash(P(), { campaign_draft: null, probe: { place, q: q || null, fired: true, campaign: c.id } });
        INBOX({ type: "campaign.created", title: `“${c.name}” (${c.id}) — ${LB().room(place)}${q ? ` for “${q}”` : " (new posts)"}, mention: ${c.mention}`, campaign: c.id, place, q: q || null });
        return spawn("probe", [place, ...(q ? ["--q", q] : []), "--campaign", c.id]);
      }
      return { ok: true };
    }

    if (id.startsWith("cmo.ask.")) {
      const qid = id.slice("cmo.ask.".length);
      const a = readStash(P()).cmo_ask;
      if (!a?.questions?.length) return { ok: true };
      const answers = { ...(a.answers ?? {}), [qid]: answerValue() };
      if (a.questions.every((q) => q.id in answers)) {
        patchStash(P(), { cmo_ask: null });
        RT()?.note("person.answered", { ask: a.id ?? null, answers });
      } else {
        patchStash(P(), { cmo_ask: { ...a, answers } });
      }
      return { ok: true };
    }

    if (id === "onboard.account") {
      if (act === "skip") { patchStash(P(), { account_skipped: true }); return { ok: true }; }
      if (!t) return { error: "no username" };
      return spawn("me", [t.replace(/^u\//, "")]);
    }

    if (id === "onboard.url") {
      if (act === "manual") { patchStash(P(), { manual: true }); return { ok: true }; }
      if (!/^https?:\/\//i.test(t)) return { error: "paste a full address, https://…" };
      if (hasModel(P())) return startScout(t).error ? { error: "the scout is already running" } : { ok: true };
      patchStash(P(), { url: t });
      return { ok: true };
    }

    if (id === "onboard.key") {
      if (act === "manual") { patchStash(P(), { manual: true, url: null }); return { ok: true }; }
      try { writeKey(P(), t); } catch (e) { return { error: e.message }; }
      const site = readStash(P()).url;
      return site && startScout(site).error ? { error: "the scout is already running" } : { ok: true };
    }

    if (id === "onboard.scout_failed") {
      if (act === "manual") { patchStash(P(), { manual: true, scoutJob: null }); return { ok: true }; }
      const site = readStash(P()).url;
      if (!site) { patchStash(P(), { scoutJob: null }); return { ok: true }; }
      return startScout(site).error ? { error: "the scout is already running" } : { ok: true };
    }

    if (id.startsWith("onboard.voice.")) {
      const key = id.slice("onboard.voice.".length);
      if (!picked) return { error: "pick one — \"not sure\" is a real answer" };
      const value = picked === "unsure" ? VOICE_UNSURE : picked;
      const p = S.F("voice.json");
      const raw = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
      const user = applyVoiceAnswers(raw.user ?? {}, { [key]: value });
      writeFileSync(p, JSON.stringify({ ...raw, user }, null, 2));
      const done = new Set(readStash(P()).voice_done ?? []); done.add(key);
      patchStash(P(), { voice_done: [...done] });
      return { ok: true };
    }

    if (id.startsWith("onboard.file.")) {
      const file = id.slice("onboard.file.".length);
      if (!["project.md", "icp.md", "rule.md"].includes(file)) return { error: "not a setup file" };
      if (!t) return { error: "an empty file is not an answer here" };
      writeMemory(P(), file, t);
      return { ok: true };
    }

    if (id === "onboard.manual") {
      if (act === "scout") { patchStash(P(), { manual: null }); return { ok: true }; }
      return { ok: true }; // "I filled them" — the deck re-checks, which is the answer
    }

    if (id === "onboard.room") {
      const place = LB().bare(t);
      if (!place) return { error: "name a room" };
      patchStash(P(), { probe: { place } });
      return { ok: true };
    }

    if (id === "onboard.phrase") {
      const place = readStash(P()).probe?.place;
      if (!place) return { error: "no room picked" };
      const q = act === "new" ? null : t || null;
      patchStash(P(), { probe: { place, q, fired: true } });
      return spawn("probe", q ? [place, "--q", q] : [place]);
    }

    if (id === "onboard.watch") {
      const probe = readStash(P()).probe;
      const place = probe?.place;
      if (act === "watch" && place) {
        // The verb would refuse and the job would still say ok: say it here,
        // keep the probe, and let the rules card (dealt first) settle it.
        const state = S.roomState(place).state;
        if (state === "unanswered") return { error: `Record ${LB().room(place)}'s rules first — that card is on the deck.` };
        if (state === "banned") return { error: `${LB().room(place)}'s rules forbid it, as you recorded — nothing here will draft for it. Try another room.` };
        // The probe stays on the stash, marked, until the watch job lands
        // (cardSnapshot clears it once the source exists): clearing it here
        // dealt "which room?" again for the second the job took (0.8.0).
        patchStash(P(), { probe: { ...probe, watching: true } });
        // Watched the way it was measured: the phrase that cleared the floor —
        // and under the campaign it was probed for.
        return spawn("watch", [place, ...(probe.q ? ["--q", probe.q] : []), ...(probe.campaign ? ["--campaign", probe.campaign] : [])]);
      }
      patchStash(P(), { probe: null });
      return { ok: true }; // "another" — back to the room card
    }

    if (id === "onboard.empty_probe") { patchStash(P(), { probe: null }); return { ok: true }; }

    if (id === "onboard.welcome") {
      patchStash(P(), { welcomed: true });
      // The CMO hears that setup is done — its cue to propose the first task.
      const watched = S.sources().map((s) => `${LB().room(s.place)}${s.q ? ` for "${s.q}"` : " (new posts)"}`).join(", ");
      // A source's url IS the page a person opens now (0.6.0), and the
      // platform it belongs to names the colleague the CMO proposes.
      INBOX({ type: "setup.done", title: `the operator finished setup on the panel — watching ${watched || "no room yet"}`, sources: S.sources().map((s) => ({ place: s.place, q: s.q ?? null, url: s.url, platform: (platformFor(s.url) ?? first())?.id ?? null, campaign: s.campaign ?? null })) });
      return act === "tick" ? spawn("tick") : { ok: true };
    }

    if (id.startsWith("room.rules.")) {
      const place = id.slice("room.rules.".length).replace(/[^\w-]/g, "");
      if (!["yes", "no"].includes(picked)) return { error: "pick one" };
      const existing = existsSync(S.roomPath(place)) ? readFileSync(S.roomPath(place), "utf8") : roomFile(place, null, { label: LB().room(place), rulesUrl: LB().rulesUrl(place) });
      S.writeRoom(place, existing.replace(/^promotion_allowed:.*$/mi, `promotion_allowed: ${picked}`));
      return { ok: true };
    }

    if (id === "agent.propose") {
      const p = proposable(readStash(P()).agent_card?.verb);
      patchStash(P(), { agent_card: null });   // either way, the card is spent
      if (act !== "do" || !p) return { ok: true };
      // The verb is re-parsed from the STASH, never taken from the request —
      // the client only ever says "do" or "dismiss" to whatever the server
      // itself wrote there.
      if (p.verb === "judge" || p.verb === "draft") { const r = startAgentic(p.verb, p.args); return r?.error ? r : { ok: true }; }
      return spawn(p.verb, p.args);
    }

    if (id === "work.judge") {
      // A refusal — the judge already running — goes back to the panel as
      // words, not as a button that seemed to do nothing.
      if (act === "judge") { const r = startAgentic("judge", []); if (r?.error) return r; }
      return { ok: true };
    }

    if (id.startsWith("work.reply.") || id.startsWith("work.draft.")) {
      const itemId = id.replace(/^work\.(reply|draft)\./, "");
      const it = S.found().get(itemId);
      if (!it) return { error: "that person is no longer in the queue" };
      if (act === "posted") {
        // The gate is checked HERE, not only on the card: a stale panel must not
        // be able to record a send the governor already said no to.
        const blocked = burst(S.sentLog(), it.place);
        if (blocked) return { error: blocked.why };
        S.append("marks.jsonl", { id: itemId, mark: "sent", at: new Date().toISOString(), via: "panel", ...(style ? { style } : {}) });
        if (it.author) S.append("contacted.jsonl", { author: it.author, id: itemId, at: new Date().toISOString() });
        // The conversation opens here, with what actually went up — the
        // card's field as edited, or the tab's draft when the panel sent
        // nothing — and which of the three it was.
        const last = S.drafts().filter((d) => d.id === itemId).pop();
        openConversation(S, it, { text: t || tabText(last), via: "panel", style });
        return { ok: true };
      }
      if (act === "skip") {
        S.append("marks.jsonl", { id: itemId, mark: "skip", at: new Date().toISOString(), via: "panel" });
        return { ok: true };
      }
      if (act === "draft") { const r = startAgentic("draft", [itemId]); return r?.error ? r : { ok: true }; }
      if (act === "rewrite") {
        const last = S.drafts().filter((d) => d.id === itemId).pop();
        patchStash(P(), { rewrite: { id: itemId, prior: t || tabText(last), style, who: it.author ? `u/${it.author}` : null } });
        return { ok: true };
      }
      return { ok: true }; // "insert" is client-side; nothing to record until "posted"
    }

    /* Somebody wrote back (0.7.0): the turn card. No governor — a reply in a
       thread you are already in is not the shape that got anybody filtered —
       and no retirement: they are already on the ledger. */
    if (id.startsWith("work.turn.")) {
      const itemId = id.slice("work.turn.".length);
      const conv = conversationRows(S).get(itemId);
      if (!conv) return { error: "that conversation is no longer tracked" };
      if (act === "posted") {
        const turn = yourTurns(conv) + 1;
        const last = S.drafts().filter((d) => d.id === itemId && (d.turn ?? 1) === turn).pop();
        recordTurn(S, conv, { text: t || tabText(last), via: "panel", style });
        return { ok: true };
      }
      if (act === "skip") { closeConversation(S, conv); return { ok: true }; }
      if (act === "draft") { const r = startAgentic("draft", [itemId]); return r?.error ? r : { ok: true }; }
      if (act === "rewrite") {
        const turn = yourTurns(conv) + 1;
        const last = S.drafts().filter((d) => d.id === itemId && (d.turn ?? 1) === turn).pop();
        patchStash(P(), { rewrite: { id: itemId, prior: t || tabText(last), style, who: conv.latest?.author ? `u/${conv.latest.author}` : null } });
        return { ok: true };
      }
      return { ok: true };
    }

    /* The note for the writer: the rejected draft, which of the three it was,
       and what should change. All three come back written again. */
    if (id.startsWith("work.rewrite.")) {
      const itemId = id.slice("work.rewrite.".length);
      const r = readStash(P()).rewrite ?? {};
      patchStash(P(), { rewrite: null });
      if (act !== "rewrite") return { ok: true };
      if (!t) return { error: "say what should change, or keep the drafts" };
      const started = startAgentic("draft", [itemId, "--note", t.slice(0, 600), ...(r.style ? ["--style", r.style] : [])]);
      return started?.error ? started : { ok: true };
    }

    if (id === "work.due") {
      if (act === "later") { patchStash(P(), { due_later: new Date().toISOString() }); return { ok: true }; }
      return spawn("tick");
    }

    if (id === "work.sync") {
      if (act === "later") { patchStash(P(), { sync_later: true }); return { ok: true }; }
      return spawn("sync");
    }

    if (id === "work.me") { patchStash(P(), { me_later: true }); return { ok: true }; }

    if (id === "work.quiet") { return act === "tick" ? spawn("tick") : { ok: true }; }

    return { ok: true }; // wait cards and anything shown-only: acting is a no-op
  }

  const projectSummary = () => { const cur = PJ(); return { id: cur.id, name: cur.name, all: listProjects(DATA).map((p) => ({ id: p.id, name: p.name, current: p.current })) }; };

  /** Switch or make a project, from the panel or the dashboard. Its runtime
   *  comes up on demand; the one it left keeps running its tasks. */
  function switchProject(body = {}) {
    const action = String(body.action ?? "");
    const r = action === "new" ? createProject(DATA, String(body.name ?? "")) : action === "use" ? useProject(DATA, String(body.id ?? "")) : { error: "action is new or use" };
    if (r.error) return r;
    afterSwitch();
    return { ok: true, project: projectSummary() };
  }

  const controlSummary = () => ({
    attached: CONTROL.attached(),
    leases: CONTROL.leases().map((l) => ({ id: l.id, task: l.task, url: l.url, tabs: l.tabs })),
    grants: CONTROL.grantsNeeded(),
    instances: CONTROL.instances(),
  });

  /* -------------------------------------------------------------- the panel */

  // The panel is self-contained from 0.8.0: beside the deck it has the
  // campaigns, the rooms and the settings as tabs of its own, so switching a
  // project or a campaign, trying another room, or changing the seats never
  // needs the dashboard. One GET says what those tabs show; one POST is every
  // button on them. JSON-only, same CSRF boundary as the deck's two routes.

  const roomId = (v) => String(v ?? "").trim().replace(/^\/?r\//i, "").replace(/[^\w-]/g, "").slice(0, 40);

  /** What the panel's tabs show: campaigns with numbers and sources, what is
   *  watched and whether it is due, the rooms and their rules, the seats. */
  function panelState() {
    const dir = P();
    const stash = readStash(dir);
    const camps = readCampaigns(dir);
    const dg = campaignDigest(S, camps);
    const numbersOf = (id) => { const r = dg.find((x) => x.id === id); return r ? { found: r.found, judged: r.judged, fit: r.fit, fitRate: r.fitRate, sent: r.sent, replies: r.replies, second: r.second, waiting: r.waiting, crowd: r.crowd } : null; };
    const srcs = S.sources();
    const reads = new Map(S.readJsonl("reads.jsonl").filter((r) => r.source).map((r) => [r.source, r]));
    const found = [...S.found().values()];
    const L = LB();
    const p = plan(dir);
    const picks = chosen(dir, p);
    const probed = [...new Set(S.readJsonl("probes.jsonl").map((r) => r.place).filter(Boolean))];
    const rooms = [...new Set([...srcs.map((s) => s.place), ...probed, ...(stash.probe?.place ? [stash.probe.place] : [])])]
      .map((place) => ({ place, label: L.room(place), state: S.roomState(place).state, rulesUrl: L.rulesUrl(place), watched: srcs.some((s) => s.place === place) }));
    const local = localConfig(dir);
    return {
      project: projectSummary(),
      account: acct()?.name ?? null,
      // The count only — the files' bodies are the dashboard's to show.
      setup: (({ done, total }) => ({ done, total }))(memoryProgress(dir)),
      focus: stash.campaign_focus ?? null,
      campaigns: camps.map((c) => ({
        id: c.id, name: c.name, status: c.status, mention: c.mention, idea: c.idea, fit: c.fit, never: c.never, voice: c.voice ?? "", hash: c.hash,
        numbers: numbersOf(c.id), sources: srcs.filter((s) => s.campaign === c.id).map((s) => s.id),
      })),
      general: numbersOf(null),
      mentions: Object.entries(MENTIONS).map(([id, m]) => ({ id, label: m.label, note: m.note })),
      sources: srcs.map((s) => {
        const r = reads.get(s.id);
        return {
          id: s.id, place: s.place, label: L.room(s.place), q: s.q ?? null, campaign: s.campaign ?? null, cadence_min: s.cadence_min,
          // The source id is lowercased by `watch`; the probe's tag kept the
          // phrase as typed. Same read, so the count compares them as one.
          found: found.filter((f) => String(f.probe ?? "").toLowerCase() === s.id).length,
          last: r ? { at: r.at, ok: Boolean(r.ok), err: r.err ?? null } : null,
          due: !r || Date.now() - Date.parse(r.at) >= s.cadence_min * 60_000,
        };
      }),
      rooms,
      probe: stash.probe ?? null,
      pending: S.pending().length,
      waiting: waitingRows(S).length,
      // Everyone ever answered, across projects — the ledger that keeps the
      // same human from being answered twice.
      contacted: S.contacted().size,
      running: J.running().map((j) => ({ verb: j.verb, label: j.label })),
      settings: {
        plan: p,
        plans: Object.values(PLANS).map((q) => ({ key: q.key, title: q.title, what: q.what, needsKey: q.needsKey })),
        key: { set: hasKey(dir), source: keySource(dir), url: KEY_URL },
        roles: Object.values(ROLES).map((r) => { const info = modelInfo(p, picks[r.key]); return { key: r.key, title: r.title, what: r.what, model: picks[r.key], label: info.label, note: info.note }; }),
        menu: p === "local" ? Object.values(PLANS.local.menu).map((m) => ({ id: m.id, label: m.label, note: m.note })) : Object.values(PLANS[p].menu).map((m) => ({ id: m.id, label: m.label, note: m.note })),
        local: { baseUrl: local.baseUrl, key: Boolean(local.key) },
        server: SELF(),
        /** The words this surface uses when it means the platform — all of
         *  them from the adapter, so a panel drawn against a second skill
         *  says that skill's words without a line changing here. */
        platform: {
          id: PL()?.id ?? null,
          name: L.name,
          room: { ...L.roomAsk, example: L.room(L.roomAsk.placeholder) },
          account: L.account,
          phrase: L.phrase.placeholder,
          rules: L.rules,
          submit: L.submit,
          /** What the browser can answer about the account by itself. */
          cookies: PLA().cookies,
          whoami: Boolean(PLA().whoami),
        },
        /** Everything active, so a person with two skills can say which one
         *  a room, a probe or a campaign means. One, today. */
        platforms: platforms().map((q) => ({ id: q.id, name: q.name, cookies: accountOf(q).cookies })),
      },
    };
  }

  /** Every button on the panel's tabs. `do` names it; the rest is its input.
   *  Returns {ok} or {error} — the panel re-reads the state either way. */
  async function panelAct(body = {}) {
    const dir = P();
    const act = String(body.do ?? "");
    const s = (v, n = 200) => String(v ?? "").trim().slice(0, n);
    const spawnOnce = (verb, args = []) => { const r = J.start(verb, args, { label: SPAWNABLE[verb] }); return r?.error ? { error: `${SPAWNABLE[verb] ?? verb} is already running` } : { ok: true }; };
    switch (act) {
      case "campaign.status": {
        const r = setCampaignStatus(dir, s(body.id, 40), s(body.status, 10));
        if (r.error) return r;
        INBOX({ type: "campaign.status", title: `“${r.name}” (${r.id}) is now ${r.status} — set on the panel`, campaign: r.id, status: r.status });
        if (readStash(dir).campaign_focus === r.id && r.status !== "active") patchStash(dir, { campaign_focus: null });
        return { ok: true };
      }
      case "campaign.save": {
        const prior = readCampaign(dir, s(body.id, 40));
        if (!prior) return { error: "no such campaign" };
        const r = writeCampaign(dir, {
          ...prior,
          idea: body.idea === undefined ? prior.idea : s(body.idea, 3000),
          fit: body.fit === undefined ? prior.fit : s(body.fit, 1200),
          never: body.never === undefined ? prior.never : s(body.never, 1200),
          voice: body.voice === undefined ? prior.voice : s(body.voice, 600),
          mention: MENTIONS[body.mention] ? body.mention : prior.mention,
        });
        return r.error ? r : { ok: true };
      }
      case "campaign.new": {
        const d = campaignDraft({ name: body.name, idea: body.idea, platform: first()?.id ?? null });
        if (!d.name || !d.id) return { error: "a campaign needs a name" };
        if (readCampaign(dir, d.id)) return { error: `a campaign “${d.id}” already exists — edit it instead` };
        // Onto the deck: the same five cards the specialist's proposal walks
        // through, the idea asked first when it was not given.
        patchStash(dir, { campaign_draft: { ...d, by: "you", done: [] } });
        return { ok: true };
      }
      case "campaign.focus": {
        const id = s(body.id, 40);
        if (id && id !== "none" && !readCampaign(dir, id)) return { error: "no such campaign" };
        patchStash(dir, { campaign_focus: id || null });
        return { ok: true };
      }
      case "campaign.probe": {
        const c = readCampaign(dir, s(body.id, 40));
        if (!c) return { error: "no such campaign" };
        const place = roomId(body.place);
        if (!place) return { error: "name a room" };
        const q = s(body.q, 120) || null;
        patchStash(dir, { probe: { place, q, fired: true, campaign: c.id } });
        return spawnOnce("probe", [place, ...(q ? ["--q", q] : []), "--campaign", c.id]);
      }
      case "probe": {
        const place = roomId(body.place);
        if (!place) return { error: "name a room" };
        const q = s(body.q, 120) || null;
        patchStash(dir, { probe: { place, q, fired: true } });
        return spawnOnce("probe", q ? [place, "--q", q] : [place]);
      }
      case "room.rules": {
        const place = roomId(body.place);
        const answer = body.answer === "yes" ? "yes" : body.answer === "no" ? "no" : null;
        if (!place || !answer) return { error: "which room, and does it allow it — yes or no" };
        const existing = existsSync(S.roomPath(place)) ? readFileSync(S.roomPath(place), "utf8") : roomFile(place, null, { label: LB().room(place), rulesUrl: LB().rulesUrl(place) });
        S.writeRoom(place, existing.replace(/^promotion_allowed:.*$/mi, `promotion_allowed: ${answer}`));
        return { ok: true };
      }
      case "unwatch": {
        const id = s(body.id, 80).toLowerCase();
        if (!S.sources().some((x) => x.id === id)) return { error: "that source is not watched" };
        return spawnOnce("unwatch", [id]);
      }
      case "tick": return spawnOnce("tick");
      case "sync": return spawnOnce("sync");
      case "judge": { const r = startAgentic("judge", []); return r?.error ? r : { ok: true }; }
      case "settings.plan": { try { setPlan(dir, s(body.plan, 10)); return { ok: true }; } catch (e) { return { error: e.message }; } }
      case "settings.key": {
        if (keySource(dir) === "env") return { error: "the key comes from OPENROUTER_API_KEY in this server's environment — change it there" };
        try { writeKey(dir, s(body.key, 300)); return { ok: true }; } catch (e) { return { error: e.message }; }
      }
      case "settings.model": { try { choose(dir, s(body.role, 10), s(body.model, 120)); return { ok: true }; } catch (e) { return { error: e.message }; } }
      case "settings.local": { try { setLocal(dir, { baseUrl: s(body.baseUrl, 200), ...(body.key !== undefined ? { key: s(body.key, 300) } : {}) }); return { ok: true }; } catch (e) { return { error: e.message }; } }
      // No name means "look in this browser": the platform's own address
      // for your profile redirects to it while you are signed in, and the
      // handle is read off the address rather than out of your memory.
      case "account": { const name = s(body.name, 60).replace(/^u\//, ""); return spawnOnce("me", name ? [name] : []); }
      case "settings.platform": {
        const id = s(body.id, 40);
        if (!platformById(id)) return { error: "no such platform is active" };
        patchStash(dir, { platform: id });
        return { ok: true };
      }
      case "project.use": return switchProject({ action: "use", id: body.id });
      case "project.new": return switchProject({ action: "new", name: body.name });
      default: return { error: `not a thing the panel can do: ${act || "(nothing)"}` };
    }
  }


  /**
   * Run a verb inside a job that is already running — the judge writing its
   * verdicts through `judge`, the writer saving through `draft --save`. The
   * same function the CLI runs (lib/verbs.mjs), its lines into the job's
   * log, so the refusals run over a model's words exactly as over a human's:
   * one implementation of the guards, not two.
   */
  const runVerb = async (verb, args = [], { stdin = "", ctl = null } = {}) => {
    const lines = [];
    const log = (l) => { lines.push(String(l ?? "")); ctl?.log?.(l); };
    const V = verbs({ root: DATA, dir: P(), log, warn: log, browse: (o) => browser(LANE, o) });
    await V[verb](args, stdin);
    return lines.join("\n") + (lines.length ? "\n" : "");
  };

  /** The same, but the output is the answer and is not echoed into the log —
   *  `draft <id>` prints a whole prompt and the job log is not where it goes. */
  const capture = (verb, args = []) => runVerb(verb, args, { ctl: null });

  /* ------------------------------------------------------------- the API */

  /** The JSON routes this engine answers, by method and path — the deck, the
   *  projects, the panel's tabs, the control lane, the strategist, the jobs.
   *  bin/serve.mjs serves them over HTTP; the extension's worker over
   *  chrome.runtime messages. One table, so the two cannot drift. */
  const ROUTES = {
    "GET /api/cards": async (q) => ({ status: 200, body: deck(q.instance ?? null) }),
    "GET /api/projects": async () => ({ status: 200, body: projectSummary() }),
    "POST /api/projects": async (q, body) => { const out = switchProject(body ?? {}); return { status: out.error ? 400 : 200, body: out }; },
    "GET /api/panel": async () => ({ status: 200, body: panelState() }),
    "POST /api/panel/act": async (q, body) => { const out = await panelAct(body ?? {}); return { status: out.error ? 400 : 200, body: out }; },
    "POST /api/cards/act": async (q, body) => { const out = await actCard(body ?? {}); return { status: out.error ? 400 : 200, body: out }; },
    /* The control lane (lib/control.mjs). /lease, /act and /release are what a
     * task manager or a script calls and holds open; /jobs is the extension's
     * service worker asking "anything for me?" (long-polled); /answer is the
     * result coming back; /granted is the panel saying the operator allowed a
     * site. Grants ride in the request because a local caller already has the
     * run of the machine — the screen that matters is the one an AGENT's
     * definition passes, in agent/, and the extension's own label screen. */
    "POST /api/control/lease": async (q, body) => {
      const out = await CONTROL.lease({ task: body?.task, url: body?.url, stranger: Boolean(body?.stranger), project: body?.project ? String(body.project) : null });
      return { status: out.error ? 502 : 200, body: out };
    },
    "POST /api/control/act": async (q, body) => {
      const grants = Array.isArray(body?.grants) ? body.grants.map(String) : ["read"];
      const out = await CONTROL.act(body?.lease, String(body?.tool ?? ""), body?.input ?? {}, { grants });
      return { status: out?.error ? (out.refused ? 403 : 502) : 200, body: out ?? {} };
    },
    "POST /api/control/release": async (q, body) => ({ status: 200, body: await CONTROL.release(body?.lease) }),
    "GET /api/control/jobs": async (q) => {
      const wait = Math.min(25_000, Math.max(0, Number(q.wait) || 0));
      try { return { status: 200, body: { jobs: await CONTROL.claim(wait, q.instance ?? null) } }; }
      catch { return { status: 200, body: { jobs: [] } }; }
    },
    "POST /api/control/answer": async (q, body) => { const { id, ...result } = body ?? {}; return { status: 200, body: { ok: true, took: CONTROL.answer(id, result) } }; },
    "POST /api/control/reload": async () => ({ status: 200, body: await CONTROL.reload() }),
    "POST /api/control/granted": async (q, body) => { CONTROL.granted(body?.origin); return { status: 200, body: { ok: true } }; },
    "GET /api/control/leases": async () => ({ status: 200, body: { ...controlSummary(), detail: CONTROL.leases() } }),
    /* The strategist — present only when agent/ has been installed on a Node
     * host. The engine never depends on it; this route is the one seam. */
    "POST /api/agent": async (q, body) => {
      const message = String(body?.message ?? "");
      // Answered here, BEFORE the lazy import: an empty message is the panel
      // pinging the seam, and "is anyone there" must not cost a brain install.
      if (!message.trim()) return { status: 200, body: { reply: "Say something and I will answer." } };
      let strategist;
      try {
        if (host().kind !== "node") throw new Error("no Node on this host");
        ({ strategist } = await import("../agent/strategist.mjs"));
      } catch (e) {
        return { status: 503, body: { error: "the strategist is not installed", how: "npm run brain   (installs agent/ — Deep Agents and the LangChain runtime; everything else works without it)", detail: String(e.message ?? e).split("\n")[0] } };
      }
      try { return { status: 200, body: await strategist(P(), message, String(body?.thread ?? "panel")) }; }
      catch (e) { console.error(e); return { status: 500, body: { error: String(e.message ?? e).split("\n")[0] } }; }
    },
    "GET /api/jobs.json": async () => ({ status: 200, body: { jobs: J.list().slice(0, 12) } }),
    /* The runtime, as JSON: tasks, colleagues, and why there are none. */
    "GET /api/tasks.json": async (q) => ({ status: 200, body: {
      tasks: RT() ? RT().list() : [],
      colleagues: RT() ? RT().colleagues().map((c) => ({ id: c.id, name: c.name, description: c.description, tools: c.tools, grants: c.grants, model: c.model, ring: c.ring })) : [],
      inbox: RT() ? RT().inbox(Math.max(0, Number(q.since) || 0)) : null,
      why: RT() ? null : (WHY() || "the runtime is not installed — npm run brain"),
    } }),
  };

  /** What the extension's side panel lives on: the cards, the jobs running
   *  and just finished, the project, the lane, the tasks, whether a brain
   *  is there to ask. `instance` names the panel's worker so the lane opens
   *  its tabs in that profile (lib/control.mjs panelSeen). */
  function deck(instance = null) {
    if (instance) CONTROL.panelSeen(instance);
    return {
      cards: nextCards(cardSnapshot()),
      jobs: J.running().map((j) => ({ label: j.label, note: j.note, startedAt: j.startedAt, done: j.done, total: j.total })),
      // What last finished, and how (0.9.1): the panel's strip says
      // "done" or "failed — why" where silence used to stand.
      recent: J.list().filter((j) => j.status !== "running" && j.finishedAt && Date.now() - Date.parse(j.finishedAt) < 10 * 60_000).slice(0, 3)
        .map((j) => ({ label: j.label, status: j.status, error: j.error, note: j.note, finishedAt: j.finishedAt })),
      project: projectSummary(),
      control: controlSummary(),
      tasks: RT() ? [...RT().running(), ...RT().blocked()].map((t) => ({ id: t.id, title: t.title, status: t.status, tabId: t.lease?.tabId ?? null })) : [],
      // Whether there is a specialist to ask — the panel's suggestions
      // offer questions only when somebody is there to answer them.
      brain: Boolean(RT()),
    };
  }

  /** Does the engine answer this method and path? */
  const routes = (method, path) => Boolean(ROUTES[`${String(method).toUpperCase()} ${path}`]);

  /** Answer one request: { status, body }. `query` is a plain object of the
   *  URL's parameters, `body` the parsed JSON (null on GET). A route that
   *  throws answers 500 with the message — the host logs the stack. */
  async function handle(method, path, query = {}, body = null) {
    const fn = ROUTES[`${String(method).toUpperCase()} ${path}`];
    if (!fn) return { status: 404, body: { error: "not a route of the engine" } };
    try { return await fn(query ?? {}, body); }
    catch (e) { console.error(e); return { status: 500, body: { error: e?.message ?? String(e) } }; }
  }

  /** Stop the clocks — a host that is shutting down, or a test. */
  const stop = () => { clearInterval(sweeper); clearInterval(judgeClock); };

  return {
    DATA, P, PJ, LB, S, J, CONTROL, LANE, RT, WHY, INBOX, loadRuntime, afterSwitch, acct, who, queueRows,
    SPAWNABLE, AGENTIC, startAgentic, autoJudge, SELF, startScout, cardSnapshot, actCard,
    projectSummary, switchProject, controlSummary, panelState, panelAct, runVerb, capture,
    deck, routes, handle, stop,
  };
}
