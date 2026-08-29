#!/usr/bin/env node
// The dashboard — the predecessor's views, served on localhost.
//
// §07: "The predecessor's dashboard was Next.js on Vercel with Supabase behind
// it. Ours is the same views served on localhost. A hosted dashboard is not
// free for you, and it forfeits the argument that THE USER rather than you is
// the data controller — which is the whole GDPR position after CNIL fined
// KASPR EUR 240,000 for a Chrome extension reading through a customer's own
// session. Same code, no bill, no liability."
//
// So: bound to 127.0.0.1, never 0.0.0.0. Nothing leaves this machine, there is
// no account, and the only writes are the ones you click.
//
// The shape is the predecessor's side panel, which §15 says is the UI the
// operator actually likes: ONE CARD AT A TIME, no list, no lobby, the reply
// already there when the card opens, and an empty screen that rechecks itself.
// A queue rendered as a table of forty rows is a lobby, and a lobby is where
// good intentions go to be skimmed.
//
//   node bin/serve.mjs [--port 8787]

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { store } from "../lib/store.mjs";
import { history, STATES } from "../lib/verdict.mjs";
import { standing, readiness, burst, mix, PER_ROOM_24H, OVERALL_24H, CQS_NOTE } from "../lib/ready.mjs";
import { sidebarUrl, roomFile } from "../lib/rules.mjs";
import { mergeVoice, voiceRules, voiceSummary } from "../lib/voice.mjs";
import { threadOf } from "../lib/reddit.mjs";

const DIR = process.env.EARSHOT_DIR || ".earshot";
const argv = process.argv.slice(2);
const PORT = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : 8787;
if (!existsSync(DIR)) { console.error(`earshot: no ${DIR}/ here — run \`es init\` first`); process.exit(1); }
const S = store(DIR, (m) => { throw new Error(m); });

/* ---------------------------------------------------------------- escaping */

/** Everything rendered below came off Reddit, which means a stranger wrote it.
 *  A post body is untrusted input and this page is the only thing standing
 *  between it and your browser. Escaped at the seam, once, so no caller can
 *  forget. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* -------------------------------------------------------------------- chrome */

const NAV = [
  ["/", "Standing"], ["/waiting", "Waiting"], ["/queue", "Queue"],
  ["/rooms", "Rooms"], ["/ready", "Ready"], ["/sources", "Sources"], ["/voice", "Voice"],
];

