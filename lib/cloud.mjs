// The cloud — one customer's engine, one wake-up at a time, on Supabase
// (Stage 2 of the Quest plan, 2026-09-19).
//
// On the operator's laptop the engine is a process that never stops: a
// ten-second clock, jobs in memory, a browser on a lane in the same process.
// On Supabase nothing lives longer than an Edge Function call — 150 seconds on
// the Free plan, measured to fit a Quest turn with room to spare (2026-09-19:
// 2–18 s a turn, 0.9 s of CPU) — so the same engine runs as a STEP: wake up
// for one customer, load their files into the memory host (lib/fs-memory.mjs),
// do what is due, write back what changed, sleep. Everything that used to be
// remembered by the process is in their files or in a table:
//
//   quest_files      the engine's directory, one row a file (not the chat)
//   quest_messages   the transcript (chat.jsonl), one row a line — the web
//                    chat reads it, and Realtime tells it when to
//   quest_events     what the customer did: signed up, said something,
//                    pressed a button — each applied once
//   quest_jobs       reads for the operator's browser: a site, a rules page,
//                    a community — done whole there, handed back as data
//
// A read is never made here. The operator's Chrome is the only thing allowed
// to open a page ("real tabs, no background fetches"), so where the engine
// awaited a tab, the cloud asks for a job and comes back when it is done: the
// site read (lib/reads.mjs readSite) becomes the offer card, a rules page
// becomes the room's answer, a listing becomes the posts the judge reads.
// What needs a model — Quest's words, the offer, the verdicts, the replies —
// runs here, one at a time, as long as the call has time left for one.
//
// The steps mirror the engine's own clocks and share their code wherever the
// code was not bound to a process (lib/customer.mjs, lib/quest.mjs, the
// verbs); where it was — the job store, the lane — the rules are the same and
// the state is in the stash.

import { install, host, existsSync, readFileSync, writeFileSync, mkdirSync, join } from "./fs.mjs";
import { memoryHost } from "./fs-memory.mjs";
import { loadPlatforms, preferred, labelsOf } from "./platform.mjs";
import { verbs, probeTarget } from "./verbs.mjs";
import { store } from "./store.mjs";
import { readStash, patchStash } from "./cards.mjs";
import { isCustomer, customerOf, writeCustomer, siteOf, heard, say, chatState, CHAT_FILE } from "./chat.mjs";
import { readCampaign, writeCampaign } from "./campaigns.mjs";
import { campaignOf, secondPass, lookNote, list, isFresh, EVERY_MIN, CAMPAIGN } from "./quest.mjs";
import { roomFile, rulesVerdict, roomRead } from "./rules.mjs";
import { isHeld } from "./control.mjs";
import { heartbeatDue, saidNothing } from "./clock.mjs";
import { hasModel } from "./models.mjs";
import { postOffer, chatAct, applyInstruction, deliverStep, heardFrom } from "./customer.mjs";
import * as AGENTS from "./agents.mjs";

/** Where a customer's directory is on the memory host, per wake-up. */
const ROOT = "/q";
/** Reads a site gets before Quest asks about the address (lib/engine.mjs). */
const OFFER_TRIES = 3;
const OFFER_RETRY_MS = 10 * 60_000;
const RULES_TRIES = 2;
/** How long a failed model call waits before the same step tries again: a
 *  429 on the free plan asked again every wake-up is how a day's budget goes. */
const MODEL_RETRY_MS = 5 * 60_000;
/** A verdict round per wake-up: two of the judge's batches of five. What is
 *  not judged stays pending for the next — the verb clears only what it got. */
const JUDGE_CHUNK = 10;
/** Time a model step needs left before it starts. */
const NEED = { turn: 50_000, offer: 50_000, judge: 45_000, draft: 45_000, heartbeat: 40_000 };
/** When nothing asks for sooner: the next look at this customer. */
const IDLE_MS = 5 * 60_000;

/** One read the operator's browser is asked for, as the job row says it. */
const reading = (j) => j.state === "queued" || j.state === "claimed";
const finished = (j) => j.state === "done" || j.state === "failed";
const failure = (j) => (j.state === "failed" ? j.error ?? "the read failed" : j.result?.ok === false ? j.result.error ?? "the read failed" : null);

/**
 * The cloud, bound to a database (`db`, below: restDb in production, a fake
 * in the tests) and to what the entry point loaded: the built-in skills'
 * manifests and adapters (a function cannot list a folder or import by path),
 * the model key's environment, and Quest itself (`quest`: agent/quest.mjs —
 * questTurn, historyOf, the heartbeat's ask — handed in so this file stays in
 * the zero-dependency heart). `models` overrides lib/agents.mjs, for tests.
 */
