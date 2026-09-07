#!/usr/bin/env node
// The dashboard — every verb this product has, reachable from a browser.
//
// It used to be a reader: seven views over .mq/ plus two writes. The CLI
// did the work and the browser watched. That is a defensible shape for a tool
// and a bad one for a product, because the first thing it asks a new person to
// do is leave it and go and type something.
//
// So the rule now is the one the operator set: EVERYTHING IS AVAILABLE FROM THE
// UI. Onboarding, prospects, the memory files, the models, and every verb that
// reads Reddit. The CLI is still there and still the one implementation — the
// buttons spawn it (see lib/jobs.mjs) rather than reimplementing it.
//
// What has NOT changed, and is not going to:
//   * bound to 127.0.0.1, never 0.0.0.0
//   * no account, no hosted anything, no bill
//   * no verb that posts to Reddit
//   * everything a stranger wrote is escaped at one seam
//
//   node bin/serve.mjs [--port 8787]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { store, dataDir } from "../lib/store.mjs";
import { history, STATES } from "../lib/verdict.mjs";
import { standing, readiness, burst, mix, PER_ROOM_24H, OVERALL_24H, CQS_NOTE } from "../lib/ready.mjs";
import { roomFile } from "../lib/rules.mjs";
import { mergeVoice, voiceRules, voiceSummary, applyVoiceAnswers, VOICE_UNSURE } from "../lib/voice.mjs";
import { nextCards, readStash, patchStash, proposable, onboarded, draftTabs } from "../lib/cards.mjs";
import { styleOf } from "../lib/writing.mjs";
import { controlBroker } from "../lib/control.mjs";
import { jobStore } from "../lib/jobs.mjs";
import { MEMORY, readMemory, readOne, writeMemory, seedMissing, memoryProgress } from "../lib/memory.mjs";
import { PLANS, ROLES, LOCAL_URL, KEY_URL, plan, setPlan, chosen, choose, localConfig, setLocal, probeLocal, modelInfo, alternatesFor,
  readKey, writeKey, hasKey, hasModel, keySource, judgeEstimate, money } from "../lib/models.mjs";
import { page, esc, empty, runBtn, tag, steps, setupBanner, APP_JS, CSP } from "../lib/ui.mjs";
import { tokens, issueToken, revokeToken } from "../lib/feed.mjs";
import { loadPlatforms, first, platformFor, labelsOf, composerOf } from "../lib/platform.mjs";
import { skillState, readChoices, writeChoice } from "../lib/skills.mjs";
import { browser } from "../lib/browse.mjs";
import { readCampaigns, readCampaign, writeCampaign, setCampaignStatus, campaignDraft, MENTIONS } from "../lib/campaigns.mjs";
import { listProjects, currentProject, currentDir, createProject, useProject } from "../lib/projects.mjs";
import { conversationRows, openConversation, recordTurn, closeConversation, waiting as waitingRows, yourTurns, dueConversations, unbound, campaignDigest, digestText } from "../lib/conversations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ES = join(ROOT, "bin", "mq.mjs");
/** The root data directory: the default project, the project registry, and
 *  the machine's own files (lib/dirs.mjs). */
const DATA = dataDir();
// Platform skills — the store resolves rooms through the registry; the local
// ring is the machine's, so it loads from the root.
await loadPlatforms(DATA);
/** The PROJECT every request acts on (lib/projects.mjs): the registry's
 *  pointer, read per call, so the panel, the CLI and this dashboard move
 *  together when it is switched. Everything below that reads or writes a
 *  project file goes through it. */
const P = () => currentDir(DATA);
const PJ = () => currentProject(DATA);
/** What the platform's people write — "r/saas" — and the other words a
 *  screen needs when it means the platform; the adapter's, with plain
 *  fallbacks (lib/platform.mjs labelsOf). */
const LB = () => labelsOf(first());

/* The page door. Skills whose registry entry is ACTIVE and whose folder holds
 * a page.mjs get a dashboard screen: default export { path, title, render },
 * render(ctx) returning the page body as HTML. Mounted after the core views
 * exist and refused — with the reason printed — when a path is taken or
 * misshapen, so a skill can never shadow a core screen by luck. The body is
 * trusted the way an adapter is trusted: installing a skill is installing
 * code, and the place to be suspicious is before it lands in the ring, not
 * after. */
const SKILL_PAGES = new Map(); // path → { skill, path, title, nav, render }
const skillNav = () => [...SKILL_PAGES.values()].filter((p) => p.nav).map((p) => [p.path, p.title]);

async function mountSkillPages() {
  SKILL_PAGES.clear();
  for (const s of skillState().active.filter((x) => x.seats.page)) {
    const refuse = (why) => console.error(`skill ${s.id}: page.mjs ${why} — not mounted`);
    try {
      const p = (await import(pathToFileURL(s.seats.page).href)).default;
      if (!p?.path || !p.title || typeof p.render !== "function") { refuse("must default-export { path, title, render }"); continue; }
      if (!/^\/[a-z0-9][a-z0-9-]*$/.test(p.path)) { refuse(`path ${p.path} — one lowercase segment`); continue; }
      if (views[p.path] || writes[p.path] || SKILL_PAGES.has(p.path) || /^\/(api|panel|skills)\b/.test(p.path) || p.path === "/app.js") { refuse(`path ${p.path} is taken`); continue; }
      SKILL_PAGES.set(p.path, { skill: s.id, path: p.path, title: String(p.title), nav: p.nav !== false, render: p.render });
    } catch (e) { refuse(`— ${e.message}`); }
  }
}
const argv = process.argv.slice(2);
const PORT = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : 8787;
if (!existsSync(DATA)) { console.error(`Messaging Quest: no ${DATA}/ here — run \`mq init\` first`); process.exit(1); }
/** One store and one job store PER PROJECT, behind a proxy so every view
 *  reads `S.found()` as it always did and gets the current project's. A
 *  store is closures over a directory; one per directory is free to keep. */
const perDir = (make) => {
  const m = new Map();
  return new Proxy({}, { get: (_, k) => { const d = P(); if (!m.has(d)) m.set(d, make(d)); const o = m.get(d); const v = o[k]; return typeof v === "function" ? v.bind(o) : v; } });
};
const S = perDir((d) => store(d, (m) => { throw new Error(m); }));
const J = perDir((d) => jobStore(d));

/** The control lane's broker (lib/control.mjs holds the law): tabs a task
 *  leased in the operator's own Chrome, the toolkit screened by grant,
 *  navigations paced per site. Idle leases are swept so a crashed task never
 *  keeps a tab. Its events go to the inbox once the runtime is up. */
/** The control lane is the MACHINE's — one extension, one broker — and its
 *  events go to the inbox of the project whose lease raised them. */
const CONTROL = controlBroker({ onEvent: (e) => INBOX(e, e.project ?? P()) });
setInterval(() => CONTROL.sweep(), 60_000).unref();

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

/* ------------------------------------------------------------------ helpers */

const acct = () => S.account();
const who = () => (acct()?.name ? acct().name : "no account yet");

/** Every view goes through here so the setup banner and the account line are
 *  not something a new screen can forget to render. */
/** Which of the four questions an older page answers under. */
const HUB = {
  "/standing": "/you", "/ready": "/you", "/voice": "/you", "/memory": "/you", "/projects": "/you", "/settings": "/you",
  "/skills": "/you", "/tasks": "/you", "/jobs": "/you", "/setup": "/you",
  "/queue": "/people", "/waiting": "/people",
  "/sources": "/campaigns", "/rooms": "/campaigns",
};
const render = (path, title, body, opts = {}) =>
  page({ path: HUB[path] ?? path, title, body, who: `${who()} · project: ${PJ().name}`, banner: setupBanner(memoryProgress(P())), extra: skillNav(), ...opts });

