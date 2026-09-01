// The chrome, the components, and the one script the pages load.
//
// This was inside bin/serve.mjs until the dashboard grew screens that do things
// rather than screens that read things. It is here so the router is a router.
//
// ON THE CONTENT SECURITY POLICY, because it is load-bearing and it changed:
//
// The pages used to ship `default-src 'none'` with no script-src at all, which
// meant no JavaScript ran anywhere — the whole dashboard was forms and
// meta-refresh. That was a real guarantee and it is worth keeping the part of
// it that mattered: NOTHING LOADS FROM ANYWHERE BUT THIS PROCESS. A later edit
// that reaches for a CDN font, an analytics snippet or a hosted script still
// breaks loudly instead of quietly making a local-only dashboard phone home.
//
// What changed is `script-src 'self'` and `connect-src 'self'`, so one local
// file can poll one local endpoint. That is what a minute-long job needs to
// show progress without reloading the page under somebody's cursor. `default-src
// 'none'` stays as the base, so every OTHER resource type is still refused by
// default rather than by omission.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'";

/* ------------------------------------------------------------------- nav */

/** Grouped, because ten flat links is a menu and not a product. The groups are
 *  the three questions somebody actually arrives with: who do I answer, where
 *  am I looking, and can I be seen. */
export const NAV = [
  [["/queue", "Queue"], ["/people", "Prospects"], ["/waiting", "Waiting"]],
  [["/", "Standing"], ["/ready", "Ready"], ["/voice", "Voice"]],
  [["/sources", "Sources"], ["/rooms", "Rooms"]],
  [["/memory", "Memory"], ["/skills", "Skills"], ["/settings", "Settings"]],
];

/* ------------------------------------------------------------------ css */

const CSS = `
:root{--paper:#f3f2ee;--panel:#fff;--ink:#16171b;--ink2:#5c5f68;--ink3:#8b8e96;--rule:#dbd9d1;
--sig:#d9410f;--ok:#1a6b52;--no:#8c2f1c;--hi:#f7e9c9;--soft:#e9e7e0}
@media(prefers-color-scheme:dark){:root{--paper:#131418;--panel:#1b1d23;--ink:#e9e8e3;--ink2:#a4a6ad;
--ink3:#7b7e86;--rule:#2b2e35;--sig:#ff6b35;--ok:#4cbf94;--no:#e08363;--hi:#33291a;--soft:#23262d}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{border-bottom:2px solid var(--ink);padding:14px 24px;display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline}
header b{font-size:15px;letter-spacing:-.01em}
header .who{font:12px ui-monospace,Menlo,monospace;color:var(--ink3)}
nav{display:flex;flex-wrap:wrap;gap:2px;padding:8px 18px;border-bottom:1px solid var(--rule);align-items:center}
nav a{padding:6px 12px;border-radius:4px;text-decoration:none;color:var(--ink2);font-size:14px}
nav a:hover{background:var(--panel)} nav a.on{background:var(--ink);color:var(--paper)}
nav .sep{width:1px;height:18px;background:var(--rule);margin:0 8px}
main{max-width:880px;margin:0 auto;padding:26px 24px 90px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px} h2{font-size:18px;margin:30px 0 10px}
p{margin:0 0 14px;max-width:66ch} .sub{color:var(--ink2)}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:22px;margin:0 0 18px}
.said{white-space:pre-wrap;font-size:15px;line-height:1.55;border-left:3px solid var(--rule);padding-left:14px;color:var(--ink2);max-height:22em;overflow:auto}
.meta{font:12px ui-monospace,Menlo,monospace;color:var(--ink3);margin-bottom:10px}
.big{font-size:44px;font-weight:800;letter-spacing:-.03em;line-height:1}
.row{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--rule);align-items:baseline}
.row:last-child{border-bottom:0}
.tag{font:11px/1 ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;padding:4px 7px;border:1px solid currentColor;border-radius:3px;white-space:nowrap}
.ok{color:var(--ok)} .no{color:var(--no)} .dim{color:var(--ink3)} .sig{color:var(--sig)}
button,.btn{font:inherit;font-size:15px;padding:9px 16px;border-radius:6px;border:1px solid var(--rule);background:var(--panel);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}
button.small,.btn.small{font-size:13px;padding:6px 11px}
button:hover,.btn:hover{border-color:var(--ink3)}
button:disabled{opacity:.45;cursor:not-allowed}
form{display:inline} .actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;align-items:center}
code,kbd{font:13px ui-monospace,Menlo,monospace;background:var(--paper);border:1px solid var(--rule);padding:1px 5px;border-radius:3px}
.empty{text-align:center;padding:42px 20px;color:var(--ink2)}
.note{background:var(--hi);border-radius:6px;padding:14px 16px;margin:0 0 18px;font-size:15px}
a{color:var(--sig)}
input[type=text],input[type=url],input[type=password],input[type=search],textarea,select{
  font:inherit;width:100%;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;
  background:var(--paper);color:var(--ink)}
textarea{font:14px/1.6 ui-monospace,Menlo,monospace;min-height:20em;resize:vertical}
label{display:block;font-size:14px;color:var(--ink2);margin:0 0 6px}
.field{margin:0 0 16px}
.tabs{display:flex;gap:2px;flex-wrap:wrap;margin:0 0 18px;border-bottom:1px solid var(--rule);padding-bottom:10px}
.tabs a{font-size:14px;padding:6px 12px;border-radius:4px;text-decoration:none;color:var(--ink2)}
.tabs a.on{background:var(--soft);color:var(--ink)}
.strip{position:sticky;top:0;z-index:50;background:var(--panel);border-bottom:1px solid var(--rule);
  padding:10px 24px;display:none;align-items:center;gap:14px;font-size:14px}
.strip.on{display:flex}
.bar{flex:1;height:6px;background:var(--soft);border-radius:3px;overflow:hidden;max-width:280px}
.bar i{display:block;height:100%;background:var(--sig);width:0;transition:width .3s}
.strip .what{font-weight:600} .strip .note{background:none;padding:0;margin:0;color:var(--ink2);font-size:13px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40ch}
.steps{display:flex;gap:6px;margin:0 0 22px;flex-wrap:wrap}
.step{font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid var(--rule);color:var(--ink3)}
.step.on{border-color:var(--ink);color:var(--ink);font-weight:600}
.step.done{border-color:var(--ok);color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:12px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;
  color:var(--ink3);border-bottom:1px solid var(--rule);padding:8px 10px 8px 0;font-weight:500}
td{padding:11px 10px 11px 0;border-bottom:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:0}
.pill{font:11px ui-monospace,Menlo,monospace;padding:3px 7px;border-radius:999px;background:var(--soft);color:var(--ink2)}
.log{font:12px/1.5 ui-monospace,Menlo,monospace;background:var(--paper);border:1px solid var(--rule);
  border-radius:6px;padding:12px;max-height:20em;overflow:auto;white-space:pre-wrap;color:var(--ink2)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.muted{color:var(--ink3);font-size:13px}
.right{text-align:right}
`;