const page = (path, title, body, { refresh = 0 } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — earshot</title>${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<style>
:root{--paper:#f3f2ee;--panel:#fff;--ink:#16171b;--ink2:#5c5f68;--ink3:#8b8e96;--rule:#dbd9d1;
--sig:#d9410f;--ok:#1a6b52;--no:#8c2f1c;--hi:#f7e9c9}
@media(prefers-color-scheme:dark){:root{--paper:#131418;--panel:#1b1d23;--ink:#e9e8e3;--ink2:#a4a6ad;
--ink3:#7b7e86;--rule:#2b2e35;--sig:#ff6b35;--ok:#4cbf94;--no:#e08363;--hi:#33291a}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{border-bottom:2px solid var(--ink);padding:18px 24px;display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline}
header b{font-size:15px;letter-spacing:-.01em}
header .who{font:12px ui-monospace,Menlo,monospace;color:var(--ink3)}
nav{display:flex;flex-wrap:wrap;gap:2px;padding:10px 18px;border-bottom:1px solid var(--rule)}
nav a{padding:6px 12px;border-radius:4px;text-decoration:none;color:var(--ink2);font-size:14px}
nav a:hover{background:var(--panel)} nav a.on{background:var(--ink);color:var(--paper)}
main{max-width:820px;margin:0 auto;padding:28px 24px 90px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px} h2{font-size:18px;margin:34px 0 10px}
p{margin:0 0 14px;max-width:66ch} .sub{color:var(--ink2)}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:22px;margin:0 0 18px}
.said{white-space:pre-wrap;font-size:15px;line-height:1.55;border-left:3px solid var(--rule);padding-left:14px;color:var(--ink2);max-height:22em;overflow:auto}
.meta{font:12px ui-monospace,Menlo,monospace;color:var(--ink3);margin-bottom:10px}
.big{font-size:44px;font-weight:800;letter-spacing:-.03em;line-height:1}
.row{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--rule);align-items:baseline}
.row:last-child{border-bottom:0}
.tag{font:11px/1 ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;padding:4px 7px;border:1px solid currentColor;border-radius:3px;white-space:nowrap}
.ok{color:var(--ok)} .no{color:var(--no)} .dim{color:var(--ink3)} .sig{color:var(--sig)}
button{font:inherit;font-size:15px;padding:10px 18px;border-radius:6px;border:1px solid var(--rule);background:var(--panel);color:var(--ink);cursor:pointer}
button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}
button:hover{border-color:var(--ink3)}
form{display:inline} .actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;align-items:center}
code,kbd{font:13px ui-monospace,Menlo,monospace;background:var(--paper);border:1px solid var(--rule);padding:1px 5px;border-radius:3px}
.empty{text-align:center;padding:46px 20px;color:var(--ink2)}
.note{background:var(--hi);border-radius:6px;padding:14px 16px;margin:0 0 18px;font-size:15px}
a{color:var(--sig)}
</style></head><body>
<header><b>earshot</b><span class="who">${esc(S.account()?.name ? "u/" + S.account().name : "no account set — es me &lt;username&gt;")}</span>
<span class="who">localhost only · nothing leaves this machine</span></header>
<nav>${NAV.map(([h, t]) => `<a class="${h === path ? "on" : ""}" href="${h}">${t}</a>`).join("")}</nav>
<main>${body}</main></body></html>`;

const empty = (what, run) => `<div class="empty"><p>${esc(what)}</p><p><code>${esc(run)}</code></p>
<p class="sub" style="font-size:13px">This screen rechecks itself.</p></div>`;

/* --------------------------------------------------------------- the views */

const views = {};

/** What became of the things you said. The number that matters is at the top,
 *  because it is the one a person came here to find out. */
views["/"] = () => {
  const items = S.items(), checks = S.checksById();
  if (!items.size) return page("/", "Standing", empty("Nothing stored yet.", "es sync"), { refresh: 15 });

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

  return page("/", "Standing", `
<h1>What became of the things you said</h1>
<p class="sub">${items.size} comment${items.size === 1 ? "" : "s"} stored, read back as a logged-out stranger.</p>
${denom ? `<div class="card"><div class="big ${hidden ? "sig" : "ok"}">${Math.round((hidden / denom) * 100)}%</div>
<p style="margin-top:10px">of what a stranger could have read, they cannot.</p></div>` : ""}
<div class="card">${[...tally].sort((a, b) => b[1] - a[1]).map(([st, n]) =>
  `<div class="row"><span><b>${n}</b> &nbsp;<span class="tag ${st === "visible" ? "ok" : st === "filtered" || st === "removed" ? "no" : "dim"}">${esc(st)}</span></span>
   <span class="sub" style="text-align:right;font-size:14px">${esc(STATES[st] ?? "")}</span></div>`).join("")
  || `<p class="sub">Nothing checked yet.</p>`}
${unchecked ? `<div class="row"><span><b>${unchecked}</b> &nbsp;<span class="tag dim">unchecked</span></span><span class="sub" style="font-size:14px">not looked at yet — <code>es check</code></span></div>` : ""}
</div>
${moved.length ? `<h2>Changed since the first look</h2><div class="card">${moved.slice(0, 10).map(({ it, h }) =>
  `<div class="row"><span>${esc(h.changed_at.from)} → <b class="sig">${esc(h.changed_at.to)}</b></span>
   <span class="sub" style="font-size:13px">${esc(h.changed_at.at.slice(0, 16).replace("T", " "))}</span></div>
   <div class="said" style="margin:8px 0 4px">${esc((it.body || it.url || "").slice(0, 220))}</div>`).join("")}</div>` : ""}
<p class="sub" style="font-size:14px">A change of state is the one thing a private window cannot show you.
It needs two looks, and both are on disk.</p>`);
};

/** Who replied and has not been answered. */
views["/waiting"] = () => {
  const rows = S.readJsonl("replies.jsonl");
  const latest = new Map();
  for (const r of rows) latest.set(r.id, r);
  const waiting = [...latest.values()].filter((r) => r.state === "waiting");
  const items = S.items();
  if (!waiting.length) {
    return page("/waiting", "Waiting", rows.length
      ? `<h1>Nobody is waiting on you</h1><p class="sub">${rows.length} conversation${rows.length === 1 ? "" : "s"} checked. Re-check with <code>es back</code>.</p>`
      : empty("No conversations checked yet.", "es back"), { refresh: rows.length ? 0 : 20 });
  }
  waiting.sort((a, b) => String(a.latest?.at ?? "").localeCompare(String(b.latest?.at ?? "")));
  return page("/waiting", "Waiting", `
<h1>${waiting.length} waiting for you</h1>
<p class="sub">Oldest first, because that is the one going cold. Membership is made of second and third replies.</p>
${waiting.map((r) => { const it = items.get(r.id); return `<div class="card">
<div class="meta">u/${esc(r.latest?.author ?? "?")} · ${esc(String(r.latest?.at ?? "").slice(0, 16).replace("T", " "))}${r.since_you ? ` · <b class="sig">since you last spoke</b>` : ""} · ${r.replies} repl${r.replies === 1 ? "y" : "ies"}</div>
<div class="said">${esc(r.latest?.text || "(text expired — the 48-hour sweep dropped it)")}</div>
<p class="sub" style="margin:12px 0 0;font-size:14px">You said: ${esc((it?.body ?? "").slice(0, 160) || "—")}</p>
<div class="actions"><a href="${esc(r.latest?.url || it?.url || "#")}" target="_blank" rel="noreferrer noopener"><button>Open the thread</button></a></div>
</div>`; }).join("")}
<p class="sub" style="font-size:14px">You answer these yourself, in your own words. Nothing here writes or sends anything.</p>`);
};

/** The deck. One person, one card, the draft already there. Never a list. */
views["/queue"] = (url) => {
  const v = S.verdicts(), marks = S.marks(), all = S.found(), gone = S.contacted();
  const rows = [];
  for (const [id, ver] of v) {
    if (!ver.fit || marks.has(id)) continue;
    const it = all.get(id);
    if (!it) continue;
    if (it.author && gone.has(it.author.toLowerCase())) continue;
    rows.push({ ...it, why: ver.why });
  }
  rows.sort((a, b) => String(b.posted_at ?? b.seen_at).localeCompare(String(a.posted_at ?? a.seen_at)));
  if (!rows.length) return page("/queue", "Queue", empty("Nobody is waiting for an answer.", "es tick   then   es judge"), { refresh: 20 });

  const at = Math.min(Math.max(0, Number(url.searchParams.get("i")) || 0), rows.length - 1);
  const it = rows[at];
  const draft = S.drafts().filter((d) => d.id === it.id).pop();
  const sent = S.readJsonl("marks.jsonl").filter((m) => m.mark === "sent");
  // burst() answers with null when there is nothing in the way, and an object
  // when there is. Reading it as a truthy "allowed" flag inverts the gate.
  const blocked = burst(S.sentLog(), it.place);
  // [...values()], not the Map: iterating a Map yields [key, value] pairs, so
  // every item is skipped and every room reports "no comments here at all".
  // Rendered as a confident gate, which is worse than rendering nothing.
  const stand = standing([...S.items().values()], S.checksById());
  const ready = readiness(stand.get(it.place) ?? { place: it.place, comments: 0, visible: 0 }, S.roomState(it.place));

  return page("/queue", "Queue", `
<h1>One person</h1>
<p class="sub">${at + 1} of ${rows.length} · r/${esc(it.place)} · <span class="tag ${ready.state === "ready" ? "ok" : ready.state === "not ready" ? "no" : "dim"}">${esc(ready.state)}</span></p>
${blocked ? `<div class="note"><b>The gate says not yet.</b> ${esc(blocked.why)}.</div>` : ""}
${ready.state === "not ready" ? `<div class="note"><b>${esc(ready.why)}</b></div>` : ""}
<div class="card">
  <div class="meta">u/${esc(it.author ?? "?")} · ${esc(String(it.posted_at ?? it.seen_at).slice(0, 16).replace("T", " "))}</div>
  ${it.title ? `<p><b>${esc(it.title)}</b></p>` : ""}
  <div class="said">${esc(it.body || "")}</div>
  <p class="sub" style="font-size:13px;margin:12px 0 0">judged fit: ${esc(it.why || "—")}</p>
</div>
<div class="card">
  <h2 style="margin-top:0">${draft ? "Your draft" : "No draft yet"}</h2>
  ${draft ? `<div class="said">${esc(draft.text)}</div>
    ${(draft.flags?.repeat ?? 0) >= 8 ? `<div class="note" style="margin-top:14px"><b>Repeated phrasing:</b> ${draft.flags.repeat} identical consecutive words you have used before.</div>` : ""}
    ${(draft.flags?.claims ?? 0) ? `<div class="note" style="margin-top:14px"><b>${draft.flags.claims} claim(s) about your history</b> — each is either true or it is the thing that ends the account.</div>` : ""}
    ${(draft.flags?.links ?? 0) ? `<div class="note" style="margin-top:14px"><b>Invented link.</b> Not present in the thread we read.</div>` : ""}`
    : `<p class="sub">Write it with <code>es draft ${esc(it.id)}</code>, then <code>es draft ${esc(it.id)} --save &lt; reply.txt</code>. It will appear here.</p>`}
</div>
<div class="actions">
  <a href="${esc(it.url)}" target="_blank" rel="noreferrer noopener"><button class="primary">Open it on Reddit</button></a>
  <form method="POST" action="/mark"><input type="hidden" name="id" value="${esc(it.id)}"><input type="hidden" name="mark" value="sent">
    <button ${blocked ? `disabled title="${esc(blocked.why)}"` : ""}>I posted it</button></form>
  <form method="POST" action="/mark"><input type="hidden" name="id" value="${esc(it.id)}"><input type="hidden" name="mark" value="skip"><button>Not this one</button></form>
  ${at + 1 < rows.length ? `<a href="/queue?i=${at + 1}" class="sub" style="font-size:14px">next →</a>` : ""}
</div>
<p class="sub" style="font-size:13px;margin-top:20px">&ldquo;I posted it&rdquo; is the only thing here that writes anything, and what it writes is on your disk.
It retires u/${esc(it.author ?? "?")} from every future queue, permanently.</p>`);
};

views["/rooms"] = () => {
  const places = [...new Set(S.readJsonl("probes.jsonl").map((r) => r.place))];
  if (!places.length) return page("/rooms", "Rooms", empty("No rooms probed yet.", 'es probe <subreddit> --q "<phrase>"'), { refresh: 20 });
  return page("/rooms", "Rooms", `
<h1>Rooms</h1>
<p class="sub">A room stays unwatchable until its rules have been read. That is deliberate — Reddit does not serve
its rules to a logged-out reader, and the public description is not the rules list.</p>
${places.map((p) => { const st = S.roomState(p); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>r/${esc(p)}</b>
<span class="tag ${st.state === "allowed" ? "ok" : st.state === "banned" ? "no" : "dim"}">${esc(st.state)}</span></div>
${st.state === "unanswered" ? `
<p class="sub" style="margin:12px 0 8px;font-size:14px">Nobody has read this room's rules. Open them, then answer here.</p>
<div class="actions">
  <a href="${esc(sidebarUrl(p))}" target="_blank" rel="noreferrer noopener"><button>Read the rules</button></a>
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}"><input type="hidden" name="answer" value="yes"><button>They permit it</button></form>
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}"><input type="hidden" name="answer" value="no"><button>They forbid it</button></form>
</div>` : `<p class="sub" style="margin:10px 0 0;font-size:14px">Recorded in <code>${esc(S.roomPath(p))}</code>. Edit that file to change it.</p>`}
</div>`; }).join("")}`);
};

views["/ready"] = () => {
  const stand = standing([...S.items().values()], S.checksById());
  const sent = S.sentLog();
  const m = mix([...S.items().values()].filter((i) => i.kind === "comment").length, sent.length);
  if (!stand.size) return page("/ready", "Ready", empty("No standing measured yet — it is read off your own comments.", "es sync   then   es check"), { refresh: 20 });
  return page("/ready", "Ready", `
<h1>Where you stand</h1>
<p class="sub">Read off your own comments and what a stranger can see of them. No invented threshold:
Reddit does not publish what Crowd Control requires.</p>
${[...stand.values()].map((r) => { const d = readiness(r, S.roomState(r.place)); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>r/${esc(r.place)}</b>
<span class="tag ${d.state === "ready" ? "ok" : d.state === "not ready" ? "no" : "dim"}">${esc(d.state)}</span></div>
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

views["/sources"] = () => {
  const srcs = S.sources();
  if (!srcs.length) return page("/sources", "Sources", empty("Watching nothing yet.", 'es probe <subreddit> --q "<phrase>"'), { refresh: 20 });
  const reads = new Map(S.readJsonl("reads.jsonl").filter((r) => r.source).map((r) => [r.source, r]));
  const found = [...S.found().values()];
  return page("/sources", "Sources", `
<h1>What is watched</h1>
<p class="sub">Subreddit submissions and scoped searches only. The undirected comment firehose is refused
by shape: 4,074 reads for 173 leads in the corpus, 23.5 reads each.</p>
${srcs.map((s) => { const r = reads.get(s.id); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(s.id)}</b>
<span class="sub" style="font-size:13px">${found.filter((f) => f.probe === s.id).length} found</span></div>
<p class="sub" style="margin:8px 0 0;font-size:13px">${r ? (r.ok ? `last read ${esc(r.at.slice(0, 16).replace("T", " "))}` : `<span class="no">error: ${esc(r.err ?? "")}</span>`) : "never read"} · every ${s.cadence_min}m</p>
</div>`; }).join("")}`);
};

views["/voice"] = () => {
  const raw = existsSync(S.F("voice.json")) ? JSON.parse(readFileSync(S.F("voice.json"), "utf8")) : null;
  const fp = mergeVoice(raw?.measured ?? null, raw?.user ?? null);
  const rules = voiceRules(fp), summary = voiceSummary(fp);
  if (!raw) return page("/voice", "Voice", empty("Voice not measured yet — it is read off your own comments.", "es voice"), { refresh: 20 });
  return page("/voice", "Voice", `
<h1>How you write</h1>
<p class="sub">Measured from ${raw.samples ?? 0} of your own comments. Not a persona menu.</p>
<div class="card"><p style="font-size:18px;margin:0">${esc(summary ?? "Nothing about your style is measurable yet, and nothing is being guessed.")}</p></div>
<div class="card">${rules.map((r) => `<div class="row">${esc(r)}</div>`).join("") || `<p class="sub">No rules yet.</p>`}</div>
<p class="sub" style="font-size:14px">Presence is decisive at one sample; absence is never decisive below five.
An unmeasured dimension emits no instruction at all, deliberately — the one exception is em dashes,
and one sample of you using one lifts it.</p>
<p class="sub" style="font-size:13px">Correct any line by editing <code>${esc(S.F("voice.json"))}</code>. What you say beats what was measured.</p>`);
};

/* ------------------------------------------------------------------ writes */

const writes = {
  "/mark": (form) => {
    const id = form.get("id"), mark = form.get("mark");
    if (!["sent", "skip"].includes(mark)) return "/queue";
    const it = S.found().get(id);
    if (!it) return "/queue";
    S.append("marks.jsonl", { id, mark, at: new Date().toISOString(), via: "dashboard" });
    if (mark === "sent" && it.author) S.append("contacted.jsonl", { author: it.author, id, at: new Date().toISOString() });
    return "/queue";
  },
  "/room": (form) => {
    const place = String(form.get("place") ?? "").replace(/[^\w-]/g, "");
    const answer = form.get("answer") === "yes" ? "yes" : "no";
    if (!place) return "/rooms";
    // The file is the record and the file always wins — the same markdown the
    // CLI reads, so answering here and answering in an editor are one thing.
    const existing = existsSync(S.roomPath(place)) ? readFileSync(S.roomPath(place), "utf8") : roomFile(place, null);
    S.writeRoom(place, existing.replace(/^promotion_allowed:.*$/mi, `promotion_allowed: ${answer}`));
    return "/rooms";
  },
};

/* ------------------------------------------------------------------ server */

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "POST" && writes[url.pathname]) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let to = "/queue";
      try { to = writes[url.pathname](new URLSearchParams(body)); } catch (e) { console.error(e); }
      res.writeHead(303, { location: to }).end();
    });
    return;
  }
  const view = views[url.pathname];
  if (!view) return res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
    .end(page("/", "Not found", `<h1>Not found</h1><p><a href="/">Standing</a></p>`));
  try {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Nothing on this page loads anything from anywhere. Said out loud so a
      // future edit that reaches for a CDN breaks loudly instead of quietly
      // making a local dashboard phone home.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      "referrer-policy": "no-referrer",
    }).end(view(url));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" }).end(page("/", "Error", `<h1>Something broke</h1><pre>${esc(e.message)}</pre>`));
  }
});

/**
 * 127.0.0.1, never 0.0.0.0, and never the default of omitting the host —
 * which binds every interface and puts your Reddit history on the coffee-shop
 * wifi. This one argument is the whole "the user is the data controller"
 * position expressed as a bind address.
 */
export function serve(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`earshot dashboard  http://127.0.0.1:${port}`);
      console.log(`reading ${DIR}/ — localhost only, nothing leaves this machine.`);
      console.log(`ctrl-c to stop.`);
      resolve(server);
    });
  });
}

// Started directly rather than imported by `es serve`.
if (process.argv[1] && process.argv[1].endsWith("serve.mjs")) await serve();