const fmt = (s) => esc(String(s ?? "").slice(0, 16).replace("T", " "));
const ago = (iso) => {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const h = (Date.now() - d) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/**
 * Shown once on the next render, then gone.
 *
 * A freshly issued feed token has to reach the screen exactly once, and must
 * not travel in a URL — a secret in a query string ends up in the browser's
 * history, and this codebase's own rule about that is the reason there is a
 * variable here rather than a redirect carrying it. It is not stored anywhere
 * in the clear either: `lib/feed.mjs` keeps only a SHA-256.
 */
let flash = {};
const takeFlash = () => { const f = flash; flash = {}; return f; };

const PER_PAGE = 25;
const pageWindow = (param, total, per = PER_PAGE) => {
  const pages = Math.max(1, Math.ceil(total / per));
  const at = Math.min(Math.max(1, Number(param) || 1), pages);
  return { at, pages, from: (at - 1) * per, to: Math.min(total, at * per) };
};
const pager = (base, at, pages) =>
  pages <= 1 ? "" : `<div class="actions" style="justify-content:space-between">
    ${at > 1 ? `<a class="btn small" href="${base}page=${at - 1}">← previous</a>` : "<span></span>"}
    <span class="muted">page ${at} of ${pages}</span>
    ${at < pages ? `<a class="btn small" href="${base}page=${at + 1}">next →</a>` : "<span></span>"}
  </div>`;

/**
 * Run the CLI and await it, inside a job that is already running.
 *
 * This is how the model-driven verbs reuse the CLI rather than reimplementing
 * it: the writer produces text, and then `mq draft <id> --save` runs the two
 * refusals over it, exactly as it would for a human's own words. One
 * implementation of the guards, not two.
 */
const runEs = (verb, args = [], { stdin = null, ctl } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ES, verb, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, MQ_DIR: P() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
    const take = (c) => { out += c; ctl?.log?.(String(c).replace(/\n$/, "")); };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${verb} exited ${code}`))));
  });

/** The same, but the output is the answer and is not echoed into the log —
 *  `mq draft <id>` prints a whole prompt and the job log is not where it goes. */
const capture = (verb, args = []) => runEs(verb, args, { ctl: null });

/* ------------------------------------------------------------------- views */

const views = {};

/* --- Standing ------------------------------------------------------------ */

/** The one finding an empty store can hide. A profile that 404s to a stranger
 *  stores nothing — so "nothing stored" and "your account is invisible" look
 *  identical from items.jsonl, and only the read ledger tells them apart. */
const profile404 = () => {
  const a = acct();
  const r = a?.name && typeof first()?.userPage === "function" ? S.lastReadOf(first().userPage(a.name)) : null;
  return r && !r.ok && r.err === "http_404" ? { name: a.name, at: r.at } : null;
};
const gone = ({ name, at }) => `
<h1>Logged out, your profile does not render.</h1>
<p class="sub">${esc(name)}'s profile answered <b>404</b> to a stranger (read ${esc(fmt(at))}, in an Incognito tab of your browser).
Nothing of yours is stored because there was nothing to read.</p>
<div class="note"><b>That is the site-wide signal.</b> A suspended or shadowbanned account 404s to strangers
while looking normal to you. Check it in a private window to confirm with your own eyes, then appeal${LB().appeals ? ` at <a href="${esc(LB().appeals)}" rel="noreferrer">${esc(LB().appeals.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : " where the platform takes appeals"}.</div>
<div class="actions">${runBtn("sync", "Read it again", { primary: true })}</div>`;

views["/standing"] = () => {
  const items = S.items(), checks = S.checksById();
  if (!items.size) {
    const g = profile404();
    if (g) return render("/standing", "Standing", gone(g));
    return render("/standing", "Standing", empty(
      "Nothing stored yet — Messaging Quest has not read your profile.",
      acct()?.name
        ? runBtn("sync", "Read my profile", { primary: true })
        : `<a class="btn primary" href="/setup">Set up Messaging Quest</a>`,
    ));
  }

  const tally = new Map();
  let unchecked = 0;
  for (const it of items.values()) {
    const h = history(checks.get(it.id) ?? []);
    if (h.state === "unchecked") { unchecked++; continue; }
    tally.set(h.state, (tally.get(h.state) ?? 0) + 1);
  }
  const seen = tally.get("visible") ?? 0;
  const hidden = (tally.get("filtered") ?? 0) + (tally.get("removed") ?? 0);
  const denom = seen + hidden;

  const moved = [];
  for (const it of items.values()) {
    const h = history(checks.get(it.id) ?? []);
    if (h.changed_at) moved.push({ it, h });
  }

  return render("/standing", "Standing", `
<h1>What became of the things you said</h1>
<p class="sub">${items.size} comment${items.size === 1 ? "" : "s"} stored, read back as a logged-out stranger.</p>
<div class="actions" style="margin-top:0">
  ${runBtn("sync", "Read my profile again")}
  ${runBtn("check", "Re-check my threads", { primary: unchecked > 0, title: "About a minute per thread" })}
  ${unchecked ? `<span class="muted">${unchecked} not looked at yet</span>` : ""}
</div>
${denom ? `<div class="card"><div class="big ${hidden ? "sig" : "ok"}">${Math.round((hidden / denom) * 100)}%</div>
<p style="margin-top:10px">of what a stranger could have read, they cannot.</p></div>` : ""}
<div class="card">${[...tally].sort((a, b) => b[1] - a[1]).map(([st, n]) =>
  `<div class="row"><span><b>${n}</b> &nbsp;${tag(st, st === "visible" ? "ok" : st === "filtered" || st === "removed" ? "no" : "dim")}</span>
   <span class="sub right" style="font-size:14px">${esc(STATES[st] ?? "")}</span></div>`).join("")
  || `<p class="sub">Nothing checked yet.</p>`}
${unchecked ? `<div class="row"><span><b>${unchecked}</b> &nbsp;${tag("unchecked")}</span><span class="sub" style="font-size:14px">not looked at yet</span></div>` : ""}
</div>
${moved.length ? `<h2>Changed since the first look</h2><div class="card">${moved.slice(0, 10).map(({ it, h }) =>
  `<div class="row"><span>${esc(h.changed_at.from)} → <b class="sig">${esc(h.changed_at.to)}</b></span>
   <span class="sub" style="font-size:13px">${fmt(h.changed_at.at)}</span></div>
   <div class="said" style="margin:8px 0 4px">${esc((it.body || it.url || "").slice(0, 220))}</div>`).join("")}</div>` : ""}
<p class="sub" style="font-size:14px">A change of state is the one thing a private window cannot show you.
It needs two looks, and both are on disk.</p>`);
};

/* --- Today --------------------------------------------------------------- */

/**
 * The first of the four questions (0.7.0): what is on today. The deck's top
 * card mirrored — the panel is where it is answered — then who wrote back,
 * what is due, who is worth answering, and the campaigns' numbers. A person
 * who only ever opens this page knows what to do next.
 */
views["/"] = () => {
  const snap = cardSnapshot();
  const deck = nextCards(snap);
  const top = deck[0] ?? null;
  const w = snap.conversations;
  const q = snap.queue;
  const pend = snap.pendingCount;
  const due = snap.due;
  const live = [
    ...J.running().map((j) => `${j.label}${j.note ? ` — ${j.note}` : ""}`),
    ...(RT() ? RT().list().filter((t) => /^(running|blocked)$/.test(t.status)).map((t) => `${t.title} — ${t.status === "blocked" ? "needs you on the panel" : "reading in its tab"}`) : []),
  ];
  const camps = readCampaigns(P());
  const dg = campaignDigest(S, camps).filter((r) => r.id);
  const setup = memoryProgress(P());
  const ready = onboarded(snap);
  const next = top ? `<div class="card">
  <div class="meta">Next, on the panel${top.eyebrow ? ` · ${esc(top.eyebrow)}` : ""}</div>
  <p><b>${esc(top.question ?? "")}</b></p>
  ${top.help ? `<p class="sub" style="font-size:14px;white-space:pre-wrap">${esc(String(top.help).slice(0, 420))}</p>` : ""}
  <div class="actions"><a class="btn primary" href="/panel/">Open the panel</a>${deck.length > 1 ? `<span class="muted">${deck.length - 1} more behind it</span>` : ""}</div>
</div>` : "";
  const waitingHtml = w.length ? `<h2>Waiting for you</h2>${w.slice(0, 5).map((c) => `<div class="card">
  <div class="meta">u/${esc(c.author ?? "?")} · ${esc(LB().room(c.place))} · ${esc(ago(c.latest?.at))}${c.campaign ? ` · ${esc(c.campaign)}` : ""} · turn ${c.turn}</div>
  <div class="said">${esc(String(c.latest?.text ?? "").slice(0, 400))}</div>
  <p class="sub" style="margin:10px 0 0;font-size:13px">You said: ${esc(String(c.said ?? "").slice(0, 160) || "—")}</p>
  <div class="actions"><a class="btn" href="${esc(c.url)}" target="_blank" rel="noreferrer noopener">Open the thread</a><span class="muted">${c.draft ? "a reply is drafted on the panel" : "the panel writes the reply"}</span></div>
</div>`).join("")}${w.length > 5 ? `<p class="sub"><a href="/people?view=waiting">All ${w.length} →</a></p>` : ""}` : "";
  const dueN = (due.sources ?? 0) + (due.conversations ?? 0);
  const dueHtml = `<div class="card">
  <div class="row" style="border:0;padding:0"><b>${dueN ? `${dueN} read${dueN === 1 ? " is" : "s are"} due` : "Nothing is due"}</b>${due.running ? tag("reading", "ok") : ""}</div>
  <p class="sub" style="margin:8px 0 0;font-size:14px">${due.sources} watched room${due.sources === 1 ? "" : "s"} past cadence · ${due.conversations} conversation${due.conversations === 1 ? "" : "s"} to look at${due.unbound ? ` · ${due.unbound} posted repl${due.unbound === 1 ? "y" : "ies"} not yet found on your profile` : ""}. Each is a tab in your own browser, a page turn every few seconds.</p>
  <div class="actions">${runBtn("tick", "Read what is due", { primary: dueN > 0, disabled: Boolean(due.running) })}${due.unbound ? runBtn("sync", "Read my profile", { small: true }) : ""}</div>
</div>`;
  const queueHtml = `<div class="card">
  <div class="row" style="border:0;padding:0"><b>${q.length} ${q.length === 1 ? "person" : "people"} worth answering</b>${pend ? `<span class="sub" style="font-size:13px">${pend} more waiting on a verdict</span>` : ""}</div>
  <div class="actions">${q.length ? `<a class="btn primary" href="/queue">Work the queue</a>` : ""}${pend ? runBtn("judge", `Judge ${pend} now`, { small: true }) : ""}<a class="btn small" href="/people">Everybody</a></div>
</div>`;
  const campHtml = dg.length ? `<h2>Campaigns</h2><table><thead><tr><th>campaign</th><th>found</th><th>fit</th><th>sent</th><th>replied</th><th>2nd turn</th><th>waiting</th><th>crowding</th></tr></thead><tbody>
${dg.map((r) => `<tr><td><b>${esc(r.name)}</b> ${tag(r.status, r.status === "active" ? "ok" : "dim")}</td><td>${r.found}</td><td>${r.fit}${r.fitRate != null ? ` <span class="muted">(${Math.round(r.fitRate * 100)}%)</span>` : ""}</td><td>${r.sent}</td><td>${r.replies}</td><td>${r.second}</td><td>${r.waiting}</td><td>${r.crowd ?? "—"}</td></tr>`).join("")}
</tbody></table><p class="sub" style="font-size:13px">Crowding is the median number of comments a post already had when it was found — a room whose question gets a dozen generated answers on day one. <a href="/campaigns">Campaigns →</a></p>` : "";
  return render("/", "Today", `
<h1>Today</h1>
${live.length ? `<p class="sub">Now: ${esc(live.join(" · "))}</p>` : ""}
${!ready ? `<div class="note"><b>Setup is ${setup.done} of ${setup.total} done.</b> The panel asks the rest one card at a time — what you sell, who it is for, your account, the first room — and proposes the first campaign when it is done. <a href="/panel/">Open the panel</a>, or <a href="/setup">finish it here</a>.</div>` : ""}
${next}
${waitingHtml}
${dueHtml}
${queueHtml}
${campHtml}`, { banner: "" });
};

/* --- You ----------------------------------------------------------------- */

/** The fourth question: who am I here. A hub with one line of state per
 *  page under it, and the advanced screens named as such. */
views["/you"] = () => {
  const a = acct();
  const items = S.items();
  const prog = memoryProgress(P());
  const voiced = existsSync(S.F("voice.json"));
  const all = listProjects(DATA);
  const p = plan(P());
  const tasks = RT() ? RT().list() : [];
  const live = tasks.filter((t) => /^(running|blocked)$/.test(t.status)).length;
  const srcs = S.sources();
  const one = (href, title, state, note) => `<a class="card" href="${href}" style="display:block;text-decoration:none;color:inherit">
  <div class="row" style="border:0;padding:0"><b>${esc(title)}</b><span class="sub" style="font-size:13px">${esc(state)}</span></div>
  ${note ? `<p class="sub" style="margin:6px 0 0;font-size:14px">${esc(note)}</p>` : ""}</a>`;
  return render("/you", "You", `
<h1>You</h1>
<p class="sub">Who you are here, how you sound, what the specialist knows, and where the models run.</p>
${one("/standing", "Your account and standing", a?.name ? `${a.name} · ${items.size} thing${items.size === 1 ? "" : "s"} you said` : "no account yet", "Your own words, read back the way a stranger sees them.")}
${one("/ready", "Ready, room by room", srcs.length ? `${srcs.length} room${srcs.length === 1 ? "" : "s"} watched` : "nothing watched yet", "Where you stand in each room, and what the gate refuses to promise.")}
${one("/voice", "Your voice", voiced ? "measured" : "not measured yet", "Read off your own comments; corrected by you. Every draft is written in it.")}
${one("/memory", "What it knows about you", `${prog.done} of ${prog.total} written`, "What you sell, who it is for, the fit rule, what is true about you. Every verdict and draft reads these.")}
${one("/projects", "Projects", `${all.length} · working on “${PJ().name}”`, "One isolated context per brand. Switch on the panel or here.")}
${one("/settings", "Models", p === "local" ? "a local model" : hasKey(P()) ? `the ${p} plan on OpenRouter` : "no key yet", "Where the scout, the judge and the writer run, and what they cost.")}
${one("/skills", "Skills", "", "Which platform adapters and colleagues are installed, and which is running each seat.")}
<h2>Advanced</h2>
<p class="sub" style="font-size:14px">The specialist proposes all of this for you on the panel. These pages are for doing it by hand and reading the logs.</p>
${one("/tasks", "Colleagues and their tasks", live ? `${live} at work` : `${tasks.length} run${tasks.length === 1 ? "" : "s"} so far`, "Start a reader on a page by hand; read what each one did.")}
${one("/sources", "Watched sources", srcs.length ? `${srcs.length} watched` : "none", "Try a room, watch it, stop watching, take what another machine found.")}
${one("/rooms", "Rooms and their rules", "", "Which rooms permit what you would post — answered once by you.")}
${one("/jobs", "Job history", "", "Every read this dashboard ran, and what it said.")}`);
};

/* --- Waiting ------------------------------------------------------------- */

views["/waiting"] = () => {
  const rows = S.readJsonl("replies.jsonl");
  const latest = new Map();
  for (const r of rows) latest.set(r.id, r);
  const waiting = [...latest.values()].filter((r) => r.state === "waiting");
  const items = S.items();
  if (!waiting.length)
    return render("/waiting", "Waiting", rows.length
      ? `<h1>Nobody is waiting on you</h1><p class="sub">${rows.length} conversation${rows.length === 1 ? "" : "s"} checked.</p>
         <div class="actions">${runBtn("back", "Check again")}</div>`
      : empty("No conversations checked yet.", runBtn("back", "Find who is waiting", { primary: true })));

  waiting.sort((a, b) => String(a.latest?.at ?? "").localeCompare(String(b.latest?.at ?? "")));
  return render("/waiting", "Waiting", `
<h1>${waiting.length} waiting for you</h1>
<p class="sub">Oldest first, because that is the one going cold. Membership is made of second and third replies.</p>
<div class="actions" style="margin-top:0">${runBtn("back", "Check again")}</div>
${waiting.map((r) => { const it = items.get(r.id); return `<div class="card">
<div class="meta">u/${esc(r.latest?.author ?? "?")} · ${fmt(r.latest?.at)}${r.since_you ? ` · <b class="sig">since you last spoke</b>` : ""} · ${r.replies} repl${r.replies === 1 ? "y" : "ies"}</div>
<div class="said">${esc(r.latest?.text || "(text expired — the 48-hour sweep dropped it)")}</div>
<p class="sub" style="margin:12px 0 0;font-size:14px">You said: ${esc((it?.body ?? "").slice(0, 160) || "—")}</p>
<div class="actions"><a class="btn" href="${esc(r.latest?.url || it?.url || "#")}" target="_blank" rel="noreferrer noopener">Open the thread</a></div>
</div>`; }).join("")}
<p class="sub" style="font-size:14px">You answer these yourself, in your own words. Nothing here writes or sends anything.</p>`);
};

/* --- Queue --------------------------------------------------------------- */

/** Everybody eligible for the deck, newest first. Shared with /people so the
 *  two screens can never disagree about who is in the queue. */
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

views["/queue"] = (url) => {
  const rows = queueRows();
  const pend = S.pending();
  // The backlog behind the queue, said out loud even when the queue is full:
  // a person working through five fits should know nineteen more are waiting
  // on a verdict, or the "5" is a number that lies by omission.
  const backlog = pend.length && rows.length
    ? `<div class="note"><b>${pend.length} more found and waiting on a verdict.</b> ${runBtn("judge", `Judge ${pend.length} now`, { small: true })}</div>`
    : "";
  if (!rows.length)
    return render("/queue", "Queue", empty(
      pend.length ? `${pend.length} post${pend.length === 1 ? "" : "s"} found and waiting on a verdict.` : "Nobody is waiting for an answer.",
      `${pend.length ? runBtn("judge", `Judge ${pend.length} now`, { primary: true }) : ""}
       ${runBtn("tick", "Read what is due")}
       <a class="btn" href="/sources">Watch somewhere</a>`,
    ));

  const at = Math.min(Math.max(0, Number(url.searchParams.get("i")) || 0), rows.length - 1);
  const it = rows[at];
  const draft = S.drafts().filter((d) => d.id === it.id).pop();
  const blocked = burst(S.sentLog(), it.place);
  const stand = standing([...S.items().values()], S.checksById());
  const ready = readiness(stand.get(it.place) ?? { place: it.place, comments: 0, visible: 0 }, S.roomState(it.place));

  return render("/queue", "Queue", `
<div data-deck>
${backlog}
<h1>One person</h1>
<p class="sub">${at + 1} of ${rows.length} · ${esc(LB().room(it.place))} · ${tag(ready.state, ready.state === "ready" ? "ok" : ready.state === "not ready" ? "no" : "dim")}
  <span class="muted"> · <kbd>j</kbd> next · <kbd>s</kbd> skip · <kbd>o</kbd> open · <kbd>d</kbd> draft</span></p>
${blocked ? `<div class="note"><b>The gate says not yet.</b> ${esc(blocked.why)}.</div>` : ""}
${ready.state === "not ready" ? `<div class="note"><b>${esc(ready.why)}</b></div>` : ""}
<div class="card">
  <div class="meta">u/${esc(it.author ?? "?")} · ${fmt(it.posted_at ?? it.seen_at)} · ${esc(ago(it.posted_at ?? it.seen_at))}</div>
  ${it.title ? `<p><b>${esc(it.title)}</b></p>` : ""}
  <div class="said">${esc(it.body || "")}</div>
  <p class="sub" style="font-size:13px;margin:12px 0 0">judged fit: ${esc(it.why || "—")}</p>
</div>
<div class="card">
  <h2 style="margin-top:0">${draft ? `Your drafts${(draft.round ?? 1) > 1 ? ` · round ${draft.round}` : ""}` : "No draft yet"}</h2>
  ${draft ? `${draft.note ? `<p class="sub" style="font-size:13px">Written after your note: &ldquo;${esc(draft.note)}&rdquo;</p>` : ""}
    ${draftTabs(draft).map((tb) => `<div class="meta" style="margin-top:12px">${esc(tb.label)}</div><div class="said">${esc(tb.value)}</div>
    ${tb.warnings.length ? `<div class="note" style="margin-top:8px">${tb.warnings.map((w) => `<b>${esc(w)}</b>`).join(" · ")} — each is either true or it is the thing that ends the account; <code>mq draft ${esc(it.id)} --save</code> names them.</div>` : ""}`).join("")}
    <p class="sub" style="font-size:13px;margin:12px 0 0">Three drafts, one per style — pick and edit on the panel, or comment on one there and all three are written again.</p>`
    : hasModel(P())
      ? `<p class="sub">Nothing written for this one yet.</p>
         <div class="actions">${runBtn("draft", "Write a draft", { args: [it.id], primary: true })}</div>`
      : `<p class="sub">Add an OpenRouter key on <a href="/settings">Settings</a> and this writes itself.
         Without one: <code>mq draft ${esc(it.id)}</code> prints the prompt for whatever model you already pay for.</p>`}
</div>
<div class="actions">
  <a class="btn primary" data-open href="${esc(it.url)}" target="_blank" rel="noreferrer noopener">Open it on Reddit</a>
  <form method="POST" action="/mark"><input type="hidden" name="id" value="${esc(it.id)}"><input type="hidden" name="mark" value="sent">
    <button ${blocked ? `disabled title="${esc(blocked.why)}"` : ""}>I posted it</button></form>
  <form method="POST" action="/mark"><input type="hidden" name="id" value="${esc(it.id)}"><input type="hidden" name="mark" value="skip">
    <button data-skip>Not this one</button></form>
  ${at > 0 ? `<a class="btn small" data-prev href="/queue?i=${at - 1}">← back</a>` : ""}
  ${at + 1 < rows.length ? `<a class="btn small" data-next href="/queue?i=${at + 1}">next →</a>` : ""}
</div>
<p class="sub" style="font-size:13px;margin-top:20px">&ldquo;I posted it&rdquo; is the only thing here that writes anything, and what it writes is on your disk.
It retires u/${esc(it.author ?? "?")} from every future queue — undoable on <a href="/people">Prospects</a>.</p>
</div>`);
};

/* --- Prospects ----------------------------------------------------------- */

const PEOPLE_TABS = [
  ["queue", "In the queue"],
  ["waiting", "Waiting for you"],
  ["sent", "Answered"],
  ["skipped", "Skipped"],
  ["pending", "Awaiting a verdict"],
  ["all", "Everyone found"],
  ["contacted", "Never show again"],
];

views["/people"] = (url) => {
  const view = PEOPLE_TABS.some(([v]) => v === url.searchParams.get("view"))
    ? url.searchParams.get("view") : "queue";
  const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
  const all = S.found(), marks = S.marks(), verdicts = S.verdicts(), gone = S.contacted();

  let rows = [];
  if (view === "queue") rows = queueRows().map((r) => ({ ...r, status: "queued" }));
  else if (view === "waiting") rows = waitingRows(S).map((c) => ({
    id: c.id, author: c.latest?.author ?? c.author, place: c.place, title: null, body: c.latest?.text ?? "",
    status: "waiting", url: c.latest?.url ?? c.url, seen: c.latest?.at ?? c.checked_at, why: null,
    said: (c.turns ?? []).filter((t) => t.by === "you").pop()?.text ?? "", campaign: c.campaign ?? null,
  }));
  else if (view === "pending") rows = S.pending().map((p) => ({ ...(all.get(p.id) ?? { id: p.id }), status: "unjudged" }));
  else if (view === "contacted") {
    // The permanent list, and the only screen that can take somebody off it.
    const rowsByAuthor = new Map();
    for (const r of S.readJsonl("contacted.jsonl")) {
      const a = String(r.author ?? "").toLowerCase();
      if (a) rowsByAuthor.set(a, r);
    }
    rows = [...rowsByAuthor.values()].filter((r) => !r.removed).map((r) => ({
      id: r.id, author: r.author, seen_at: r.at, status: "retired",
      ...(all.get(r.id) ?? {}),
      // The stored row wins for the fields the found table also has, but `at`
      // is when they were retired and that is what this screen is about.
      seen: r.at,
    }));
  } else {
    for (const it of all.values()) {
      const m = marks.get(it.id);
      const mark = m && m.mark !== "undo" ? m.mark : null;
      const ver = verdicts.get(it.id);
      if (view === "sent" && mark !== "sent") continue;
      if (view === "skipped" && mark !== "skip") continue;
      if (view === "all") { /* everything */ }
      rows.push({
        ...it,
        status: mark ?? (ver ? (ver.fit ? "queued" : "not a fit") : "unjudged"),
        why: ver?.why,
      });
    }
  }

  if (q) rows = rows.filter((r) =>
    `${r.author ?? ""} ${r.place ?? ""} ${r.title ?? ""} ${r.body ?? ""}`.toLowerCase().includes(q));
  rows.sort((a, b) => String(b.seen ?? b.posted_at ?? b.seen_at ?? "").localeCompare(String(a.seen ?? a.posted_at ?? a.seen_at ?? "")));

  const { at, pages, from, to } = pageWindow(url.searchParams.get("page"), rows.length);
  const shown = rows.slice(from, to);
  const base = `/people?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ""}&`;

  const tone = (s) => (s === "sent" ? "ok" : s === "skip" || s === "not a fit" ? "no" : s === "queued" || s === "waiting" ? "sig" : "dim");
  const label = (s) => (s === "skip" ? "skipped" : s);

  const body = !rows.length
    ? empty(q ? `Nothing matches “${q}”.` : {
        queue: "Nobody is in the queue.",
        waiting: "Nobody is waiting on you. A conversation opens when you press “I posted it”, and the tick reads it again from the stranger's seat.",
        sent: "You have not marked anybody answered yet.",
        skipped: "Nothing skipped.",
        pending: "Nothing is waiting on a verdict.",
        all: "Nothing found yet.",
        contacted: "Nobody is retired. This fills up as you answer people.",
      }[view], view === "all" || view === "queue" ? runBtn("tick", "Read what is due", { primary: true }) : "")
    : `<table><thead><tr><th>Who</th><th>Where</th><th>What they said</th><th>When</th><th></th></tr></thead><tbody>
${shown.map((r) => `<tr>
  <td><b>u/${esc(r.author ?? "?")}</b><br>${tag(label(r.status), tone(r.status))}</td>
  <td>${r.place ? esc(LB().room(r.place)) : "<span class='muted'>—</span>"}</td>
  <td>${r.title ? `<b>${esc(String(r.title).slice(0, 90))}</b><br>` : ""}
      <span class="muted">${esc(String(r.body ?? "").slice(0, 120))}</span>
      ${r.why ? `<br><span class="muted">judged: ${esc(r.why)}</span>` : ""}${r.said ? `<br><span class="muted">you said: ${esc(String(r.said).slice(0, 120))}</span>` : ""}</td>
  <td class="muted">${esc(ago(r.seen ?? r.posted_at ?? r.seen_at))}</td>
  <td class="right">
    ${r.url ? `<a class="btn small" href="${esc(r.url)}" target="_blank" rel="noreferrer noopener">Open</a>` : ""}
    ${view === "contacted" ? `<form method="POST" action="/people/undo">
        <input type="hidden" name="author" value="${esc(r.author ?? "")}">
        <button class="small" data-confirm="Put u/${esc(r.author ?? "?")} back in the queue?">Undo</button></form>` : ""}
    ${(view === "sent" || view === "skipped") && r.id ? `<form method="POST" action="/mark">
        <input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="mark" value="undo">
        <button class="small">Undo</button></form>` : ""}
  </td></tr>`).join("")}
</tbody></table>${pager(base, at, pages)}`;

  return render("/people", "People", `
<h1>People</h1>
<p class="sub">Everybody found, judged, answered, written back or retired — ${rows.length} here. <a href="/queue">Work the queue one person at a time →</a></p>
<div class="tabs">${PEOPLE_TABS.map(([v, t]) =>
  `<a class="${v === view ? "on" : ""}" href="/people?view=${v}">${t}</a>`).join("")}</div>
<form method="GET" action="/people" class="field" style="display:flex;gap:8px;max-width:520px">
  <input type="hidden" name="view" value="${esc(view)}">
  <input type="search" name="q" value="${esc(q)}" placeholder="search names, rooms, what they said">
  <button class="small">Search</button>
</form>
${body}
${view === "contacted" ? `<p class="sub" style="font-size:13px">This list is permanent and shared across everything —
somebody on it is never offered again, in any room. Undo puts them back.</p>` : ""}`);
};

/* --- Rooms --------------------------------------------------------------- */

views["/rooms"] = () => {
  const places = [...new Set(S.readJsonl("probes.jsonl").map((r) => r.place))];
  if (!places.length)
    return render("/rooms", "Rooms", empty("No rooms probed yet.", `<a class="btn primary" href="/sources">Probe a room</a>`));
  return render("/rooms", "Rooms", `
<h1>Rooms</h1>
<p class="sub">A room stays unwatchable until its rules have been read. That is deliberate — Reddit does not serve
its rules to a logged-out reader, and the public description is not the rules list.</p>
${places.map((p) => { const st = S.roomState(p); const rules = LB().rulesUrl(p); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(LB().room(p))}</b>
${tag(st.state, st.state === "allowed" ? "ok" : st.state === "banned" ? "no" : "dim")}</div>
${st.state === "unanswered" ? `
<p class="sub" style="margin:12px 0 8px;font-size:14px">Nobody has read this room's rules. Open them, then answer here.</p>
<div class="actions">
  ${rules ? `<a class="btn" href="${esc(rules)}" target="_blank" rel="noreferrer noopener">Read the rules</a>` : ""}
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}"><input type="hidden" name="answer" value="yes"><button>They permit it</button></form>
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}"><input type="hidden" name="answer" value="no"><button>They forbid it</button></form>
</div>` : `<div class="actions" style="margin-top:10px">
  ${st.state === "allowed" ? runBtn("watch", "Watch this room", { args: [p], small: true }) : ""}
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}">
    <input type="hidden" name="answer" value="${st.state === "allowed" ? "no" : "yes"}">
    <button class="small">Change to ${st.state === "allowed" ? "forbidden" : "permitted"}</button></form>
  <span class="muted">recorded in ${esc(S.roomPath(p))}</span>
</div>`}
</div>`; }).join("")}`);
};

/* --- Campaigns ----------------------------------------------------------- */

views["/campaigns"] = () => {
  const all = readCampaigns(P());
  const fl = takeFlash();
  const L = LB();
  const srcs = S.sources();
  const dg = campaignDigest(S, all);
  const mentionOptions = (chosen) => Object.entries(MENTIONS).map(([id, m]) => `<option value="${id}" ${chosen === id ? "selected" : ""}>${esc(m.label)} — ${esc(m.note)}</option>`).join("");
  const numbers = (c) => {
    const r = dg.find((x) => x.id === c.id);
    return r ? `<p class="sub" style="margin:6px 0;font-size:13px">${r.found} found · ${r.fit} fit${r.fitRate != null ? ` (${Math.round(r.fitRate * 100)}%)` : ""} · ${r.sent} sent · ${r.replies} replied · ${r.second} reached a second turn · ${r.waiting} waiting on you${r.crowd != null ? ` · crowding ${r.crowd}` : ""}</p>` : "";
  };
  const one = (c) => {
    const under = srcs.filter((x) => x.campaign === c.id);
    return `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(c.name)}</b> ${tag(c.status, c.status === "active" ? "ok" : "dim")} ${tag(`mention: ${c.mention}`, c.mention === "disclosed" ? "sig" : "dim")} <span class="muted">rubric ${esc(c.hash)}</span></div>