/* --------------------------------------------------------------- the page */

/**
 * @param {object} o
 * @param {string} o.path      current route, for nav highlighting
 * @param {string} o.title
 * @param {string} o.body
 * @param {string} [o.who]     the account line in the header
 * @param {number} [o.refresh] meta-refresh seconds, for screens with nothing yet
 * @param {string} [o.banner]  a setup nudge, rendered above the nav
 * @param {Array}  [o.extra]   nav entries contributed by page skills, [href, label][]
 */
export const page = ({ path, title, body, who = "", refresh = 0, banner = "", extra = [] }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Messaging Quest</title>${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<style>${CSS}</style></head><body>
<header><b>Messaging Quest</b><span class="who">${esc(who)}</span>
<span class="who">localhost only · nothing leaves this machine</span></header>
<div class="strip" id="strip">
  <span class="what" id="strip-what"></span>
  <span class="bar"><i id="strip-bar"></i></span>
  <span class="note" id="strip-note"></span>
  <form method="POST" action="/api/cancel" id="strip-cancel-form">
    <input type="hidden" name="id" id="strip-id">
    <button class="small" type="submit">Stop</button>
  </form>
</div>
<nav>${[...NAV, ...(extra.length ? [extra] : [])].map((group) => group.map(([h, t]) =>
  `<a class="${h === path ? "on" : ""}" href="${h}">${esc(t)}</a>`).join("")).join('<span class="sep"></span>')}</nav>
${banner}
<main>${body}</main>
<script src="/app.js"></script></body></html>`;

/* -------------------------------------------------------------- components */

export const empty = (what, actionHtml) =>
  `<div class="empty"><p>${esc(what)}</p>${actionHtml ? `<div class="actions" style="justify-content:center">${actionHtml}</div>` : ""}</div>`;

/** An action button. Posts a verb and comes straight back — the work happens in
 *  a job, and the strip at the top of every page is where it is watched.
 *  Works with JavaScript off: it is a real form and a real redirect. */
export const runBtn = (verb, label, { args = [], primary = false, small = false, confirm = "", disabled = false, title = "" } = {}) => `
<form method="POST" action="/api/run">
  <input type="hidden" name="verb" value="${esc(verb)}">
  ${args.map((a, i) => `<input type="hidden" name="a${i}" value="${esc(a)}">`).join("")}
  <button type="submit" class="${primary ? "primary" : ""} ${small ? "small" : ""}"
    ${disabled ? "disabled" : ""} ${title ? `title="${esc(title)}"` : ""}
    ${confirm ? `data-confirm="${esc(confirm)}"` : ""}>${esc(label)}</button>
</form>`;

export const tag = (text, tone = "dim") => `<span class="tag ${tone}">${esc(text)}</span>`;

export const steps = (all, at) =>
  `<div class="steps">${all.map((s, i) =>
    `<span class="step ${i === at ? "on" : i < at ? "done" : ""}">${i < at ? "✓ " : ""}${esc(s)}</span>`).join("")}</div>`;

/** The banner that appears until the memory files are answered. Setup is not a
 *  page you visit once and lose — it is a thing with a state, and the state is
 *  visible from everywhere until it is done. */
export const setupBanner = (progress) => {
  if (progress.done >= progress.total) return "";
  return `<div style="padding:12px 24px;background:var(--hi);border-bottom:1px solid var(--rule);font-size:14px">
  <b>Setup is ${progress.done} of ${progress.total} done.</b>
  Messaging Quest judges every post against what you have told it you sell.
  <a href="/setup">Finish setting up →</a></div>`;
};

/* ------------------------------------------------------------- the script */

/**
 * One file, no build step, no dependencies. It does four things and they are
 * all things a page cannot do for itself:
 *
 *  1. Poll the running job and paint the strip.
 *  2. Reload once when a job finishes, so the view under it is not stale.
 *  3. Confirm the destructive buttons.
 *  4. Keyboard shortcuts on the queue deck, because the deck is a thing you
 *     work through and reaching for the mouse forty times is the difference
 *     between a tool and a chore.
 */
export const APP_JS = `
(function () {
  var strip = document.getElementById("strip");
  var what = document.getElementById("strip-what");
  var bar = document.getElementById("strip-bar");
  var note = document.getElementById("strip-note");
  var idInput = document.getElementById("strip-id");
  var sawRunning = false;

  function paint(jobs) {
    var live = jobs.filter(function (j) { return j.status === "running"; });
    if (!live.length) {
      strip.classList.remove("on");
      // A job that was running and is not any more has almost certainly written
      // something this page is showing a stale version of.
      if (sawRunning) { sawRunning = false; location.reload(); }
      return;
    }
    sawRunning = true;
    var j = live[0];
    strip.classList.add("on");
    what.textContent = j.label;
    idInput.value = j.id;
    note.textContent = j.note || "";
    bar.style.width = j.total ? Math.round((j.done / j.total) * 100) + "%" : "12%";
  }

  function poll() {
    fetch("/api/jobs.json", { headers: { accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) { paint(d.jobs || []); })
      .catch(function () { /* the server is restarting; the next tick will find it */ });
  }
  poll();
  setInterval(poll, 1200);

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-confirm]");
    if (b && !window.confirm(b.getAttribute("data-confirm"))) e.preventDefault();
  });

  // Tell the server where to send us back to.
  //
  // It used to read the Referer header, which these pages do not send — they
  // ship a referrer-policy precisely so that clicking through to Reddit tells
  // Reddit nothing. That made every action button dump you on the home page.
  // The policy is now same-origin so the no-JavaScript path works too; this
  // says it explicitly, which is the half that cannot be stripped.
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.method.toLowerCase() !== "post") return;
    if (f.querySelector('input[name="back"]')) return;
    var i = document.createElement("input");
    i.type = "hidden"; i.name = "back";
    i.value = location.pathname + location.search;
    f.appendChild(i);
  });

  // Queue deck shortcuts. Only where there is a deck to work.
  var deck = document.querySelector("[data-deck]");
  if (deck) {
    document.addEventListener("keydown", function (e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || "")) || e.metaKey || e.ctrlKey) return;
      var go = function (sel) { var el = deck.querySelector(sel); if (el) el.click(); };
      if (e.key === "j" || e.key === "ArrowRight") { e.preventDefault(); go("[data-next]"); }
      if (e.key === "k" || e.key === "ArrowLeft") { e.preventDefault(); go("[data-prev]"); }
      if (e.key === "s") { e.preventDefault(); go("[data-skip]"); }
      if (e.key === "o") { e.preventDefault(); go("[data-open]"); }
      if (e.key === "d") { e.preventDefault(); go("[data-draft]"); }
    });
  }
})();
`;