export function cloud({ db, skills = [], adapters = {}, env = {}, quest = null, models = AGENTS, log = () => {}, now = () => Date.now() } = {}) {
  // One wake-up at a time per isolate: the filesystem door is one host.
  let chain = Promise.resolve();
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

  async function boot(dir) {
    const H = memoryHost({ env });
    H.load(skills);
    install(H);
    await loadPlatforms(dir, { modules: adapters });
    mkdirSync(dir, { recursive: true });
    return H;
  }

  /* ------------------------------------------------------------ the disk */

  /** Their files and their transcript, into the memory host. Returns what
   *  was loaded, to tell a change from what was already there. */
  async function load(id, dir) {
    const [files, messages] = await Promise.all([db.files(id), db.messages(id)]);
    const was = new Map();
    for (const f of files ?? []) {
      if (!f?.path || f.path === CHAT_FILE) continue;
      host().load([[join(dir, f.path), String(f.content ?? "")]]);
      was.set(f.path, String(f.content ?? ""));
    }
    const rows = (messages ?? []).map((m) => m.body).filter(Boolean).sort((a, b) => a.id - b.id);
    if (rows.length) host().load([[join(dir, CHAT_FILE), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"]]);
    return { files: was, lastMessage: rows.length ? Number(rows[rows.length - 1].id) : 0 };
  }

  /** What changed since `snap`, back to the database: files upserted or
   *  dropped, new transcript lines inserted. Returns the new snapshot. */
  async function flush(id, dir, snap) {
    const prefix = dir + "/";
    const now_ = new Map();
    let chat = "";
    for (const [p, body] of host().snapshot()) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (rel === CHAT_FILE) { chat = body; continue; }
      now_.set(rel, body);
    }
    const changed = [...now_].filter(([p, body]) => snap.files.get(p) !== body).map(([path, content]) => ({ path, content }));
    const gone = [...snap.files.keys()].filter((p) => !now_.has(p));
    const rows = [];
    for (const line of chat.split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (Number(r.id) > snap.lastMessage) rows.push(r); } catch { /* a torn line is not a message */ }
    }
    if (changed.length) await db.saveFiles(id, changed);
    if (gone.length) await db.dropFiles(id, gone);
    if (rows.length) await db.addMessages(id, rows);
    return { files: now_, lastMessage: rows.length ? Math.max(snap.lastMessage, ...rows.map((r) => Number(r.id))) : snap.lastMessage };
  }

  /* ------------------------------------------------------------- a step */

  /**
   * One wake-up for one customer. `budgetMs` is what this call may spend (a
   * little under the function's own limit). Returns what it did; `again`
   * means more is due at once and the caller should wake it again.
   */
  const step = (id, opts = {}) => serial(() => run(id, opts));

  async function run(id, { budgetMs = 110_000 } = {}) {
    const t0 = now();
    const left = () => budgetMs - (now() - t0);
    if (!(await db.take(id, Math.ceil(budgetMs / 1000) + 30))) return { busy: true };
    // A plain string, not the door's join: this runs before the memory host is
    // installed, and whatever host is there (Node's, on Windows, in a test)
    // would spell it its own way. Customer ids are uuids.
    const dir = `${ROOT}/${String(id).replace(/[^\w-]/g, "")}`;
    const did = [];
    let again = false;
    let snap = null;
    let summary = null;
    try {
      await boot(dir);
      const row = await db.customer(id);
      if (!row) return { gone: true };
      snap = await load(id, dir);
      const V = verbs({ root: dir, dir, log, warn: log, browse: () => { throw new Error("no browser here — the cloud asks for reads as jobs"); } });
      // The ledgers and the memory files, every wake-up (idempotent) — and
      // quietly: its greeting is for a person at a terminal.
      await verbs({ root: dir, dir, log: () => {}, warn: log }).init([]);
      if (!isCustomer(dir)) writeCustomer(dir, { email: row.email ?? null, since: row.created_at ?? new Date(now()).toISOString() });
      if (hasModel(dir) === false) log("no model key in this environment — nothing that needs one will run");

      const S = store(dir, (m) => { throw new Error(m); });
      const room = (p) => labelsOf(preferred(readStash(dir).platform)).room(p);
      const P = () => preferred(readStash(dir).platform);
      const laneNow = await db.lane().catch(() => null);
      const lane = { attached: () => Boolean(laneNow?.attached) };
      const jobs = (await db.jobs(id)) ?? [];
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const consumed = new Set();
      const consume = (j) => { if (j) consumed.add(j.id); };
      const inFlight = () => jobs.some((j) => reading(j) && !consumed.has(j.id));
      // What the judge waits for: a read still filling the queue (a search),
      // not a rules page or a site (lib/engine.mjs autoJudge waits on probe
      // and tick, not on the rules).
      const filling = () => jobs.some((j) => j.kind === "listing" && reading(j) && !consumed.has(j.id));
      const ask = async (kind, args, label) => {
        const j = await db.addJob(id, kind, { ...args, label });
        jobs.push(j);
        byId.set(j.id, j);
        did.push(`asked: ${label}`);
        return j;
      };

      /* 1. What they did — each event once, even when a wake-up dies
       *    half-way: the ids already applied ride in the stash, which is
       *    written back with their effects. */
      const events = (await db.events(id)) ?? [];
      const applied = [];
      for (const ev of events) {
        if ((readStash(dir).cloud_seen ?? []).includes(ev.id)) { applied.push(ev.id); continue; }
        try {
          await onEvent(ev, { dir, V, room });
        } catch (e) {
          log(`event ${ev.id} (${ev.kind}): ${e?.message ?? e}`);
        }
        const seen = readStash(dir).cloud_seen ?? [];
        patchStash(dir, { cloud_seen: [...seen.slice(-49), ev.id] });
        applied.push(ev.id);
        did.push(`event: ${ev.kind}`);
      }
      if (applied.length) {
        // Their words and the buttons they pressed are in the chat before any
        // model is asked about them.
        if (readStash(dir).turn_for) await db.status(id, { thinking: true });
        snap = await flush(id, dir, snap);
        await db.doneEvents(applied);
      }

      /* 2. The clock, without a model: reads asked for and reads recorded. */
      const clock = async () => {
        await offerStep({ dir, byId, consume, inFlight, ask });
        await lookStep({ dir, V, S, P, room, byId, consume, inFlight, ask });
        await tickStep({ dir, V, S, jobs, consume, inFlight, ask });
        for (let i = 0; i < 3; i++) {
          const d = deliverStep(dir, { S, room, lastDraft: readStash(dir).cloud_draft_fail ?? null, busy: !hasModel(dir), now: now() });
          if (d.posted) did.push("posted an opportunity");
          if (!d.posted && !d.applied && !d.declined) break;
        }
      };
      await clock();

      /* 3. What needs a model, most urgent first, while there is time — pass
       *    after pass, until a pass does nothing. A step that is backing off
       *    after a failure does nothing, so a failing model cannot spin. */
      const models_ = hasModel(dir) ? [
        ["turn", () => turnStep({ dir, lane, room })],
        ["offer", () => offerModelStep({ dir, byId, consume })],
        ["judge", () => judgeStep({ dir, V, S, filling })],
        ["draft", () => draftStep({ dir, S, room })],
        ["heartbeat", () => heartbeatStep({ dir, lane, row })],
      ] : [];
      for (let pass = 0; pass < 6; pass++) {
        let any = false;
        for (const [name, fn] of models_) {
          // Out of time with this one still wanted: wake again at once.
          if (left() < NEED[name]) { if (wants(name, { dir, S, byId, filling })) again = true; continue; }
          if (await fn()) { any = true; did.push(name); await clock(); }
        }
        if (!any) break;
      }

      // A finished read nothing points at any more (its room was reset, its
      // customer changed the address) is spent: consumed, so it is not
      // fetched with every wake-up for ever.
      const held = new Set([readStash(dir).site_job, ...(readStash(dir).look?.rooms ?? []).flatMap((r) => [r.rulesJob, r.probeJob])].filter(Boolean));
      for (const j of jobs) if (finished(j) && !held.has(j.id) && j.args?.purpose !== "tick") consume(j);

      snap = await flush(id, dir, snap);
      for (const jid of consumed) await db.consumeJob(jid);
      summary = summaryOf(dir, { jobs: jobs.filter((j) => !consumed.has(j.id)) });

      // Something arrived while this wake-up worked — a message, a read
      // handed back. The poke that brought it found the lease taken, so this
      // wake-up is the one that has to say so: again, at once.
      const [lateEvents, lateJobs] = await Promise.all([db.events(id).catch(() => []), db.jobs(id).catch(() => [])]);
      if ((lateEvents ?? []).some((e) => !applied.includes(e.id))) again = true;
      if ((lateJobs ?? []).some((j) => finished(j) && !consumed.has(j.id) && !(byId.get(j.id) && finished(byId.get(j.id))))) again = true;
    } catch (e) {
      log(`quest step ${id}: ${e?.stack ?? e}`);
      did.push(`error: ${String(e?.message ?? e).slice(0, 200)}`);
    } finally {
      const next = again ? new Date(now()).toISOString() : new Date(now() + IDLE_MS).toISOString();
      await db.release(id, { nextAt: next, state: summary }).catch((e) => log(`release ${id}: ${e?.message ?? e}`));
    }
    if (again) await db.poke(id).catch(() => {});
    return { did, again };
  }

  /* ------------------------------------------------------------- events */

  async function onEvent(ev, { dir, V, room }) {
    const b = ev.body ?? {};
    if (ev.kind === "start") return started(dir, b);
    if (ev.kind === "say") {
      const text = String(b.text ?? "").trim().slice(0, 4000);
      if (!text) return;
      const row = heardFrom(dir, text);
      // Somebody is here: the heartbeat's back-off starts over (as the
      // operator's own message does in agent/strategist.mjs).
      patchStash(dir, { operator_at: new Date(now()).toISOString(), heartbeat_quiet: null, turn_for: { row: row.id, text, at: new Date(now()).toISOString(), tries: 0 } });
      return;
    }
    if (ev.kind === "act") {
      const out = await chatAct(dir, { id: b.id, action: b.action, note: b.note, style: b.style }, { room, mark: (args) => V.mark(args) });
      if (out?.error) log(`act ${b.action} on #${b.id}: ${out.error}`);
      return;
    }
    log(`an event of a kind nobody reads: ${ev.kind}`);
  }

  /** Sign-up (lib/engine.mjs signup, minus the stub): what they typed in the
   *  big box becomes the first message, so nothing is asked for twice. */
  function started(dir, b) {
    const said = String(b.text ?? "").trim().slice(0, 4000);
    const url = siteOf(said);
    let cv = null;
    if (b.file && /^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(String(b.file.data ?? "")) && String(b.file.data).length <= 1_900_000) {
      cv = { name: String(b.file.name ?? "cv.pdf").replace(/[^\w .()-]/g, "").trim().slice(0, 80) || "cv.pdf", data: String(b.file.data) };
    }
    const about = !url && said.length >= 20 ? said : null;
    if (cv) writeFileSync(join(dir, "cv.json"), JSON.stringify(cv));
    writeCustomer(dir, {
      ...(b.email ? { email: String(b.email).toLowerCase().slice(0, 200) } : {}),
      ...(url ? { url } : {}), ...(cv ? { cv: { name: cv.name, at: new Date(now()).toISOString() } } : {}), ...(about ? { about } : {}),
    });
    const first = [said, cv ? `My CV: ${cv.name}` : ""].filter(Boolean).join("\n\n");
    if (!first) return;
    const row = heard(dir, first);
    patchStash(dir, { turn_for: { row: row.id, text: first, at: new Date(now()).toISOString(), tries: 0 } });
  }

  /* ---------------------------------------------------- the clock's steps */

  /** The site read (lib/engine.mjs autoOffer): asked for as a job, held
   *  while nobody reads, three tries before Quest asks about the address. */
  async function offerStep({ dir, byId, consume, inFlight, ask }) {
    const st = readStash(dir);
    if (st.offer || st.scout_empty) return;
    const c = customerOf(dir) ?? {};
    const url = c.url;
    const material = !url && (c.cv || c.about) ? (c.cv ? "cv" : "about") : null;
    const job = st.site_job ? byId.get(st.site_job) : null;
    if (job && reading(job)) return;
    if (job && finished(job) && !failure(job)) return;       // the model's turn (offerModelStep)
    let tries = Number(st.scout_tries) || 0;
    if (job && failure(job)) {
      // A read that stopped on what only the operator can lift — a
      // permission wall, a Chrome window nobody draws — was not a failed read
      // of the address (lib/engine.mjs, measured 2026-09-19).
      const wall = isHeld(failure(job));
      if (wall) tries = Math.max(0, tries - 1);
      patchStash(dir, { site_job: null, scout_at: null, scout_tries: tries, scout_failed_at: wall ? null : job.done_at ?? new Date(now()).toISOString(), scout_error: failure(job) });
      consume(job);
    }
    if (st.site_job && !job) patchStash(dir, { site_job: null, scout_at: null });
    const s = readStash(dir);
    if ((url || material) && tries >= OFFER_TRIES) {
      if (!s.scout_gaveup) {
        patchStash(dir, { scout_gaveup: true });
        say(dir, url
          ? `I couldn't open ${new URL(url).host.replace(/^www\./, "")} — is that the right address? Paste the right one here, or tell me in a sentence what you sell and who buys it.`
          : `I couldn't make sense of ${material === "cv" ? "your CV" : "that"} — tell me in a sentence or two what you sell and who buys it.`);
      }
      return;
    }
    if (!url || material) return;                             // no site: the model reads what they gave
    const failedAt = Date.parse(s.scout_failed_at ?? "");
    const nudged = s.scout_nudge && Number.isFinite(failedAt) && Date.parse(s.scout_nudge) > failedAt;
    if (Number.isFinite(failedAt) && !nudged && now() - failedAt < OFFER_RETRY_MS) return;
    if (inFlight()) return;
    const j = await ask("site", { purpose: "site", url }, "Reading your site");
    patchStash(dir, { site_job: j.id, scout_tries: tries + 1, scout_at: new Date(now()).toISOString() });
  }

  /** The offer from a site that was read, or from what they gave instead. */
  async function offerModelStep({ dir, byId, consume }) {
    const st = readStash(dir);
    if (st.offer || st.scout_empty || modelWait(st.cloud_offer_fail)) return false;
    const c = customerOf(dir) ?? {};
    const job = st.site_job ? byId.get(st.site_job) : null;
    const material = !c.url && (c.cv || c.about) && (Number(st.scout_tries) || 0) < OFFER_TRIES;
    if (!(job && finished(job) && !failure(job)) && !material) return false;
    try {
      let proposal;
      if (job && finished(job)) {
        proposal = await models.offerFromPages(dir, c.url ?? job.args?.url, job.result?.pages ?? [], { log });
      } else {
        patchStash(dir, { scout_tries: (Number(st.scout_tries) || 0) + 1, scout_at: new Date(now()).toISOString() });
        const file = c.cv && existsSync(join(dir, "cv.json")) ? JSON.parse(readFileSync(join(dir, "cv.json"), "utf8")) : null;
        proposal = await models.offerFromMaterial(dir, { text: c.about ?? "", file }, { log });
      }
      if (proposal && (proposal.one_line || proposal.rule_md)) postOffer(dir, proposal, { room: roomOf(dir) });
      patchStash(dir, { site_job: null, cloud_offer_fail: null });
      consume(job);
    } catch (e) {
      log(`the offer could not be written: ${e?.message ?? e}`);
      patchStash(dir, { cloud_offer_fail: { error: String(e?.message ?? e).slice(0, 300), at: new Date(now()).toISOString() } });
    }
    return true;
  }

  /** The first look (lib/engine.mjs autoLook): each confirmed community's
   *  rules read once, then one search of it; watched when it clears the
   *  floor. One page-turning step at a time — it is one browser. */
  async function lookStep({ dir, V, S, P, room, byId, consume, inFlight, ask }) {
    const st = readStash(dir);
    if (st.offer?.state !== "confirmed" || !st.look?.rooms?.length) return;
    if (!readCampaign(dir, CAMPAIGN)) writeCampaign(dir, campaignOf(st.offer));
    const rooms = st.look.rooms.map((r) => ({ ...r }));
    const phrases = st.look.phrases ?? [];
    let used = Number(st.look.used) || 0;
    let changed = false;
    const set = (r, patch) => { Object.assign(r, patch); changed = true; };
    const L = labelsOf(P());

    for (const r of rooms) {
      if (r.rules === "reading") {
        const j = r.rulesJob ? byId.get(r.rulesJob) : null;
        if (!j) set(r, { rules: "todo", rulesJob: null });
        else if (finished(j) && !failure(j)) {
          const v = rulesVerdict(j.result?.text ?? "");
          const base = existsSync(S.roomPath(r.place)) ? readFileSync(S.roomPath(r.place), "utf8") : roomFile(r.place, null, { label: L.room(r.place), rulesUrl: L.rulesUrl(r.place) });
          S.writeRoom(r.place, roomRead(base, v, new Date(now()).toISOString().slice(0, 10)));
          const banned = v.state === "banned";
          set(r, { rules: banned ? "banned" : "allowed", rulesJob: null, ...(!banned && !r.q && phrases.length ? { q: phrases[used++ % phrases.length] } : {}) });
          consume(j);
        } else if (finished(j)) {
          set(r, (r.tries ?? 0) + 1 >= RULES_TRIES ? { rules: "failed", rulesJob: null } : { rules: "todo", rulesJob: null, tries: (r.tries ?? 0) + 1 });
          consume(j);
        }
      }
      if (r.probe === "running") {
        const j = r.probeJob ? byId.get(r.probeJob) : null;
        if (!j) set(r, { probe: "todo", probeJob: null });
        else if (j.state === "done") {
          await V.probed([], JSON.stringify({ place: r.place, q: r.q ?? null, campaign: CAMPAIGN, url: j.args?.url, read: j.result ?? { ok: false, error: "nothing came back" } }));
          set(r, { probe: "done", probeJob: null });
          consume(j);
        } else if (j.state === "failed") { set(r, { probe: "failed", probeJob: null }); consume(j); }
      }
      // Watched once what it found is judged: the verb applies the floor and
      // refuses in words; the source list says which way it went.
      if (r.probe === "done" && r.watch === "todo") {
        const tag = `${r.place}:${r.q ?? "new"}`;
        if (!S.pending().some((x) => x.probe === tag)) {
          try { await V.watch([r.place, ...(r.q ? ["--q", r.q] : []), "--campaign", CAMPAIGN, "--every", String(EVERY_MIN)]); } catch (e) { log(`watch ${tag}: ${e?.message ?? e}`); }
          set(r, { watch: S.sources().some((s) => s.id === tag.toLowerCase()) ? "watched" : "refused" });
        }
      }
    }

    // The next page-turning step, if the browser is free.
    const next = rooms.find((r) => r.rules === "todo" || (r.rules === "allowed" && r.probe === "todo"));
    if (next && !inFlight()) {
      if (next.rules === "todo") {
        const j = await ask("text", { purpose: "rules", place: next.place, url: L.rulesUrl(next.place) }, `Reading ${L.room(next.place)}'s rules`);
        set(next, { rules: "reading", rulesJob: j.id });
      } else {
        const t = probeTarget({ p: P(), roomState: S.roomState, place: next.place, q: next.q ?? null });
        if (t.refused) { log(`probe ${next.place}: refused — ${t.refused}`); set(next, { probe: "done" }); }
        else {
          const skip = [...S.found().values()].filter((f) => f.place === next.place).map((f) => f.id);
          const j = await ask("listing", { purpose: "probe", place: next.place, q: next.q ?? null, url: t.url, skip }, `Looking in ${L.room(next.place)}`);
          set(next, { probe: "running", probeJob: j.id });
        }
      }
    }

    // Every room settled and nothing left to judge: say once how the first
    // look went when it found nobody — a silence here would read as broken.
    const settled = rooms.every((r) => ["banned", "failed"].includes(r.rules) || r.probe === "failed" || ["watched", "refused"].includes(r.watch));
    if (settled && !st.look.said && !S.pending().length) {
      const verdicts = S.verdicts();
      const mine = [...S.found().values()].filter((f) => rooms.some((r) => f.probe === `${r.place}:${r.q ?? "new"}`) && isFresh(f, now()));
      const nobody = !mine.some((f) => verdicts.get(f.id)?.fit);
      const again = nobody && !st.look.retried ? secondPass(rooms, phrases, used, st.offer.places ?? []) : { rooms: [], used };
      if (again.rooms.length) {
        rooms.push(...again.rooms);
        used = again.used;
        st.look.retried = true;
        changed = true;
      } else {
        const watched = [...new Set(rooms.filter((r) => r.watch === "watched").map((r) => room(r.place)))];
        const note = lookNote(rooms, room);
        const readIn = [...new Set(rooms.filter((r) => r.probe === "done").map((r) => room(r.place)))];
        if (nobody) {
          const did = mine.length > 0 ? `I read ${mine.length} post${mine.length === 1 ? "" : "s"} from the last week${readIn.length ? ` in ${list(readIn)}` : ""}` : `Nothing from the last week turned up${readIn.length ? ` in ${list(readIn)}` : ""}`;
          say(dir, [
            watched.length
              ? `${did}, and nobody is asking for this yet. I'm watching ${list(watched)} and will come back here the moment someone does.`
              : `${did}, and none of it is worth watching for this.`,
            note,
            watched.length ? "" : "Where else do your buyers talk about the problem? Name a community, or tell me more about who buys.",
          ].filter(Boolean).join(" "));
        } else if (note) say(dir, note);
        st.look.said = true;
        changed = true;
      }
    }
    if (changed) patchStash(dir, { look: { ...st.look, rooms, used } });
  }

  /** The watch (lib/verbs.mjs tick): a source past its cadence is read again,
   *  one at a time; what came back is recorded by the verb's own half. */
  async function tickStep({ dir, V, S, jobs, consume, inFlight, ask }) {
    for (const j of jobs) {
      if (j.args?.purpose !== "tick" || !finished(j)) continue;
      await V.ticked([], JSON.stringify({ source: j.args.source, read: j.state === "done" ? j.result : { ok: false, error: j.error ?? "the read failed" } }));
      consume(j);
    }
    if (readStash(dir).auto_tick === false || inFlight()) return;
    const due = S.due(now());
    if (!due.length) return;
    const s = due[0];
    const skip = [...S.found().values()].filter((f) => f.place === s.place).map((f) => f.id);
    await ask("listing", { purpose: "tick", source: s.id, place: s.place, url: s.url, skip, skipAuthors: [...S.contacted()] }, `Looking in ${roomOf(dir)(s.place)} again`);
  }

  /* ------------------------------------------------------ with a model */

  /** Quest answers what they said (lib/engine.mjs quest): an instruction is
   *  applied first, then the turn — on the transcript's memory. */
  async function turnStep({ dir, lane, room }) {
    const t = readStash(dir).turn_for;
    if (!t || !quest?.turn) return false;
    if ((t.tries ?? 0) >= 3) { patchStash(dir, { turn_for: null }); say(dir, { text: "Something went wrong on my side. Say it again in a minute.", error: true }); return true; }
    patchStash(dir, { turn_for: { ...t, tries: (t.tries ?? 0) + 1 } });
    try {
      const applied = await applyInstruction(dir, t.text, { interpret: models.interpretInstruction, room, log });
      if (applied?.said) say(dir, applied.said);
      if (!applied?.done) {
        const signal = AbortSignal.timeout(Math.max(20_000, NEED.turn + 20_000));
        const reply = await quest.turn(dir, t.text, { history: quest.history ? quest.history(dir, { before: t.row }) : [], note: applied?.note ?? "", lane, signal });
        if (reply && !saidNothing(reply)) say(dir, reply);
      }
      patchStash(dir, { turn_for: null });
    } catch (e) {
      log(`Quest could not answer: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    return true;
  }

  /** A round of verdicts (lib/engine.mjs autoJudge) — never while a read is
   *  still filling the queue, and never within five minutes of a failure. */
  async function judgeStep({ dir, V, S, filling }) {
    const st = readStash(dir);
    if (filling() || modelWait(st.cloud_judge_fail)) return false;
    const pend = S.pending();
    if (!pend.length) return false;
    const all = S.found();
    const items = pend.slice(0, JUDGE_CHUNK).map((x) => {
      const it = all.get(x.id) ?? {};
      return { n: x.n, place: it.place, author: it.author, title: it.title, body: it.body, crowd: it.comments ?? null, posted_at: it.posted_at ?? null };
    });
    try {
      const rule = readFileSync(join(dir, "rule.md"), "utf8");
      const verdicts = await models.judgeItems(dir, items, rule, { log });
      if (!verdicts.length) throw new Error(`no verdicts came back — ${verdicts.failed?.[0] ?? "nothing written"}`);
      await V.judge([], JSON.stringify(verdicts));
      patchStash(dir, { cloud_judge_fail: null });
    } catch (e) {
      log(`the judge failed: ${e?.message ?? e}`);
      patchStash(dir, { cloud_judge_fail: { error: String(e?.message ?? e).slice(0, 300), at: new Date(now()).toISOString() } });
    }
    return true;
  }

  /** The three replies for the card waiting on them (lib/engine.mjs
   *  startAgentic "draft"): the verb builds the prompt, the writer answers,
   *  the verb saves the round and runs the refusals over it. */
  async function draftStep({ dir, S, room }) {
    const d = deliverStep(dir, { S, room, lastDraft: readStash(dir).cloud_draft_fail ?? null, now: now() });
    if (!d.draft) return false;
    const [item, ...rest] = d.draft.args;
    try {
      const lines = [];
      const Vp = verbs({ root: dir, dir, log: (l) => lines.push(String(l ?? "")), warn: log });
      await Vp.draft([item, ...rest]);
      const prompt = lines.join("\n") + "\n";
      const { drafts, no_fit } = await models.draftReply(dir, prompt, { log });
      if (!drafts.length) {
        patchStash(dir, { cloud_draft_fail: { id: item, error: no_fit ? `the writer declined: ${no_fit}` : "nothing came back from the writer", at: now() } });
        return true;
      }
      const note = rest.includes("--note") ? String(rest[rest.indexOf("--note") + 1] ?? "") : "";
      const style = rest.includes("--style") ? String(rest[rest.indexOf("--style") + 1] ?? "") : "";
      await verbs({ root: dir, dir, log, warn: log }).draft([item, "--save"], JSON.stringify({ drafts, ...(note ? { note, style } : {}) }));
      patchStash(dir, { cloud_draft_fail: null });
    } catch (e) {
      log(`the writer failed: ${e?.message ?? e}`);
      patchStash(dir, { cloud_draft_fail: { id: item, error: String(e?.message ?? e).slice(0, 300), at: now() } });
    }
    return true;
  }

  /** Quest wakes by itself (agent/strategist.mjs startInboxLoop, the
   *  customer's half): speaks only through notify, and every silent wake
   *  pushes the next one further out. */
  async function heartbeatStep({ dir, lane, row }) {
    if (!quest?.turn || !quest.heartbeatAsk) return false;
    const s = readStash(dir);
    const quiet = Number(s.heartbeat_quiet) || 0;
    const last = [s.heartbeat_at, s.operator_at].map((x) => Date.parse(x ?? "")).filter(Number.isFinite);
    const from = new Date(last.length ? Math.max(...last) : Date.parse(row.created_at ?? new Date(now()).toISOString())).toISOString();
    if (!heartbeatDue(from, quiet)) return false;
    const before = s.cmo_note?.at ?? null;
    patchStash(dir, { heartbeat_at: new Date(now()).toISOString() });
    try {
      const signal = AbortSignal.timeout(NEED.heartbeat + 20_000);
      const reply = await quest.turn(dir, quest.heartbeatAsk, { wokeBy: "your heartbeat — nobody asked for it", history: quest.history ? quest.history(dir) : [], lane, signal });
      const silent = saidNothing(reply) && (readStash(dir).cmo_note?.at ?? null) === before;
      patchStash(dir, { heartbeat_quiet: silent ? quiet + 1 : null });
    } catch (e) {
      log(`heartbeat failed: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    return true;
  }

  /** Is a model step still wanted — asked without doing anything, to decide
   *  whether to wake again at once when the time ran out. A step waiting out
   *  a failure is not wanted: that wait is what IDLE_MS is for. */
  function wants(name, { dir, S, byId, filling }) {
    const st = readStash(dir);
    if (name === "turn") return Boolean(st.turn_for) && Boolean(quest?.turn);
    if (name === "offer") {
      const j = st.site_job ? byId.get(st.site_job) : null;
      return !st.offer && !modelWait(st.cloud_offer_fail) && Boolean(j && finished(j) && !failure(j));
    }
    if (name === "judge") return S.pending().length > 0 && !filling() && !modelWait(st.cloud_judge_fail);
    if (name === "draft") {
      if (st.offer?.state !== "confirmed") return false;
      const want = chatState(dir, { limit: Infinity }).messages.find((m) => m.card?.kind === "opportunity" && !m.card.draft && !m.card.no_draft && m.card.state !== "dismissed");
      const fail = st.cloud_draft_fail;
      return Boolean(want) && !(fail && fail.id === want.card.item && now() - fail.at < 10 * 60_000);
    }
    return false;
  }

  const modelWait = (fail) => Boolean(fail) && now() - (typeof fail.at === "number" ? fail.at : Date.parse(fail.at)) < MODEL_RETRY_MS;
  const roomOf = (dir) => (p) => labelsOf(preferred(readStash(dir).platform)).room(p);

  /** What the web and the operator's panel show without reading the files:
   *  whether Quest is thinking, what is being read for them, where things
   *  stand. Written on the customer's row at the end of every wake-up. */
  function summaryOf(dir, { jobs }) {
    const st = readStash(dir);
    const cards = chatState(dir, { limit: Infinity }).messages.filter((m) => m.card?.kind === "opportunity");
    return {
      site: customerOf(dir)?.url ?? null,
      thinking: Boolean(st.turn_for),
      working: jobs.filter(reading).map((j) => ({ label: j.args?.label ?? j.kind, state: j.state, note: j.note ?? null })),
      offer: st.offer?.state ?? (st.scout_empty ? "empty" : st.scout_gaveup ? "gave up" : st.site_job ? "reading" : null),
      opportunities: cards.length,
      rooms: (st.look?.rooms ?? []).map((r) => ({ place: r.place, rules: r.rules, probe: r.probe, watch: r.watch })),
      at: new Date(now()).toISOString(),
    };
  }

  return { step, load, flush };
}

/* --------------------------------------------------------- the database */

/**
 * The cloud's database, over Supabase's REST (PostgREST) with the project's
 * secret key — which goes in the `apikey` header only: the new keys are not
 * JWTs, and a Bearer that is not a JWT is refused. Zero-dependency: fetch.
 * The SQL side (tables, the lease, the job queue) is the site repository's
 * supabase/migrations/*_quest_cloud.sql.
 */
export function restDb({ url, key, fetch: f = globalThis.fetch }) {
  const base = String(url).replace(/\/+$/, "");
  const H = { apikey: key, "content-type": "application/json" };
  const call = async (path, init = {}) => {
    const res = await f(`${base}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const rpc = (fn, args = {}) => call(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  const eq = (v) => `eq.${encodeURIComponent(v)}`;
  const minimal = { Prefer: "return=minimal" };
  const quoted = (xs) => xs.map((x) => `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",");
  return {
    take: (id, seconds) => rpc("quest_take", { p_customer: id, p_seconds: seconds }),
    release: (id, { nextAt = null, state = null } = {}) => rpc("quest_release", { p_customer: id, p_next: nextAt, p_state: state }),
    status: (id, patch) => rpc("quest_status", { p_customer: id, p_patch: patch }),
    customer: async (id) => (await call(`quest_customers?id=${eq(id)}&select=id,user_id,email,created_at`))?.[0] ?? null,
    files: (id) => call(`quest_files?customer_id=${eq(id)}&select=path,content`),
    messages: (id) => call(`quest_messages?customer_id=${eq(id)}&select=id,body&order=id.asc`),
    saveFiles: (id, rows) => call("quest_files?on_conflict=customer_id,path", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.map((r) => ({ customer_id: id, path: r.path, content: r.content, updated_at: new Date().toISOString() }))) }),
    dropFiles: (id, paths) => call(`quest_files?customer_id=${eq(id)}&path=in.(${encodeURIComponent(quoted(paths))})`, { method: "DELETE", headers: minimal }),
    addMessages: (id, rows) => call("quest_messages?on_conflict=customer_id,id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(rows.map((r) => ({ customer_id: id, id: Number(r.id), at: r.at, sender: r.from, body: r }))) }),
    events: (id) => call(`quest_events?customer_id=${eq(id)}&done_at=is.null&select=id,kind,body,created_at&order=id.asc&limit=20`),
    doneEvents: (ids) => call(`quest_events?id=in.(${ids.map(Number).join(",")})`, { method: "PATCH", headers: minimal, body: JSON.stringify({ done_at: new Date().toISOString() }) }),
    jobs: (id) => call(`quest_jobs?customer_id=${eq(id)}&consumed_at=is.null&select=id,kind,args,state,result,error,note,created_at,claimed_at,done_at&order=id.asc`),
    addJob: async (id, kind, args) => (await call("quest_jobs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ customer_id: id, kind, args }) }))[0],
    consumeJob: (jobId) => call(`quest_jobs?id=eq.${Number(jobId)}`, { method: "PATCH", headers: minimal, body: JSON.stringify({ consumed_at: new Date().toISOString() }) }),
    lane: () => rpc("quest_lane"),
    poke: (id) => rpc("quest_poke", { p_customer: id }),
  };
}