<p class="muted" style="margin:6px 0">${esc(c.id)}${c.platform ? ` · ${esc(c.platform)}` : ""}${under.length ? ` · watching ${under.map((x) => esc(L.room(x.place)) + (x.q ? ` for “${esc(x.q)}”` : "")).join(", ")}` : " · no source watched under it yet"}</p>
${numbers(c)}
<form method="POST" action="/campaigns/save">
  <input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="name" value="${esc(c.name)}">
  <div class="field"><label>The idea — a direction, never a template</label><textarea name="idea" rows="6">${esc(c.idea)}</textarea></div>
  <div class="field"><label>Who it fits — narrows rule.md for this campaign; empty means the rule is enough</label><textarea name="fit" rows="3">${esc(c.fit)}</textarea></div>
  <div class="field"><label>Never</label><textarea name="never" rows="2">${esc(c.never)}</textarea></div>
  <div class="field"><label>Voice — how it sounds under this campaign, if a room or a platform wants a different tone; the measured voice still wins on anything it names</label><textarea name="voice" rows="2">${esc(c.voice ?? "")}</textarea></div>
  <div class="field"><label>May a first message name what you built?</label><select name="mention">${mentionOptions(c.mention)}</select></div>
  <div class="actions"><button class="primary" type="submit">Save</button>
    <span class="muted">${esc(c.path)}</span></div>
</form>
<div class="actions">
  <form method="POST" action="/campaigns/status"><input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="status" value="${c.status === "active" ? "paused" : "active"}"><button class="small">${c.status === "active" ? "Pause" : "Resume"}</button></form>
  ${c.status !== "done" ? `<form method="POST" action="/campaigns/status"><input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="status" value="done"><button class="small">Mark done</button></form>` : ""}
</div>
</div>`;
  };
  return render("/campaigns", "Campaigns", `
<h1>Campaigns</h1>
<p class="sub">What you are trying — a tactic, an angle, a different tone for a different room. A direction, never a template: the writer
applies it to one person at a time in its own words, is shown what it already said under the campaign, and every save runs the eight-word
repeat guard regardless. Tell the specialist on the panel and it proposes one; after each day's digest it proposes pausing a saturated one or
aiming a new one at a different kind of person. Here you write or correct one by hand. <a href="/sources">Try a room first →</a></p>
${fl.campaignError ? `<div class="note"><b>Not saved:</b> ${esc(fl.campaignError)}</div>` : ""}
${all.length ? all.map(one).join("") : `<p class="sub">None yet in this project.</p>`}
<div class="card"><h2 style="margin-top:0">New campaign</h2>
<p class="sub" style="font-size:14px">Walk it through the panel as cards — the idea in your words, who it fits, the mention rule, the room, the phrase — and it probes the room in your browser when you press Start. Or save it straight in from here.</p>
<form method="POST" action="/campaigns/propose">
  <div class="field"><label for="c-name">Name</label><input id="c-name" type="text" name="name" placeholder='Honest comments under "finding clients"' required></div>
  <div class="field"><label for="c-idea">The idea — what to say and why it is honest to say it, not the words to say it with</label><textarea id="c-idea" name="idea" rows="5" required></textarea></div>
  <div class="field"><label for="c-fit">Who it fits (optional)</label><textarea id="c-fit" name="fit" rows="2"></textarea></div>
  <div class="field"><label for="c-voice">Voice (optional) — how it sounds under this campaign</label><textarea id="c-voice" name="voice" rows="2"></textarea></div>
  <div class="field"><label for="c-place">Room</label><input id="c-place" type="text" name="place" placeholder="${esc(L.roomAsk.placeholder)}"></div>
  <div class="field"><label for="c-q">The phrase somebody types when they have the problem</label><input id="c-q" type="text" name="q" placeholder="${esc(L.phrase.placeholder)}"></div>
  <div class="field"><label for="c-mention">May a first message name what you built?</label><select id="c-mention" name="mention">${mentionOptions("never")}</select></div>
  <div class="actions"><button class="primary" type="submit" name="how" value="panel">Walk through it on the panel</button><button type="submit" name="how" value="save">Save it now</button></div>
</form></div>`);
};

/* --- Projects ------------------------------------------------------------ */

views["/projects"] = () => {
  const all = listProjects(DATA);
  const fl = takeFlash();
  return render("/projects", "Projects", `
<h1>Projects</h1>
<p class="sub">One brand, one isolated context each: its own memory files, store, voice, campaigns, colleagues and threads.
The root <code>${esc(DATA)}</code> is the default project. Shared across all of them: your key and the model seats, the people you have
already answered (never the same human twice, in any project), and the local skills ring.</p>
${fl.projectError ? `<div class="note"><b>Not made:</b> ${esc(fl.projectError)}</div>` : ""}
<table><thead><tr><th>project</th><th>where</th><th></th></tr></thead><tbody>
${all.map((p) => `<tr><td><b>${esc(p.name)}</b> ${p.current ? tag("current", "ok") : ""}<br><span class="muted">${esc(p.id)}${p.added ? ` · since ${esc(ago(p.added))}` : ""}</span></td>
<td class="muted"><code>${esc(p.dir)}</code></td>
<td>${p.current ? "" : `<form method="POST" action="/projects/use"><input type="hidden" name="id" value="${esc(p.id)}"><button class="small">Switch to it</button></form>`}</td></tr>`).join("")}</tbody></table>
<div class="card"><h2 style="margin-top:0">New project</h2>
<p class="sub" style="font-size:14px">Made complete and switched to at once. Its setup — the account, the site, your voice, the first room — starts on the panel, one card at a time.
Your account, voice, me.md and persona are copied in as a start; everything else begins empty.</p>
<form method="POST" action="/projects/new">
  <div class="field"><label for="p-name">Name</label><input id="p-name" type="text" name="name" placeholder="The other product" required></div>
  <button class="primary" type="submit">Make it and switch</button>
</form></div>`);
};

/* --- Ready --------------------------------------------------------------- */

views["/ready"] = () => {
  const stand = standing([...S.items().values()], S.checksById());
  const sent = S.sentLog();
  const m = mix([...S.items().values()].filter((i) => i.kind === "comment").length, sent.length);
  if (!stand.size) {
    const g = profile404();
    if (g) return render("/ready", "Ready", gone(g));
    return render("/ready", "Ready", empty("No standing measured yet — it is read off your own comments.",
      `${runBtn("sync", "Read my profile", { primary: true })}${runBtn("check", "Then check the threads")}`));
  }
  return render("/ready", "Ready", `
<h1>Where you stand</h1>
<p class="sub">Read off your own comments and what a stranger can see of them. No invented threshold:
Reddit does not publish what Crowd Control requires.</p>
${[...stand.values()].map((r) => { const d = readiness(r, S.roomState(r.place)); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(LB().room(r.place))}</b>
${tag(d.state, d.state === "ready" ? "ok" : d.state === "not ready" ? "no" : "dim")}</div>
<p class="sub" style="margin:10px 0 0;font-size:14px">${esc(d.why)}</p></div>`; }).join("")}
<h2>Your mix</h2>
<div class="card">
<p style="font-size:18px;margin:0 0 10px">${m.outreach === 0
  ? `${m.seen} comment${m.seen === 1 ? "" : "s"} seen, none of them logged as outreach.`
  : `${m.ordinary} ordinary to ${m.outreach} outreach${m.ratio === null ? "" : ` — about ${m.ratio.toFixed(1)}:1`}.`}</p>
<p class="sub" style="font-size:14px;margin:0">${esc(m.note)}</p></div>
<div class="card"><p class="sub" style="font-size:14px;margin:0">${esc(CQS_NOTE)}</p></div>
<p class="sub" style="font-size:13px">Budget: ${PER_ROOM_24H} per room per day, ${OVERALL_24H} overall.</p>`);
};

/* --- Sources ------------------------------------------------------------- */

views["/sources"] = () => {
  const srcs = S.sources();
  const reads = new Map(S.readJsonl("reads.jsonl").filter((r) => r.source).map((r) => [r.source, r]));
  const found = [...S.found().values()];
  const probeForm = `
<div class="card">
  <h2 style="margin-top:0">Try a room</h2>
  <p class="sub" style="font-size:14px">One read, no commitment. A scoped search runs 42% fit against 29% for a
  bare feed, so the phrase is worth writing.</p>
  <form method="POST" action="/api/run">
    <input type="hidden" name="verb" value="probe">
    <div class="field"><label for="p-sub">Subreddit</label>
      <input id="p-sub" type="text" name="a0" placeholder="smallbusiness" required></div>
    <input type="hidden" name="a1" value="--q">
    <div class="field"><label for="p-q">The phrase somebody types when they have the problem</label>
      <input id="p-q" type="text" name="a2" placeholder="how do I get clients"></div>
    <button class="primary" type="submit">Probe it</button>
  </form>
</div>`;

  // Somebody else's machine may already be reading the rooms you care about.
  // Taking what it found costs one request; reading them yourself costs a
  // minute each.
  const pulled = existsSync(S.F("pull.json")) ? JSON.parse(readFileSync(S.F("pull.json"), "utf8")) : {};
  const pullForm = `
<div class="card">
  <h2 style="margin-top:0">Take what another machine found</h2>
  <p class="sub" style="font-size:14px">If somebody is running a hub (<code>npm run hub</code>), pull from it instead of
  spending a minute a request on the same rooms. You get public posts; they are judged here, against your own
  <code>rule.md</code>, and whoever you have already answered never reaches your queue — the hub is not told.</p>
  ${Object.entries(pulled).map(([u, s]) => `<div class="row"><span><code>${esc(u)}</code></span>
    <span class="muted">last pulled ${esc(ago(s.at))}</span></div>`).join("")}
  <form method="POST" action="/api/run" style="margin-top:14px">
    <input type="hidden" name="verb" value="pull">
    <div class="field"><label for="hub">Hub URL</label>
      <input id="hub" type="url" name="a0" placeholder="https://your-tunnel.example.com"
        value="${esc(Object.keys(pulled)[0] ?? "")}" required></div>
    <input type="hidden" name="a1" value="--token">
    <div class="field"><label for="tok">Token ${Object.keys(pulled).length ? "— leave blank to reuse the one already saved" : ""}</label>
      <input id="tok" type="password" name="a2" placeholder="es_…" autocomplete="off"></div>
    <button type="submit">Pull</button>
  </form>
</div>`;

  if (!srcs.length)
    return render("/sources", "Sources", `<h1>What is watched</h1>
<p class="sub">Nothing yet. Probe a room, judge what comes back, and if it clears the 10% floor you can commit it.</p>
${probeForm}${pullForm}`);

  return render("/sources", "Sources", `
<h1>What is watched</h1>
<p class="sub">Subreddit submissions and scoped searches only. The undirected comment firehose is refused
by shape: 4,074 reads for 173 leads in the corpus, 23.5 reads each.</p>
<div class="actions" style="margin-top:0">${runBtn("tick", "Read what is due", { primary: true })}</div>
${srcs.map((s) => { const r = reads.get(s.id); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(s.id)}</b>
<span class="sub" style="font-size:13px">${found.filter((f) => String(f.probe ?? "").toLowerCase() === s.id).length} found</span></div>
<p class="sub" style="margin:8px 0 0;font-size:13px">${r ? (r.ok ? `last read ${fmt(r.at)} · ${esc(ago(r.at))}` : `<span class="no">error: ${esc(r.err ?? "")}</span>`) : "never read"} · every ${s.cadence_min}m</p>
<div class="actions" style="margin-top:12px">${runBtn("unwatch", "Stop watching", { args: [s.id], small: true, confirm: `Stop watching ${s.id}? What it already found is untouched.` })}</div>
</div>`; }).join("")}
${probeForm}${pullForm}`);
};

/* --- Voice --------------------------------------------------------------- */

views["/voice"] = () => {
  const raw = existsSync(S.F("voice.json")) ? JSON.parse(readFileSync(S.F("voice.json"), "utf8")) : null;
  const fp = mergeVoice(raw?.measured ?? null, raw?.user ?? null);
  const rules = voiceRules(fp), summary = voiceSummary(fp);
  if (!raw)
    return render("/voice", "Voice", empty("Voice not measured yet — it is read off your own comments.",
      runBtn("voice", "Measure my voice", { primary: true })));
  return render("/voice", "Voice", `
<h1>How you write</h1>
<p class="sub">Measured from ${raw.samples ?? 0} of your own comments. Not a persona menu.</p>
<div class="actions" style="margin-top:0">${runBtn("voice", "Measure again")}</div>
<div class="card"><p style="font-size:18px;margin:0">${esc(summary ?? "Nothing about your style is measurable yet, and nothing is being guessed.")}</p></div>
<div class="card">${rules.map((r) => `<div class="row">${esc(r)}</div>`).join("") || `<p class="sub">No rules yet.</p>`}</div>
<p class="sub" style="font-size:14px">Presence is decisive at one sample; absence is never decisive below five.
An unmeasured dimension emits no instruction at all, deliberately — the one exception is em dashes,
and one sample of you using one lifts it.</p>
<p class="sub" style="font-size:13px">Correct any line by editing <code>${esc(S.F("voice.json"))}</code>. What you say beats what was measured.</p>`);
};

/* --- Memory -------------------------------------------------------------- */

views["/memory"] = (url) => {
  const want = url.searchParams.get("file");
  const one = want ? readOne(P(), want) : null;
  if (want && !one) return render("/memory", "Memory", `<h1>Not one of the four</h1><p><a href="/memory">Back</a></p>`);

  if (one) return render("/memory", one.title, `
<h1>${esc(one.title)}</h1>
<p class="sub">${esc(one.what)}</p>
<form method="POST" action="/memory/save">
  <input type="hidden" name="file" value="${esc(one.file)}">
  <div class="field"><textarea name="body" spellcheck="true">${esc(one.body)}</textarea></div>
  <div class="actions" style="margin-top:0">
    <button class="primary" type="submit">Save ${esc(one.file)}</button>
    <a class="btn" href="/memory">Cancel</a>
    <span class="muted">${esc(S.F(one.file))}</span>
  </div>
</form>
${one.file === "rule.md" ? `<p class="sub" style="font-size:13px;margin-top:18px">Every verdict carries a hash of this file.
Change it and the queue may change — that is the point, and it is why the hash is stored.</p>` : ""}`);

  const files = readMemory(P());
  return render("/memory", "Memory", `
<h1>Memory</h1>
<p class="sub">Five markdown files on your disk. They decide who reaches your queue, how a draft sounds, and who the strategist is.
The model proposes them; you press Save. Nothing here is written without a keystroke behind it.</p>
${files.map((m) => `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(m.title)}</b>
${tag(m.filled ? "yours" : "still the seed", m.filled ? "ok" : "dim")}</div>
<p class="sub" style="margin:10px 0 0;font-size:14px">${esc(m.what)}</p>
<div class="actions" style="margin-top:12px">
  <a class="btn small" href="/memory?file=${esc(m.file)}">Edit ${esc(m.file)}</a>
  <span class="muted">${m.bytes} bytes</span></div>
</div>`).join("")}
<p class="sub" style="font-size:13px">These are also the agent's filesystem: the judge reads the same bytes you
edit here, not a copy marshalled through a prompt.</p>`);
};

/* --- Settings ------------------------------------------------------------ */

views["/settings"] = async () => {
  const key = readKey(P()), src = keySource(P()), p = plan(P()), PLAN = PLANS[p], pick = chosen(P());
  const flash = takeFlash();
  const local = localConfig(P());
  const probe = p === "local" ? await probeLocal(local.baseUrl) : null;
  const installed = probe?.ok ? probe.models : [];
  const menu = PLAN.menu;
  const keyCard = `<div class="card">
  <form method="POST" action="/settings/key">
    <div class="field">
      <label for="k">OpenRouter API key ${src === "env" ? "— currently coming from <code>OPENROUTER_API_KEY</code> in your environment" : ""}</label>
      <input id="k" type="password" name="key" placeholder="${key ? "•".repeat(24) + " (saved)" : "sk-or-…"}" ${src === "env" ? "disabled" : ""}>
    </div>
    <div class="actions" style="margin-top:0">
      <button class="primary" type="submit" ${src === "env" ? "disabled" : ""}>Save key</button>
      ${key && src === "file" ? `<button type="submit" name="key" value="" data-confirm="Remove the stored key?">Remove</button>` : ""}
      <span class="muted">${key ? "a key is set" : "no key set"}</span>
    </div>
  </form>
</div>`;
  const localCard = `<div class="card">
  <form method="POST" action="/settings/local">
    <div class="field">
      <label for="lu">Server address — anything that speaks OpenAI chat completions; Ollama's is the default</label>
      <input id="lu" type="url" name="baseUrl" value="${esc(local.baseUrl)}" placeholder="${esc(LOCAL_URL)}">
    </div>
    <div class="field">
      <label for="lk">Key, only if that server checks one</label>
      <input id="lk" type="password" name="key" placeholder="${local.key ? "•".repeat(12) + " (saved)" : "usually empty"}">
    </div>
    <div class="actions" style="margin-top:0">
      <button class="primary" type="submit">Save</button>
      ${local.key ? `<button type="submit" name="clearKey" value="1">Remove key</button>` : ""}
      <span class="${probe?.ok ? "ok" : "no"}" style="font-size:14px">${probe?.ok
        ? `reachable — ${installed.length} model${installed.length === 1 ? "" : "s"} installed`
        : esc(probe?.error ?? "")}</span>
    </div>
  </form>
  <p class="muted" style="margin:12px 0 0">With Ollama: <code>ollama pull ${esc(pick.judge)}</code> for each seat below, and start it with a
  window the scout can read a page into — <code>OLLAMA_CONTEXT_LENGTH=32768 ollama serve</code>. Its default window drops the
  start of a long page without saying so.</p>
</div>`;
  const quota = p === "paid"
    ? `Judging a hundred posts on the current pick costs about <b>${esc(money(judgeEstimate(P(), 100)))}</b>.`
    : p === "free"
      ? `Nothing here is billed. OpenRouter's limits on free variants, read off its docs 2026-09-01: <b>20 requests a minute and 50 a day</b>,
         or 1,000 a day once $10 of credit has ever been bought on the account. A judge batch is one request per five posts; a scout run is
         one per page it reads. A provider being full (a 429 from upstream) is ordinary here — the fallbacks exist for exactly that.`
      : `Nothing here is billed and nothing leaves this machine. The cost is time: a 9B model on a CPU takes minutes per judge batch,
         not seconds, and the strip at the top of the page is what tells you it is working rather than stuck.`;
  return render("/settings", "Settings", `
<h1>Settings</h1>

<h2>Where the models run</h2>
<p class="sub">Everything that reads Reddit needs none of this. The scout, the judge and the writer need a model,
and there are three places to get one.</p>
<div class="grid">
${Object.values(PLANS).map((q) => `<div class="card" style="margin:0${q.key === p ? ";border-top:6px solid var(--lime)" : ""}">
  <div class="row" style="border:0;padding:0"><b>${esc(q.title)}</b>${q.key === p ? tag("in use", "ok") : ""}</div>
  <p class="sub" style="margin:10px 0 12px;font-size:14px">${esc(q.what)}</p>
  <form method="POST" action="/settings/plan"><input type="hidden" name="plan" value="${esc(q.key)}">
    <button class="small ${q.key === p ? "" : "primary"}" type="submit" ${q.key === p ? "disabled" : ""}>${q.key === p ? "In use" : "Use this"}</button></form>
</div>`).join("")}
</div>

<h2 style="margin-top:24px">${p === "local" ? "Your server" : "OpenRouter"}</h2>
<p class="sub">${p === "local"
    ? "Any OpenAI-compatible server on this machine or your network. No key unless it wants one."
    : `${p === "free" ? `The free models need a key too — a free one, no card, nothing ever charged: <a href="${KEY_URL}" rel="noreferrer noopener" target="_blank">openrouter.ai/keys</a>.` : "Your key, on your machine, for your bill."} There is nothing to install; the key is the only requirement.`}</p>
${p === "local" ? localCard : keyCard}

<h2>Models</h2>
<p class="sub">${p === "paid"
    ? "Balanced means the cheap fast model does the volume work and the good writer only writes. Prices are per million tokens, read off OpenRouter on 2026-08-30."
    : p === "free"
      ? "Picked on a measurement, 2026-09-01: the same two-item verdict on every free model that takes a tool call. The notes carry the numbers, including the ones that were full."
      : "Tags on your server. The suggestions are sized for a 16 GB machine and are not measured — this project has had no local box to measure on. When you have numbers, the note is where they go."}</p>
${Object.values(ROLES).map((r) => {
  const cur = pick[r.key];
  const info = modelInfo(p, cur);
  const alt = alternatesFor(r.key, p).filter((a) => a !== cur);
  const options = p === "local"
    ? [...new Set([cur, ...installed, ...Object.keys(menu)])].map((id) =>
        `<option value="${esc(id)}" ${id === cur ? "selected" : ""}>${esc(id)}${installed.includes(id) ? " — installed" : menu[id] ? " — suggested" : ""}</option>`).join("")
    : Object.values(menu).map((m) =>
        `<option value="${esc(m.id)}" ${m.id === cur ? "selected" : ""}>${esc(m.label)} — ${p === "free" ? "free" : `$${m.in}/$${m.out} per M`}</option>`).join("");
  const pulled = p !== "local" || !probe?.ok || installed.includes(cur);
  return `<div class="card">
  <div class="row" style="border:0;padding:0"><b>${esc(r.title)}</b>
    <span class="muted">${esc(info.label)}${pulled ? "" : ` — not pulled yet: <code>ollama pull ${esc(cur)}</code>`}</span></div>
  <p class="sub" style="margin:10px 0 12px;font-size:14px">${esc(r.what)}</p>
  <form method="POST" action="/settings/model" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <input type="hidden" name="role" value="${esc(r.key)}">
    <select name="model" style="max-width:320px">${options}</select>
    ${p === "local" ? `<input type="text" name="custom" placeholder="or any tag: qwen3.5:27b" style="max-width:220px">` : ""}
    <button class="small" type="submit">Use this</button>
  </form>
  <p class="muted" style="margin:10px 0 0">${esc(info.note)}${alt.length ? ` Falls back to ${esc(alt.join(", "))} on an error.` : ""}</p>
</div>`;
}).join("")}
<p class="sub" style="font-size:14px">${quota}</p>

<h2>Sharing this machine's reading</h2>
<p class="sub">Reading a source costs a minute a request. If several people watch the same rooms, this machine
can read them once and the rest can take what it found — <b>public posts only</b>. Everyone still judges
against their own <code>rule.md</code>, on their own machine, with their own key.</p>
<div class="card">
  <p class="sub" style="font-size:14px;margin-top:0">Run the feed on its own port:
    <code>npm run hub</code> — then point a tunnel at <code>127.0.0.1:8788</code>.
    <b>Never tunnel to this dashboard</b>: 8787 has your prospects, your memory and this key form on it.</p>
  ${flash.token ? `<div class="note"><b>New token for &ldquo;${esc(flash.label ?? "client")}&rdquo;. Copy it now — it is not stored in the clear and cannot be shown again.</b>
    <div class="log" style="margin-top:10px">${esc(flash.token)}</div>
    <p class="sub" style="font-size:13px;margin:10px 0 0">On the client:
      <code>node bin/mq.mjs pull https://your-tunnel --token &lt;that&gt;</code></p></div>` : ""}
  ${tokens(P()).length ? `<table><thead><tr><th>Client</th><th>Issued</th><th></th></tr></thead><tbody>
  ${tokens(P()).map((t) => `<tr><td><b>${esc(t.label)}</b></td><td class="muted">${esc(ago(t.added))}</td>
    <td class="right"><form method="POST" action="/settings/token/revoke">
      <input type="hidden" name="sha" value="${esc(t.sha)}"><input type="hidden" name="back" value="/settings">
      <button class="small" data-confirm="Revoke ${esc(t.label)}? That client stops receiving the feed immediately.">Revoke</button>
    </form></td></tr>`).join("")}</tbody></table>` : `<p class="sub">No clients yet.</p>`}
  <form method="POST" action="/settings/token" style="display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap">
    <input type="hidden" name="back" value="/settings">
    <input type="text" name="label" placeholder="who is this for — laptop, Sam, client-3" style="max-width:320px">
    <button class="small" type="submit">Issue a token</button>
  </form>
</div>

<h2>Account</h2>
<p class="sub">Whose comments Messaging Quest reads back as a stranger. Only your own account is ever read,
and nothing is ever posted.</p>
<div class="card">
  <form method="POST" action="/api/run">
    <input type="hidden" name="verb" value="me">
    <input type="hidden" name="back" value="/settings">
    <div class="field"><label for="u">Your ${esc(LB().name)} username</label>
      <input id="u" type="text" name="a0" value="${esc(acct()?.name ?? "")}" placeholder="your-username"></div>
    <div class="actions" style="margin-top:0"><button class="primary" type="submit">Save</button>
      <span class="muted">${acct()?.name ? `currently u/${esc(acct().name)}` : "not set"}</span></div>
  </form>
</div>

<h2>This machine</h2>
<div class="card">
  <div class="row"><span>Data directory</span><code>${esc(S.F("").replace(/[\\/]$/, ""))}</code></div>
  <div class="row"><span>Bound to</span><code>127.0.0.1:${PORT}</code></div>
  <div class="row"><span>Reddit reads</span><span class="sub">logged out, one a minute, never posting</span></div>
</div>
<div class="actions">${runBtn("sweep", "Drop stored bodies past 48h", { confirm: "Drop stored post bodies older than 48 hours? Ids, dates and history are kept." })}
<a class="btn" href="/jobs">Job history</a></div>`);
};

/* --- Setup --------------------------------------------------------------- */

const SETUP_STEPS = ["Your account", "Your product", "Confirm", "First room"];

views["/setup"] = (url) => {
  const a = acct();
  const prog = memoryProgress(P());
  const scoutJob = url.searchParams.get("job");
  const job = scoutJob ? J.get(scoutJob) : null;
  const proposal = scoutJob ? J.result(scoutJob) : null;

  // Step 1 — who you are on Reddit.
  if (!a?.name) return render("/setup", "Set up", `
${steps(SETUP_STEPS, 0)}
<h1>Which account is yours?</h1>
<p>Messaging Quest reads your own public profile the way a logged-out stranger reads it, so the first thing it needs
is the name to read. Nothing is posted, nothing is sent, and only your own account is read.</p>
<div class="card"><form method="POST" action="/api/run">
  <input type="hidden" name="verb" value="me">
  <div class="field"><label for="u">Your ${esc(LB().name)} username</label>
    <input id="u" type="text" name="a0" placeholder="your-username" required></div>
  <button class="primary" type="submit">That's me</button>
</form></div>
<p class="sub" style="font-size:14px">Do not have one to hand? You can still use the finding half —
<a href="/sources">probe a room</a> — but the visibility half needs an account to read.</p>`);

  // Step 2 — read the site.
  if (!prog.files.find((f) => f.file === "project.md").filled && !proposal) {
    const running = job?.status === "running";
    return render("/setup", "Set up", `
${steps(SETUP_STEPS, 1)}
<h1>What do you sell?</h1>
<p>Paste your own site. The scout reads it and the handful of pages it links to — pricing, product, about —
and proposes the three files every later verdict is judged by. It proposes; you press Save.</p>
${!hasModel(P()) ? `<div class="note"><b>This step needs a model.</b>
  <a href="/settings">Add an OpenRouter key or pick Local</a> and come back, or
  <a href="/memory">write the three files yourself</a> — the tool does not care which.</div>` : ""}
<div class="card">
  <form method="POST" action="/setup/scout">
    <div class="field"><label for="site">Your website</label>
      <input id="site" type="url" name="url" placeholder="https://example.com" required ${hasModel(P()) ? "" : "disabled"}></div>
    <button class="primary" type="submit" ${hasModel(P()) && !running ? "" : "disabled"}>${running ? "Reading…" : "Read my site"}</button>
  </form>
</div>
${job ? `<div class="card"><h2 style="margin-top:0">${esc(job.status === "running" ? "Reading" : job.status)}</h2>
  <div class="log">${esc((job.lines ?? []).slice(-40).join("\n"))}</div>
  ${job.error ? `<p class="no">${esc(job.error)}</p>` : ""}</div>` : ""}
<p class="sub" style="font-size:14px">Rather type it? <a href="/memory">Write the four files by hand.</a></p>`);
  }

  // Step 3 — confirm what it found.
  if (proposal) return render("/setup", "Set up", `
${steps(SETUP_STEPS, 2)}
<h1>Is this right?</h1>
<p>Read all three before you run anything: everything downstream is judged by them.
${proposal.unknown?.length ? `The scout could not find ${proposal.unknown.length} thing${proposal.unknown.length === 1 ? "" : "s"} on your site — they are listed at the bottom.` : ""}</p>
<form method="POST" action="/setup/save">
  <div class="card"><h2 style="margin-top:0">What you sell — project.md</h2>
    <div class="field"><textarea name="project_md" spellcheck="true">${esc(proposal.project_md ?? "")}</textarea></div></div>
  <div class="card"><h2 style="margin-top:0">Who it is for — icp.md</h2>
    <div class="field"><textarea name="icp_md" spellcheck="true">${esc(proposal.icp_md ?? "")}</textarea></div></div>
  <div class="card"><h2 style="margin-top:0">The fit rule — rule.md</h2>
    <p class="sub" style="font-size:14px">This one decides who reaches your queue. Every verdict is stamped with a hash of it.</p>
    <div class="field"><textarea name="rule_md" spellcheck="true">${esc(proposal.rule_md ?? "")}</textarea></div></div>
  ${proposal.unknown?.length ? `<div class="note"><b>The site did not say:</b><ul>${proposal.unknown.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>
    Fill those in rather than letting the scout guess — a rule built on a guess drops real people for months.</div>` : ""}
  <div class="actions"><button class="primary" type="submit">Save all three</button>
    <a class="btn" href="/setup">Start over</a></div>
</form>`);

  // Step 4 — somewhere to look.
  const srcs = S.sources();
  if (!srcs.length) return render("/setup", "Set up", `
${steps(SETUP_STEPS, 3)}
<h1>Where should it look?</h1>
<p>One room to start. Probe it first — that is one read and no commitment — then read its rules, judge what came
back, and commit it if it clears the floor.</p>
<div class="card">
  <form method="POST" action="/api/run">
    <input type="hidden" name="verb" value="probe">
    <div class="field"><label for="s-sub">Subreddit</label>
      <input id="s-sub" type="text" name="a0" placeholder="smallbusiness" required></div>
    <input type="hidden" name="a1" value="--q">
    <div class="field"><label for="s-q">The phrase somebody types when they have the problem</label>
      <input id="s-q" type="text" name="a2" placeholder="how do I get clients"></div>
    <button class="primary" type="submit">Probe it</button>
  </form>
</div>
<p class="sub" style="font-size:14px">Not sure where? <a href="/memory?file=icp.md">icp.md</a> is where the answer
should be written down, and the scout usually has a guess in it.</p>`);

  return render("/setup", "Set up", `
${steps(SETUP_STEPS, 4)}
<h1>You are set up</h1>
<p>${prog.done} of ${prog.total} memory files answered, ${srcs.length} source${srcs.length === 1 ? "" : "s"} watched.</p>
<div class="actions">
  <a class="btn primary" href="/queue">Go to the queue</a>
  ${runBtn("tick", "Read what is due")}
  ${runBtn("sync", "Read my own profile")}
  <a class="btn" href="/memory">Review the memory</a>
</div>`);
};

/* --- Jobs ---------------------------------------------------------------- */

views["/jobs"] = () => {
  const live = J.list();
  const past = J.history(60);
  return render("/jobs", "Jobs", `
<h1>Jobs</h1>
<p class="sub">Everything that reads Reddit is long and rate-limited — a minute a request, measured. This is where it runs.</p>
${live.length ? `<h2>This session</h2>${live.map((j) => `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(j.label)}</b>
${tag(j.status, j.status === "ok" ? "ok" : j.status === "error" ? "no" : "sig")}</div>
<p class="muted" style="margin:8px 0">${esc(j.note ?? "")} · started ${esc(ago(j.startedAt))}</p>
${j.lines?.length ? `<div class="log">${esc(j.lines.slice(-30).join("\n"))}</div>` : ""}
</div>`).join("")}` : `<p class="sub">Nothing has run in this session.</p>`}
${past.length ? `<h2>Earlier</h2><table><thead><tr><th>What</th><th>Status</th><th>When</th></tr></thead><tbody>
${past.map((j) => `<tr><td>${esc(j.label ?? j.verb)}</td>
<td>${tag(j.status, j.status === "ok" ? "ok" : j.status === "error" ? "no" : "dim")}</td>
<td class="muted">${esc(ago(j.startedAt))}</td></tr>`).join("")}</tbody></table>` : ""}`);
};

/* --- Tasks ---------------------------------------------------------------- */

// Colleagues at work, and the ones installed. The deck is where a task's
// QUESTION is answered (one card at a time); this is where its log is read,
// where one is started by hand, and where it is stopped.
views["/tasks"] = () => {
  const fl = takeFlash();
  if (!RT()) return render("/tasks", "Tasks", `
<h1>Tasks</h1>
<p class="sub">Colleagues at work in your own browser — each on its own thread, in a tab it leased.</p>
<div class="note"><b>The runtime is not installed.</b> Colleagues run on the brain: <code>npm run brain</code> installs
<code>agent/</code> (Deep Agents, LangGraph and the SQLite checkpointer) and everything else keeps working without it.
${WHY() ? `<br><span class="muted">${esc(WHY())}</span>` : ""}</div>`);
  const tasks = RT().list();
  const cols = RT().colleagues();
  const live = tasks.filter((t) => /^(running|blocked)$/.test(t.status));
  const rest = tasks.filter((t) => !live.includes(t)).slice(0, 20);
  const tone = (s) => (s === "done" ? "ok" : /failed|cancelled/.test(s) ? "no" : s === "blocked" ? "sig" : "dim");
  const row = (t) => `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(t.title)}</b> ${tag(t.status, tone(t.status))}</div>
<p class="muted" style="margin:8px 0">${esc(t.agent)} · started ${esc(ago(t.startedAt))}${t.lease ? ` · tab ${esc(String(t.lease.tabId))} at ${esc(t.lease.url ?? "")}` : ""}${t.finishedAt ? ` · finished ${esc(ago(t.finishedAt))}` : ""}</p>
${t.status === "blocked" ? `<div class="note"><b>Waiting on you:</b> ${esc((t.questions ?? []).map((q) => q.question).join(" · "))} — <a href="/panel/">answer it on the panel</a></div>` : ""}
${t.result ? `<div class="said">${esc(t.result)}</div>` : ""}
${t.error ? `<p class="no" style="margin-top:10px">${esc(t.error)}</p>` : ""}
${t.shot ? `<img src="/api/tasks/${esc(t.id)}/screenshot" alt="what the task saw" style="max-width:100%;border:1.5px solid var(--ink);margin:10px 0;display:block">` : ""}
${t.log?.length ? `<div class="log" style="margin-top:10px">${esc(t.log.slice(-30).join("\n"))}</div>` : ""}
<div class="actions">
  ${/^(running|blocked)$/.test(t.status) ? `<form method="POST" action="/tasks/cancel"><input type="hidden" name="id" value="${esc(t.id)}"><button class="small" data-confirm="Stop ${esc(t.title)}? Its tab closes.">Stop</button></form>` : ""}
  ${/^(done|failed)$/.test(t.status) && !t.acked ? `<form method="POST" action="/tasks/ack"><input type="hidden" name="id" value="${esc(t.id)}"><button class="small">Dismiss</button></form>` : ""}
</div></div>`;
  const startForm = cols.length ? `<div class="card">
<h2 style="margin-top:0">Start a colleague</h2>
${fl.taskError ? `<div class="note"><b>Not started:</b> ${esc(fl.taskError)}</div>` : ""}
<form method="POST" action="/tasks/start">
  <div class="field"><label for="t-agent">Colleague</label>
    <select id="t-agent" name="agent">${cols.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} — ${esc(c.description)}</option>`).join("")}</select></div>
  <div class="field"><label for="t-url">Page to open — a browser colleague starts there, in a tab of your own Chrome</label>
    <input id="t-url" type="url" name="url" placeholder="https://…"></div>
  <div class="field"><label for="t-brief">Brief — what to do, in a sentence</label>
    <input id="t-brief" type="text" name="brief" placeholder="Read this page and tell me what it sells"></div>
  <button class="primary" type="submit" ${hasModel(P()) ? "" : `disabled title="no model — pick one on Settings"`}>Start</button>
  ${hasModel(P()) ? "" : `<span class="muted">Needs a model: <a href="/settings">Settings</a>.</span>`}
</form></div>` : `<div class="note">No colleagues installed. A colleague is <code>skills/&lt;id&gt;/agent.md</code> beside its SKILL.md — copy
<code>skills/_template/</code> into <code>${esc(DATA)}/skills/&lt;id&gt;/</code> to try the template one, which reads a page and asks before reading a second.</div>`;
  return render("/tasks", "Tasks", `
<h1>Tasks</h1>
<p class="sub">Readers at work in your own browser, each in a tab of the &ldquo;Messaging Quest&rdquo; group. The specialist proposes
these on the panel; this page starts one by hand and keeps the logs. Silence means it is working; a question lands on the panel as a card;
stopping one closes its tab.</p>
${startForm}
${live.length ? `<h2>Now</h2>${live.map(row).join("")}` : ""}
${rest.length ? `<h2>Earlier</h2>${rest.map(row).join("")}` : ""}
<h2>Colleagues installed</h2>
${cols.length ? `<table><thead><tr><th>colleague</th><th>tools</th><th>seat</th><th>ring</th></tr></thead><tbody>
${cols.map((c) => `<tr><td><b>${esc(c.name)}</b><br><span class="muted">${esc(c.description)}</span></td>
  <td class="muted">${esc(c.tools.join(", "))}${c.grants.some((g) => g !== "read") ? ` <b class="no">— may ${esc(c.grants.filter((g) => g !== "read").join(" and "))}</b>` : ""}</td>
  <td>${esc(c.model)}</td><td>${tag(c.ring === "local" ? "yours" : "built-in")}</td></tr>`).join("")}</tbody></table>` : `<p class="sub">None yet.</p>`}
<p class="sub" style="font-size:13px">No colleague is granted click or type in this milestone: every browser call is screened against its <code>tools:</code> line here,
and every click against the label screen in the extension. A refusal says which rule refused it.</p>`, { refresh: live.length ? 5 : 0 });
};

/* ------------------------------------------------------------------ writes */

/** Verbs the browser may start, and what to call them while they run. Anything
 *  not on this list is not startable from a page — the router does not look the
 *  name up anywhere else. */
const SPAWNABLE = {
  me: "Setting your username",
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
        const { judgeItems } = await import("../lib/agents.mjs");
        const rule = readFileSync(S.F("rule.md"), "utf8");
        const verdicts = await judgeItems(dir, items, rule, ctl);
        // Nothing back is a failure, not a quiet success: the first live judge
        // run on the free plan finished "ok" in 0.8s with every batch refused
        // (400, a fallback list one entry too long) and the only trace was a
        // log the job store does not keep.
        if (!verdicts.length) throw new Error(`no verdicts came back — ${verdicts.failed?.[0] ?? "nothing written"}`);
        // Hand them to the CLI rather than appending here: `mq judge` is what
        // stamps the rubric hash, clears pending and settles the probe, and two
        // implementations of that is how a queue starts disagreeing with itself.
        ctl.log(`\nwriting ${verdicts.length} verdicts`);
        await runEs("judge", [], { stdin: JSON.stringify(verdicts), ctl });
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
        // `mq draft <id>` already builds the whole thing — the post, the measured
        // voice, the community's risks, the three-moves instruction. It printed
        // it for a human to paste. This sends it.
        // Everything after the id rides through: "--note <text>" is the
        // operator's critique of the last draft (the rewrite card).
        const prompt = await capture("draft", [id, ...args.slice(1)]);
        const note = args.includes("--note") ? String(args[args.indexOf("--note") + 1] ?? "") : "";
        const style = args.includes("--style") ? String(args[args.indexOf("--style") + 1] ?? "") : "";
        if (note) ctl.log(`with the operator's note on the last round${style ? ` (the ${style} draft)` : ""}`);
        const { draftReply } = await import("../lib/agents.mjs");
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
        // through the CLI rather than appending a draft row here.
        ctl.log(`\nsaving the round, and running the refusals over each`);
        await runEs("draft", [id, "--save"], { stdin: JSON.stringify({ drafts, ...(note ? { note, style } : {}) }), ctl });
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
setInterval(autoJudge, 10_000).unref();

/* --- Skills -------------------------------------------------------------- */

// What is installed, what is running, and what is stuck — with the fix on the
// same screen. Two skills may serve one purpose; which one runs is chosen
// here (or in <dir>/skills.json, same file), never guessed.
views["/skills"] = () => {
  const st = skillState();
  const choices = readChoices(P());
  const seatsOf = (s) => Object.keys(s.seats).join(", ") || "knowledge";
  const ringTag = (r) => tag(r === "local" ? "yours" : "built-in");
  const conflictCard = (c) => `<div class="card">
    <b>${esc(c.slot)}</b> — nothing is running this
    <p class="sub">${esc(c.why)}</p>
    ${c.candidates.map((id) => `<form method="POST" action="/skills/choose" style="display:inline-block;margin-right:8px">
      <input type="hidden" name="slot" value="${esc(c.slot)}">
      <input type="hidden" name="id" value="${esc(id)}">
      <button class="btn">Use ${esc(id)}</button>
    </form>`).join("")}
  </div>`;
  const chosenRows = Object.entries(choices).map(([slot, id]) => `<tr><td>${esc(slot)}</td><td>${esc(id)}</td>
    <td><form method="POST" action="/skills/choose"><input type="hidden" name="slot" value="${esc(slot)}">
    <button class="small" type="submit">Clear</button></form></td></tr>`).join("");
  return render("/skills", "Skills", `
<h1>Skills</h1>
<p class="sub">Everything optional is a folder: a platform to read, a page on this dashboard, a hand for the
strategist — or plain knowledge. Built-ins ship in <code>skills/</code>; yours load from <code>${esc(P())}/skills/</code>
and win on a name collision. When two skills serve one purpose, you pick which one runs — here.</p>
${st.conflicts.length ? `<h2>Needs a decision</h2>${st.conflicts.map(conflictCard).join("")}` : ""}
<h2>Running</h2>
<table><tr><th>skill</th><th>ring</th><th>fills</th><th>carries</th></tr>
${st.active.map((s) => `<tr><td><b>${esc(s.name)}</b> <span class="sub">${esc(s.id)}</span></td>
  <td>${ringTag(s.ring)}</td><td>${esc(s.provides ?? "—")}</td><td>${esc(seatsOf(s))}</td></tr>`).join("")}
</table>
${chosenRows ? `<h2>Choices on file</h2><table><tr><th>slot</th><th>uses</th><th></th></tr>${chosenRows}</table>` : ""}
${st.refused.length ? `<h2>Refused to load</h2>${st.refused.map((r) =>
  `<p class="sub"><b>${esc(r.id)}</b> (${esc(r.ring)}) — ${esc(r.why)}</p>`).join("")}` : ""}
<h2>Writing one</h2>
<p class="sub">A skill is a folder with a SKILL.md; the contract, the seats and a template live in the repo —
see <code>skills/README.md</code> and <code>CONTRIBUTING.md</code>. Drop your folder into
<code>${esc(P())}/skills/</code> and reload; ship it to everybody with a pull request.</p>`);
};

const writes = {
  "/mark": (form) => {
    const id = form.get("id"), mark = form.get("mark");
    if (!["sent", "skip", "undo"].includes(mark)) return "/queue";
    const it = S.found().get(id);
    if (!it) return "/queue";
    S.append("marks.jsonl", { id, mark, at: new Date().toISOString(), via: "dashboard" });
    if (mark === "sent") openConversation(S, it, { text: S.drafts().filter((d) => d.id === id).pop()?.text ?? "", via: "dashboard" });
    if (mark === "sent" && it.author) S.append("contacted.jsonl", { author: it.author, id, at: new Date().toISOString() });
    // Undoing a send has to lift the retirement too, or the person stays
    // invisible forever and the undo is a lie.
    if (mark === "undo" && it.author)
      S.append("contacted.jsonl", { author: it.author, id, at: new Date().toISOString(), removed: true });
    return mark === "undo" ? "/people?view=sent" : "/queue";
  },

  "/people/undo": (form) => {
    const author = String(form.get("author") ?? "").trim();
    if (author) S.append("contacted.jsonl", { author, at: new Date().toISOString(), removed: true });
    return "/people?view=contacted";
  },

  "/room": (form) => {
    const place = String(form.get("place") ?? "").replace(/[^\w-]/g, "");
    const answer = form.get("answer") === "yes" ? "yes" : "no";
    if (!place) return "/rooms";
    const existing = existsSync(S.roomPath(place)) ? readFileSync(S.roomPath(place), "utf8") : roomFile(place, null, { label: LB().room(place), rulesUrl: LB().rulesUrl(place) });
    S.writeRoom(place, existing.replace(/^promotion_allowed:.*$/mi, `promotion_allowed: ${answer}`));
    return "/rooms";
  },

  "/memory/save": (form) => {
    const file = String(form.get("file") ?? "");
    try { writeMemory(P(), file, form.get("body") ?? ""); } catch { return "/memory"; }
    return "/memory";
  },

  "/settings/key": (form) => {
    try { writeKey(P(), form.get("key") ?? ""); } catch { /* shown by the empty state */ }
    return "/settings";
  },

  "/settings/model": (form) => {
    // A typed tag (local plan) beats the select; an unknown id on OpenRouter
    // is ignored and the page keeps showing what actually runs.
    try { choose(P(), String(form.get("role")), String(form.get("custom") || form.get("model") || "")); } catch { /* unknown ids ignored */ }
    return "/settings";
  },
  "/settings/plan": (form) => {
    try { setPlan(P(), String(form.get("plan"))); } catch { /* not a plan — the page shows which one runs */ }
    return "/settings";
  },
  "/settings/local": (form) => {
    // An empty key field means "leave it as it is"; the Remove button clears it.
    const key = form.get("clearKey") ? "" : (String(form.get("key") ?? "").trim() || undefined);
    try { setLocal(P(), { baseUrl: String(form.get("baseUrl") ?? ""), key }); } catch { /* a bad address is refused; the page keeps the old one */ }
    return "/settings";
  },

  "/settings/token": (form) => {
    const label = String(form.get("label") ?? "").trim() || "client";
    // Into the flash, never into the redirect: the token must not appear in a
    // URL, and this is the one moment it exists in the clear.
    flash = { token: issueToken(P(), label), label };
    return "/settings";
  },

  "/settings/token/revoke": (form) => {
    revokeToken(P(), String(form.get("sha") ?? ""));
    return "/settings";
  },

  "/setup/scout": (form) => {
    const url = String(form.get("url") ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return "/setup";
    const started = J.run("scout", async (ctl) => {
      const { scoutSite } = await import("../lib/agents.mjs");
      return await scoutSite(P(), url, ctl, { browse: browser(SELF(), { task: "reading your site", project: P() }) });
    }, { label: "Reading your site" });
    return started.error ? "/setup" : `/setup?job=${started.id}`;
  },

  "/setup/save": (form) => {
    for (const [field, file] of [["project_md", "project.md"], ["icp_md", "icp.md"], ["rule_md", "rule.md"]]) {
      const body = form.get(field);
      if (body && String(body).trim()) writeMemory(P(), file, body);
    }
    return "/setup";
  },

  "/api/run": (form) => {
    const verb = String(form.get("verb") ?? "");
    const args = [];
    for (let i = 0; i < 6; i++) {
      const v = form.get(`a${i}`);
      if (v === null) continue;
      const s = String(v).trim();
      if (s) args.push(s.slice(0, 200));
    }
    if (AGENTIC[verb]) { startAgentic(verb, args); return null; }
    if (!SPAWNABLE[verb]) return null;
    J.spawn(verb, args, { label: SPAWNABLE[verb] });
    return null;   // null means "back where you came from"
  },

  "/api/cancel": (form) => { J.cancel(String(form.get("id") ?? "")); return null; },

  /* Colleagues, from the dashboard: start one on a page with a brief, stop
   * one, dismiss a finished one. The same runtime the deck's cards drive. */
  "/tasks/start": (form) => {
    if (!RT()) return "/tasks";
    const agent = String(form.get("agent") ?? "").trim();
    const url = String(form.get("url") ?? "").trim();
    const brief = String(form.get("brief") ?? "").trim().slice(0, 600);
    const title = String(form.get("title") ?? "").trim().slice(0, 80) || (brief ? brief.slice(0, 60) : null);
    RT().start(agent, { ...(url ? { url } : {}), ...(brief ? { brief } : {}) }, { title })
      .then((r) => { if (r.error) flash = { taskError: r.error }; })
      .catch((e) => { flash = { taskError: String(e?.message ?? e) }; });
    return "/tasks";
  },
  "/tasks/cancel": (form) => { RT()?.cancel(String(form.get("id") ?? "")); return "/tasks"; },
  "/tasks/ack": (form) => { RT()?.ack(String(form.get("id") ?? "")); return "/tasks"; },

  /* Campaigns, by hand: the file is the operator's, written by their Save. */
  "/campaigns/save": (form) => {
    const id = String(form.get("id") ?? "");
    const prior = readCampaign(P(), id);
    const r = writeCampaign(P(), { id, name: String(form.get("name") ?? prior?.name ?? ""), idea: String(form.get("idea") ?? ""), fit: String(form.get("fit") ?? ""), never: String(form.get("never") ?? ""), voice: String(form.get("voice") ?? ""), mention: String(form.get("mention") ?? "never"), status: prior?.status ?? "active", platform: prior?.platform ?? first()?.id ?? null });
    if (r.error) flash = { campaignError: r.error };
    return "/campaigns";
  },
  "/campaigns/status": (form) => {
    const r = setCampaignStatus(P(), String(form.get("id") ?? ""), String(form.get("status") ?? ""));
    if (r.error) flash = { campaignError: r.error };
    return "/campaigns";
  },
  "/campaigns/propose": (form) => {
    const d = campaignDraft({ name: form.get("name"), idea: form.get("idea"), fit: form.get("fit"), voice: form.get("voice"), place: form.get("place"), q: form.get("q"), mention: form.get("mention"), platform: first()?.id ?? null });
    if (!d.name || !d.idea) { flash = { campaignError: "a campaign needs a name and an idea" }; return "/campaigns"; }
    if (readCampaign(P(), d.id)) { flash = { campaignError: `a campaign "${d.id}" already exists — edit it above` }; return "/campaigns"; }
    if (form.get("how") === "save") {
      const r = writeCampaign(P(), { ...d, status: "active" });
      if (r.error) { flash = { campaignError: r.error }; return "/campaigns"; }
      INBOX({ type: "campaign.created", title: `“${r.name}” (${r.id}), written by hand on the dashboard — no room probed yet`, campaign: r.id, place: d.place || null, q: d.q || null });
      return "/campaigns";
    }
    // Onto the panel: the same cards the specialist's proposal walks through.
    patchStash(P(), { campaign_draft: { ...d, by: "you", done: [] } });
    return "/panel/";
  },

  /* Projects: make one and switch, or switch. */
  "/projects/new": (form) => {
    const r = createProject(DATA, String(form.get("name") ?? ""));
    if (r.error) { flash = { projectError: r.error }; return "/projects"; }
    afterSwitch();
    return "/panel/";
  },
  "/projects/use": (form) => {
    const r = useProject(DATA, String(form.get("id") ?? ""));
    if (r.error) flash = { projectError: r.error }; else afterSwitch();
    return "/projects";
  },
};

/* --------------------------------------------------------- cards + agent */

// The deck: the same state the dashboard's views render, folded into "the one
// next action" (lib/cards.mjs). The extension's side panel lives on these two
// endpoints; the dashboard and a future relay read the same JSON. JSON-only
// POSTs on purpose: a cross-origin page cannot send application/json without a
// CORS preflight, and nothing here answers preflights — so the browser's own
// rules keep a stranger's tab from pressing these buttons, the same way
// same-origin forms protect the HTML writes above.

/** This server's own address — where a child, the site scout and the
 *  strategist reach the control lane. Set at listen. */
const SELF = () => process.env.MQ_SERVER ?? `http://127.0.0.1:${PORT}`;

const startScout = (siteUrl) => {
  const started = J.run("scout", async (ctl) => {
    const { scoutSite } = await import("../lib/agents.mjs");
    // The site is read in the operator's own browser, like everything else.
    return await scoutSite(P(), siteUrl, ctl, { browse: browser(SELF(), { task: "reading your site", project: P() }) });
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
  const spawn = (verb, args = []) => { J.spawn(verb, args, { label: SPAWNABLE[verb] }); return { ok: true }; };
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
    const place = t.replace(/^r\//i, "").replace(/[^\w-]/g, "");
    if (!place) return { error: "name a subreddit" };
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

/* ------------------------------------------------------------------ server */

// same-origin, not no-referrer: the action buttons need to know which page they
// were pressed on, and a header the browser refuses to send cannot tell them.
// Reddit still learns nothing — cross-origin requests get no referrer under
// this policy, and every outbound link also carries rel="noreferrer".
const HTML = { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "referrer-policy": "same-origin" };

/** Where a POST should send the browser next. An explicit `back` field wins,
 *  then the referrer, then home. Anything not a local absolute path is refused
 *  outright — `//evil.example` is a valid Location and is not a local path. */
const backTo = (form, req) => {
  const want = String(form.get("back") ?? "");
  if (/^\/(?!\/)/.test(want)) return want;
  const ref = req.headers.referer ?? "";
  const origin = `http://127.0.0.1:${PORT}`;
  if (ref.startsWith(origin)) return ref.slice(origin.length) || "/";
  return "/";
};

const JSON_HEAD = { "content-type": "application/json", "cache-control": "no-store" };

/** Which project the deck belongs to, and the others — the panel's picker. */
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
      platform: { id: first()?.id ?? null, name: L.name },
    },
  };
}

/** Every button on the panel's tabs. `do` names it; the rest is its input.
 *  Returns {ok} or {error} — the panel re-reads the state either way. */
async function panelAct(body = {}) {
  const dir = P();
  const act = String(body.do ?? "");
  const s = (v, n = 200) => String(v ?? "").trim().slice(0, n);
  const spawnOnce = (verb, args = []) => { const r = J.spawn(verb, args, { label: SPAWNABLE[verb] }); return r?.error ? { error: `${SPAWNABLE[verb] ?? verb} is already running` } : { ok: true }; };
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
    case "account": { const name = s(body.name, 60).replace(/^u\//, ""); if (!name) return { error: "no username" }; return spawnOnce("me", [name]); }
    case "project.use": return switchProject({ action: "use", id: body.id });
    case "project.new": return switchProject({ action: "new", name: body.name });
    default: return { error: `not a thing the panel can do: ${act || "(nothing)"}` };
  }
}

/** Read a JSON body, refusing anything that is not declared as one. The
 *  declaration is the CSRF boundary: a cross-origin page cannot send
 *  application/json without a preflight, and nothing here answers preflights. */
const jsonBody = (req) =>
  new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers["content-type"] ?? "")) return reject(new Error("json only"));
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("bad json")); } });
  });

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  /* The deck — what the extension's side panel lives on. */
  if (url.pathname === "/api/cards" && req.method === "GET") {
    let body;
    try {
      const cards = nextCards(cardSnapshot());
      body = JSON.stringify({
        cards,
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
      });
    } catch (e) {
      console.error(e);
      return res.writeHead(500, JSON_HEAD).end(JSON.stringify({ error: e.message }));
    }
    return res.writeHead(200, JSON_HEAD).end(body);
  }

  /* Projects: which one the deck is, and switching or making one. */
  if (url.pathname === "/api/projects" && req.method === "GET")
    return res.writeHead(200, JSON_HEAD).end(JSON.stringify(projectSummary()));
  if (url.pathname === "/api/projects" && req.method === "POST") {
    return jsonBody(req)
      .then((body) => { const out = switchProject(body ?? {}); res.writeHead(out.error ? 400 : 200, JSON_HEAD).end(JSON.stringify(out)); })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  /* The panel's own tabs (0.8.0): campaigns, rooms, settings — and their buttons. */
  if (url.pathname === "/api/panel" && req.method === "GET") {
    try { return res.writeHead(200, JSON_HEAD).end(JSON.stringify(panelState())); }
    catch (e) { console.error(e); return res.writeHead(500, JSON_HEAD).end(JSON.stringify({ error: e.message })); }
  }
  if (url.pathname === "/api/panel/act" && req.method === "POST") {
    return jsonBody(req)
      .then(async (body) => { const out = await panelAct(body ?? {}); res.writeHead(out.error ? 400 : 200, JSON_HEAD).end(JSON.stringify(out)); })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  /* The control lane (lib/control.mjs). /lease, /act and /release are what a
   * task manager or a script calls and holds open; /jobs is the extension's
   * service worker asking "anything for me?" (long-polled); /answer is the
   * result coming back; /granted is the panel saying the operator allowed a
   * site. Grants ride in the request because a local caller already has the
   * run of the machine — the screen that matters is the one an AGENT's
   * definition passes, in agent/, and the extension's own label screen. */
  if (url.pathname === "/api/control/lease" && req.method === "POST") {
    return jsonBody(req)
      .then(async (body) => {
        const out = await CONTROL.lease({ task: body.task, url: body.url, stranger: Boolean(body.stranger), project: body.project ? String(body.project) : null });
        res.writeHead(out.error ? 502 : 200, JSON_HEAD).end(JSON.stringify(out));
      })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  if (url.pathname === "/api/control/act" && req.method === "POST") {
    return jsonBody(req)
      .then(async (body) => {
        const grants = Array.isArray(body.grants) ? body.grants.map(String) : ["read"];
        const out = await CONTROL.act(body.lease, String(body.tool ?? ""), body.input ?? {}, { grants });
        res.writeHead(out?.error ? (out.refused ? 403 : 502) : 200, JSON_HEAD).end(JSON.stringify(out ?? {}));
      })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  if (url.pathname === "/api/control/release" && req.method === "POST") {
    return jsonBody(req)
      .then(async (body) => res.writeHead(200, JSON_HEAD).end(JSON.stringify(await CONTROL.release(body.lease))))
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  if (url.pathname === "/api/control/jobs" && req.method === "GET") {
    const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get("wait")) || 0));
    return CONTROL.claim(wait)
      .then((jobs) => res.writeHead(200, JSON_HEAD).end(JSON.stringify({ jobs })))
      .catch(() => res.writeHead(200, JSON_HEAD).end(JSON.stringify({ jobs: [] })));
  }

  if (url.pathname === "/api/control/answer" && req.method === "POST") {
    return jsonBody(req)
      .then((body) => {
        const { id, ...result } = body ?? {};
        res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, took: CONTROL.answer(id, result) }));
      })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  if (url.pathname === "/api/control/reload" && req.method === "POST") {
    return CONTROL.reload().then((out) => { res.writeHead(200, JSON_HEAD).end(JSON.stringify(out)); });
  }
  if (url.pathname === "/api/control/granted" && req.method === "POST") {
    return jsonBody(req)
      .then((body) => { CONTROL.granted(body.origin); res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true })); })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  if (url.pathname === "/api/control/leases" && req.method === "GET")
    return res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ...controlSummary(), detail: CONTROL.leases() }));

  if (url.pathname === "/api/cards/act" && req.method === "POST") {
    return jsonBody(req)
      .then(async (body) => {
        const out = await actCard(body ?? {});
        res.writeHead(out.error ? 400 : 200, JSON_HEAD).end(JSON.stringify(out));
      })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  /* The strategist — present only when agent/ has been installed. The engine
   *  never depends on it; this route is the one seam. */
  if (url.pathname === "/api/agent" && req.method === "POST") {
    return jsonBody(req)
      .then(async (body) => {
        const message = String(body.message ?? "");
        // Answered here, BEFORE the lazy import: an empty message is the panel
        // pinging the seam, and "is anyone there" must not cost a brain install.
        if (!message.trim())
          return res.writeHead(200, JSON_HEAD).end(JSON.stringify({ reply: "Say something and I will answer." }));
        let strategist;
        try {
          ({ strategist } = await import("../agent/strategist.mjs"));
        } catch (e) {
          return res.writeHead(503, JSON_HEAD).end(JSON.stringify({
            error: "the strategist is not installed",
            how: "npm run brain   (installs agent/ — Deep Agents and the LangChain runtime; everything else works without it)",
            detail: String(e.message ?? e).split("\n")[0],
          }));
        }
        try {
          const out = await strategist(P(), message, String(body.thread ?? "panel"));
          res.writeHead(200, JSON_HEAD).end(JSON.stringify(out));
        } catch (e) {
          console.error(e);
          res.writeHead(500, JSON_HEAD).end(JSON.stringify({ error: String(e.message ?? e).split("\n")[0] }));
        }
      })
      .catch((e) => res.writeHead(400, JSON_HEAD).end(JSON.stringify({ error: e.message })));
  }

  if (url.pathname === "/skills/choose" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      const form = new URLSearchParams(body);
      const slot = String(form.get("slot") ?? "");
      const id = form.get("id") ? String(form.get("id")) : null;
      if (slot) writeChoice(DATA, slot, id);
      // The choice takes effect now, not at the next restart: re-resolve the
      // registry, re-import the adapters, re-mount the pages.
      await loadPlatforms(DATA);
      await mountSkillPages();
      res.writeHead(303, { location: "/skills" }).end();
    });
    return;
  }

  if (req.method === "POST" && writes[url.pathname]) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      let to = null;
      try { to = writes[url.pathname](form); } catch (e) { console.error(e); }
      // A null destination means "wherever the button was" — an action started
      // from the queue should not dump you on the home page.
      res.writeHead(303, { location: to ?? backTo(form, req) }).end();
    });
    return;
  }

  if (url.pathname === "/app.js")
    return res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": CSP,
    }).end(APP_JS);

  /* The deck as a page: the extension's own panel files, served same-origin.
   * One implementation of the card surface — the extension is where it earns
   * its keep (it can type into Reddit's composer), and this is the same thing
   * for a browser without the extension, and for looking at it on this
   * machine. Static, from the repo's extension/ directory, nothing else. */
  if (url.pathname === "/panel") return res.writeHead(302, { location: "/panel/" }).end();
  if (url.pathname.startsWith("/panel/")) {
    const PANEL = {
      "": ["sidepanel.html", "text/html; charset=utf-8"],
      "card.css": ["card.css", "text/css; charset=utf-8"],
      "card.js": ["card.js", "text/javascript; charset=utf-8"],
      "sidepanel.js": ["sidepanel.js", "text/javascript; charset=utf-8"],
      "suggest.js": ["suggest.js", "text/javascript; charset=utf-8"],
      "insert.js": ["insert.js", "text/javascript; charset=utf-8"],
    };
    const hit = PANEL[url.pathname.slice("/panel/".length)];
    if (!hit) return res.writeHead(404, JSON_HEAD).end(JSON.stringify({ error: "not part of the panel" }));
    try {
      const body = readFileSync(join(ROOT, "extension", hit[0]));
      return res.writeHead(200, {
        "content-type": hit[1],
        "cache-control": "no-cache",
        // Its own CSP, not the dashboard's: the panel is scripted by design,
        // but only by its own files, and it talks only to this origin.
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
      }).end(body);
    } catch {
      return res.writeHead(404, JSON_HEAD).end(JSON.stringify({ error: "panel files missing" }));
    }
  }

  if (url.pathname === "/api/jobs.json")
    return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ jobs: J.list().slice(0, 12) }));

  /* The runtime, as JSON: tasks, colleagues, and why there are none. */
  if (url.pathname === "/api/tasks.json")
    return res.writeHead(200, JSON_HEAD).end(JSON.stringify({
      tasks: RT() ? RT().list() : [],
      colleagues: RT() ? RT().colleagues().map((c) => ({ id: c.id, name: c.name, description: c.description, tools: c.tools, grants: c.grants, model: c.model, ring: c.ring })) : [],
      inbox: RT() ? RT().inbox(Math.max(0, Number(url.searchParams.get("since")) || 0)) : null,
      why: RT() ? null : (WHY() || "the runtime is not installed — npm run brain"),
    }));

  /* What a paused worker saw. Served from disk, never anywhere else. */
  {
    const m = /^\/api\/tasks\/(t[a-z0-9]+)\/screenshot$/.exec(url.pathname);
    if (m) {
      const p = RT()?.screenshotPath(m[1]);
      if (!p) return res.writeHead(404, JSON_HEAD).end(JSON.stringify({ error: "no screenshot for that task" }));
      return res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(readFileSync(p));
    }
  }

  // The page door: skills the registry resolved, mounted beside the core
  // views. A page that throws renders its failure — a broken skill must not
  // take the dashboard down with it.
  const sp = SKILL_PAGES.get(url.pathname);
  if (sp) {
    return Promise.resolve()
      .then(() => sp.render({ dir: P() }))
      .then((body) => res.writeHead(200, HTML).end(render(sp.path, sp.title, String(body ?? ""))))
      .catch((e) => {
        console.error(e);
        res.writeHead(500, HTML).end(render(sp.path, sp.title,
          `<h1>${esc(sp.title)}</h1><p>The <b>${esc(sp.skill)}</b> skill's page failed: ${esc(e.message)}</p>`));
      });
  }

  const view = views[url.pathname];
  if (!view)
    return res.writeHead(404, HTML).end(render("/", "Not found", `<h1>Not found</h1><p><a href="/">Standing</a></p>`));

  Promise.resolve()
    .then(() => view(url))
    .then((html) => res.writeHead(200, HTML).end(html))
    .catch((e) => {
      console.error(e);
      res.writeHead(500, HTML).end(render("/", "Error", `<h1>Something broke</h1><pre class="log">${esc(e.stack ?? e.message)}</pre>`));
    });
});

// Mounted here, once every core view above exists — that ordering is what
// makes the collision check honest.
await mountSkillPages();

/**
 * 127.0.0.1, never 0.0.0.0, and never the default of omitting the host —
 * which binds every interface and puts your Reddit history on the coffee-shop
 * wifi. This one argument is the whole "the user is the data controller"
 * position expressed as a bind address.
 */
export function serve(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      // The port the OS actually granted, not the one asked for — `--port 0`
      // means "any free one", and the log line is how a caller learns which.
      console.log(`Messaging Quest  http://127.0.0.1:${server.address().port}`);
      // Children inherit this, which is how a probe spawned by a button — or
      // the strategist, or the site scout — reaches the control lane and so
      // the operator's browser. There is no other way to read a page.
      process.env.MQ_SERVER = `http://127.0.0.1:${server.address().port}`;
      console.log(`reading ${P()}/ (project “${PJ().name}”) — localhost only, nothing leaves this machine.`);
      const p = plan(P());
      console.log(p === "local"
        ? `models: the local plan — ${localConfig(P()).baseUrl}; nothing is billed and nothing leaves this machine.`
        : hasKey(P())
          ? `models: the ${p} plan on OpenRouter — the scout, judge and writer are available.`
          : `no OpenRouter key yet — a free one (${KEY_URL}, no card) goes on the panel's Settings tab or /settings; or pick Local there to run a model on this machine.`);
      console.log(`ctrl-c to stop.`);
      resolve(server);
      // The brain, if installed, after the port: the deck answers now, the
      // colleagues arrive a few seconds later and say so on /tasks meanwhile.
      loadRuntime(P()).then(() => { if (RT()) console.log(`colleagues: ${RT().colleagues().map((c) => c.name).join(", ") || "none installed"} (agent/ is in).`); });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("serve.mjs")) await serve();
