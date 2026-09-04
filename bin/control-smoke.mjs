#!/usr/bin/env node
// The control lane, tried by hand — milestone 1, step 1's acceptance test,
// with no agent anywhere near it:
//
//   node bin/control-smoke.mjs [--base http://127.0.0.1:8787] [--url <page>] [--fixture | --reddit]
//
// Two passes, both against YOUR Chrome with the extension loaded and the
// dashboard running. The fixture pass (needs no site permission: the page is
// served from this process on 127.0.0.1) opens a page that records every
// event it receives and whether the browser marked it trusted, then drives
// the lane through it: a click the screen allows, four it refuses, a scroll
// by the wheel, a scroll to a control far down the page, a value typed into
// a plain field, typing into a composer refused, Enter in a form refused,
// a screenshot — and reads the page's own tally back: how many mouse moves
// and wheel ticks it saw, and that not one event was untrusted. The Reddit
// pass opens a search in your session under the "Messaging Quest" group,
// prints what the extension read, opens the first result with a click on
// its title — a link the screen lets through — and on the thread tries to
// click the comment box's opener with every grant there is — refused by
// the extension, in the page.
//
// If the lane is dark (no extension, no Chrome) each step says so and the
// script exits non-zero: "unanswered" is the honest answer, not a hang.

import { createServer } from "node:http";
import { controlClient } from "../lib/control.mjs";
import { CLICK_SCREEN } from "../extension/screen.js";

const argv = process.argv.slice(2);
const flag = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const base = flag("--base", process.env.MQ_RELAY || "http://127.0.0.1:8787");
const redditUrl = flag("--url", "https://www.reddit.com/r/smallbusiness/search/?q=how+do+I+get+clients&type=posts&sort=new&t=week");
const only = argv.includes("--fixture") ? "fixture" : argv.includes("--reddit") ? "reddit" : "both";
const ALL = ["read", "click", "type"];   // every grant, on purpose: the extension's own screen is what is being tested

const lane = controlClient(base);
const say = (s) => console.log(s);
const head = (s, n = 30) => String(s ?? "").split("\n").slice(0, n).join("\n");
let failed = false;
const step = (what, ok, detail) => { say(`${ok ? "  ok  " : "FAIL  "}${what}${detail ? `\n        ${detail}` : ""}`); if (!ok) failed = true; };

/** Every call's wall time, so the tempo can be reported at the end. */
const times = [];
const act = async (leaseId, tool, input, grants) => {
  const t0 = Date.now();
  const out = await lane.act(leaseId, tool, input, grants);
  // A refusal by the broker never reaches the browser, so it says nothing
  // about the browser's tempo.
  if (!(out?.refused && /grant/.test(out.error ?? "")) && tool !== "tabs_context") times.push({ tool: `${tool}${input?.action ? ` ${input.action}` : ""}`, ms: Date.now() - t0 });
  return out;
};

/* ---------------------------------------------------------------- fixture */

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>control lane fixture</title>
<style>
  body { font: 16px system-ui, sans-serif; margin: 0; color: #222; background: #fff; }
  main { max-width: 720px; margin: 0 auto; padding: 24px; }
  .spacer { height: 1600px; background: linear-gradient(#fff, #e8eef8); }
  pre { white-space: pre-wrap; background: #f4f4f4; padding: 8px; font-size: 13px; }
  button { font: inherit; padding: 6px 12px; }
  #composer { border: 1px solid #999; min-height: 60px; padding: 8px; }
</style></head>
<body><main>
  <h1>Control lane fixture</h1>
  <p>A page with the shapes the lane must handle: a button it may press, buttons it must refuse, a form, a composer. It records every event it gets and whether the browser marked it trusted.</p>
  <p id="stats">stats</p>
  <p><button id="more" type="button">Show more</button> <span id="count">0</span> presses</p>
  <p><button type="button" aria-label="Add a comment">Add a comment</button> <button type="button">Reply</button> <button type="button">Upvote</button></p>
  <shreddit-post><a id="title" href="#top">A thread title the lane may open</a> <span>r/fixture · 1 vote · 3 comments</span> <shreddit-join-button id="join">Join</shreddit-join-button></shreddit-post>
  <form id="f"><label>Name <input id="name" name="name" type="text" placeholder="Your name"></label>
    <label><input type="checkbox" id="agree" aria-label="Agree"> Agree</label> <button type="submit">Save</button></form>
  <div id="composer" contenteditable="true" aria-label="Add a comment">(composer)</div>
  <pre id="log"></pre>
  <div class="spacer"></div>
  <h2 id="deep">Deep down the page</h2>
  <p><button id="deepbtn" type="button">Deep button</button> <span id="deepcount">0</span> deep presses</p>
  <div class="spacer"></div>
</main>
<script>
  const L = []; const log = (s) => { L.push(s); document.getElementById("log").textContent = L.slice(-14).join("\\n"); };
  let moves = 0, wheels = 0, untrusted = 0;
  const tag = (e) => e.isTrusted ? "trusted" : "UNTRUSTED";
  addEventListener("mousemove", (e) => { moves++; if (!e.isTrusted) untrusted++; }, true);
  addEventListener("wheel", (e) => { wheels++; if (!e.isTrusted) untrusted++; log("wheel " + tag(e) + " dy=" + Math.round(e.deltaY) + " at " + Math.round(scrollY)); }, { capture: true, passive: true });
  addEventListener("click", (e) => { if (!e.isTrusted) untrusted++; log("click " + tag(e) + " on " + (e.target.textContent || e.target.tagName).trim().slice(0, 30)); }, true);
  addEventListener("keydown", (e) => { if (!e.isTrusted) untrusted++; log("key " + tag(e) + " " + e.key); }, true);
  addEventListener("input", (e) => { if (!e.isTrusted) untrusted++; log("input " + tag(e) + " into " + (e.target.id || e.target.tagName) + ": " + String(e.target.value ?? e.target.textContent).slice(0, 40)); }, true);
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); log("FORM SUBMITTED"); });
  document.getElementById("more").onclick = () => { const c = document.getElementById("count"); c.textContent = String(+c.textContent + 1); };
  document.getElementById("deepbtn").onclick = () => { const c = document.getElementById("deepcount"); c.textContent = String(+c.textContent + 1); };
  setInterval(() => { document.getElementById("stats").textContent = "moves=" + moves + " wheels=" + wheels + " untrusted=" + untrusted + " scrollY=" + Math.round(scrollY); }, 150);
</script>
</body></html>`;

// A fixed port when it is free, so the origin the extension sees is the same
// run after run (its host permission covers 127.0.0.1 on any port).
const serveFixture = () => new Promise((resolve) => {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(FIXTURE); });
  const up = () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/fixture` });
  srv.once("error", () => { srv.removeAllListeners("error"); srv.listen(0, "127.0.0.1", up); });
  srv.listen(Number(flag("--fixture-port", 8790)), "127.0.0.1", up);
});

const stats = (text) => {
  const m = /moves=(\d+) wheels=(\d+) untrusted=(\d+) scrollY=(\d+)/.exec(text ?? "");
  return m ? { moves: +m[1], wheels: +m[2], untrusted: +m[3], scrollY: +m[4] } : null;
};
const refOf = (found, re) => (found.matches ?? []).find((m) => re.test(`${m.name} ${m.text}`.trim()) && /^(button|link|textbox|checkbox|searchbox|combobox|input|a|div|textarea)$/i.test(m.role))?.ref;

// Wait for the leased tab to reach a state — a page a click just opened —
// asking tabs_context (a read the tempo does not count) every so often.
const settle = async (L, ok, ms) => {
  const t0 = Date.now();
  for (;;) {
    const c = await act(L, "tabs_context", {}, ALL);
    const t = c.tabs?.[0];
    if (t && ok(t)) return t;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 700));
  }
};

async function fixturePass() {
  const { srv, url } = await serveFixture();
  say(`fixture pass — ${url}\n`);
  try {
    const t0 = Date.now();
    const lease = await lane.lease("smoke test (fixture)", url);
    step("lease a tab on the fixture", !lease.error, lease.error ?? `tab ${lease.tabId} in group ${lease.groupId} after ${Date.now() - t0}ms`);
    if (lease.error) return;
    const L = lease.id;

    const tree = await act(L, "read_page", { filter: "interactive", max_chars: 20_000 }, ALL);
    step("read_page returns refs", !tree.error && /\[ref_\d+\]/.test(tree.tree ?? ""), tree.error ?? `${tree.lines} interactive nodes`);
    if (tree.error) return;

    const found = await act(L, "find", { query: "button" }, ALL);
    const more = refOf(found, /show more/i), comment = refOf(found, /add a comment/i), reply = refOf(found, /^reply/i), upvote = refOf(found, /upvote/i), save = refOf(found, /save/i), deep = refOf(found, /deep button/i);
    step("find sees the buttons", Boolean(more && comment && reply && upvote && save && deep), found.error ?? `${found.matches?.length} matches`);

    const press = await act(L, "computer", { action: "left_click", ref: more }, ALL);
    let text = await act(L, "get_page_text", { max_chars: 6000 }, ALL);
    step("a plain button gets a real click", !press.error && /1 presses/.test(text.text ?? ""), press.error ?? (/click trusted on Show more/.test(text.text ?? "") ? "the page saw a trusted click on Show more" : "the page did not log a trusted click"));

    // A post is a container, not a control: the title link inside one is
    // clicked for its own label, not for the "1 vote · 3 comments" beside it.
    // A custom-element control with a short label is still screened.
    const titleRef = refOf(await act(L, "find", { query: "thread title" }, ALL), /thread title/i);
    const opened = await act(L, "computer", { action: "left_click", ref: titleRef }, ALL);
    text = await act(L, "get_page_text", { max_chars: 6000 }, ALL);
    const titleSeen = /click trusted on A thread title/.test(text.text ?? "");
    step("a title link inside a post container gets a real click", !opened.error && !opened.refused && titleSeen, opened.error ?? (titleSeen ? "the page saw a trusted click on the title" : "the page did not log a trusted click on the title"));
    const joinRef = (await act(L, "find", { query: "join" }, ALL)).matches?.find((m) => /^shreddit-/.test(m.role))?.ref;
    const join = await act(L, "computer", { action: "left_click", ref: joinRef }, ALL);
    step('"Join", a custom-element control, is refused in the page', Boolean(join.refused) && /join/i.test(join.error ?? ""), join.error ?? "IT CLICKED");

    for (const [ref, what] of [[comment, "Add a comment"], [reply, "Reply"], [upvote, "Upvote"], [save, "Save (a form's submit)"]]) {
      const r = await act(L, "computer", { action: "left_click", ref }, ALL);
      step(`"${what}" is refused in the page`, Boolean(r.refused), r.error ?? "IT CLICKED");
    }

    const typing = await act(L, "computer", { action: "type", text: "hello" }, ALL);
    step("typing with a button focused is refused", Boolean(typing.refused), typing.error ?? "it typed");

    const composer = (await act(L, "find", { query: "(composer)" }, ALL)).matches?.find((m) => m.role === "textbox")?.ref;
    const into = await act(L, "computer", { action: "left_click", ref: composer }, ALL);
    const typed = await act(L, "computer", { action: "type", text: "hello" }, ALL);
    step("typing into a focused composer is refused", !into.error && Boolean(typed.refused) && /composer/.test(typed.error ?? ""), into.error ?? typed.error ?? "IT TYPED INTO THE COMPOSER");

    const nameRef = (await act(L, "find", { query: "your name" }, ALL)).matches?.[0]?.ref;
    const filled = await act(L, "form_input", { ref: nameRef, value: "Ada L. (x=1, y?)" }, ALL);
    step("form_input types a value with real keys, punctuation included", filled.value === "Ada L. (x=1, y?)", filled.error ?? `value is now ${JSON.stringify(filled.value)}`);

    const enter = await act(L, "computer", { action: "key", text: "Enter" }, ALL);
    step("Enter in a form's field is refused", Boolean(enter.refused), enter.error ?? "IT PRESSED ENTER");
    const chord = await act(L, "computer", { action: "key", text: "ctrl+Enter" }, ALL);
    step("ctrl+Enter is refused anywhere", Boolean(chord.refused), chord.error ?? "IT PRESSED THE CHORD");

    const agreeRef = (await act(L, "find", { query: "agree" }, ALL)).matches?.find((m) => m.role === "checkbox")?.ref;
    const ticked = await act(L, "form_input", { ref: agreeRef, value: true }, ALL);
    step("a checkbox gets a real click", ticked.checked === true, ticked.error ?? `checked: ${ticked.checked}`);

    const before = stats((await act(L, "get_page_text", { max_chars: 6000 }, ALL)).text);
    const scrolled = await act(L, "computer", { action: "scroll", scroll_direction: "down", scroll_amount: 5 }, ALL);
    text = await act(L, "get_page_text", { max_chars: 6000 }, ALL);
    const after = stats(text.text);
    step("scroll is wheel ticks the page can see", !scrolled.error && after && after.wheels > (before?.wheels ?? 0) && after.scrollY > (before?.scrollY ?? 0), scrolled.error ?? `wheels ${before?.wheels ?? "?"} → ${after?.wheels ?? "?"}, scrollY ${before?.scrollY ?? "?"} → ${after?.scrollY ?? "?"}`);

    const to = await act(L, "computer", { action: "scroll_to", ref: deep }, ALL);
    const deepPress = await act(L, "computer", { action: "left_click", ref: deep }, ALL);
    text = await act(L, "get_page_text", { max_chars: 6000 }, ALL);
    step("scroll_to reaches a control far down, and it gets clicked", to.inView === true && !deepPress.error && /1 deep presses/.test(text.text ?? ""), to.error ?? deepPress.error ?? `scrollY ${to.scrollY}`);

    const hover = await act(L, "computer", { action: "hover", ref: more }, ALL);
    step("hover travels back up the page", !hover.error, hover.error ?? `pointer at ${Math.round(hover.x)},${Math.round(hover.y)}`);

    const shot = await act(L, "computer", { action: "screenshot" }, ALL);
    step("screenshot", !shot.error && /^data:image\/png/.test(shot.screenshot ?? ""), shot.error ?? `${shot.width}×${shot.height}`);

    const log = await act(L, "read_console_messages", {}, ALL);
    step("console reader uses the Log domain only", !log.error && /Log domain|console\.log calls are not/.test(log.note ?? ""), log.error ?? `${log.total} entries`);

    const finalStats = stats((await act(L, "get_page_text", { max_chars: 6000 }, ALL)).text);
    step("the page saw a moving mouse and a wheel", Boolean(finalStats && finalStats.moves > 20 && finalStats.wheels > 3), finalStats ? `moves=${finalStats.moves} wheels=${finalStats.wheels}` : "no stats line");
    step("not one event was untrusted", finalStats?.untrusted === 0, finalStats ? `untrusted=${finalStats.untrusted}` : "no stats line");
    say("\n" + head((text.text ?? "").split("\n").filter((l) => /^(wheel|click|key|input|FORM)/.test(l)).join("\n"), 14) + "\n");

    const rel = await lane.release(L);
    step("release closes the tab", rel.ok === true, rel.error);
  } finally {
    srv.close();
  }
}

/* ----------------------------------------------------------------- reddit */

async function redditPass() {
  say(`\nreddit pass — ${redditUrl}\n`);
  const t0 = Date.now();
  const lease = await lane.lease("smoke test (reddit)", redditUrl);
  step("lease a tab", !lease.error, lease.error ?? `tab ${lease.tabId} in group ${lease.groupId} after ${Date.now() - t0}ms`);
  if (lease.error) return;
  const L = lease.id;

  const ctx = await act(L, "tabs_context", {}, ALL);
  step("tabs_context sees the tab", !ctx.error, ctx.error ?? JSON.stringify(ctx.tabs?.[0]));

  const tree = await act(L, "read_page", { filter: "interactive", max_chars: 20_000 }, ALL);
  step("read_page returns an accessibility tree with refs", !tree.error && /\[ref_\d+\]/.test(tree.tree ?? ""), tree.error ?? `${tree.lines} interactive nodes on "${tree.title}"`);
  if (tree.tree) say("\n" + head(tree.tree, 25) + "\n        …\n");

  const text = await act(L, "get_page_text", { max_chars: 4000 }, ALL);
  step("get_page_text reads the flat tree", !text.error && (text.text ?? "").length > 0, text.error ?? `${text.text?.length} characters`);
  if (text.text) say("\n" + head(text.text, 12) + "\n        …\n");

  // What a person does next: open a result. Its title is a link to the
  // thread, and the screen must let that click through — the words it
  // refuses are a control's own, not the "1 vote · 3 comments" beside it.
  const screen = new RegExp(CLICK_SCREEN, "i");
  const links = await act(L, "find", { query: "/comments/" }, ALL);
  const title = (links.matches ?? []).find((m) => m.role === "link" && /\/comments\/[a-z0-9]+/i.test(m.href ?? "") && m.name && !screen.test(m.name));
  step("find names the results' thread links", Boolean(title), links.error ?? `${links.matches?.length ?? 0} matches, none a named link clear of the screen's words`);

  let onThread = false;
  if (title) {
    say(`\n  opening ${title.ref} — link "${title.name}"`);
    const open = await act(L, "computer", { action: "left_click", ref: title.ref }, ALL);
    step("a title link gets a real click", !open.error && !open.refused, open.error);
    const thread = open.error ? null : await settle(L, (t) => /\/comments\//.test(t.url ?? "") && t.status === "complete", 20_000);
    step("...and the thread opens in the same tab", Boolean(thread), thread ? `"${thread.title}"` : "the tab never reached a /comments/ page");
    onThread = Boolean(thread);
  }

  // The thread's comment box, with every grant there is: refused in the page.
  const found = await act(L, "find", { query: "comment" }, ALL);
  step("find locates 'comment' controls", !found.error, found.error ?? `${found.matches?.length ?? 0} matches`);
  const opener = (found.matches ?? []).find((m) => /\bcomment\b/i.test(`${m.name} ${m.text}`) && `${m.name} ${m.text}`.trim().length <= 40 && m.role !== "link");
  if (opener) {
    say(`\n  trying to click ${opener.ref} — ${opener.role} "${opener.name || opener.text}" — with every grant`);
    const click = await act(L, "computer", { action: "left_click", ref: opener.ref }, ALL);
    step("the click is refused by the extension's label screen", Boolean(click.refused) || /click refused/.test(click.error ?? ""), click.error ?? "IT CLICKED — the screen did not fire");
  } else {
    step("a 'comment' control to try", false, found.error ?? (onThread ? `nothing on the thread carries the word; first matches: ${JSON.stringify((found.matches ?? []).slice(0, 6))}` : "not on a thread, and a search page has no comment box"));
  }

  // The grant screen, one layer up: the same click with read-only grants never
  // reaches the browser at all.
  const gated = await act(L, "computer", { action: "left_click", coordinate: [10, 10] }, ["read"]);
  step("...and with read-only grants it is refused by the broker first", gated.refused === true, gated.error);

  const scrolled = await act(L, "computer", { action: "scroll", scroll_direction: "down", scroll_amount: 4 }, ALL);
  step("a wheel scroll on the real page", !scrolled.error && (scrolled.scrollY ?? 0) > 0, scrolled.error ?? `scrollY ${scrolled.scrollY}`);

  const shot = await act(L, "computer", { action: "screenshot" }, ALL);
  step("screenshot", !shot.error && /^data:image\/png/.test(shot.screenshot ?? ""), shot.error ?? `${shot.width}×${shot.height}, scale ${shot.scale?.toFixed?.(2)}`);

  const rel = await lane.release(L);
  step("release closes the tab", rel.ok === true, rel.error);
}

/* ------------------------------------------------------------------- run */

say(`control lane at ${base}\n`);
if (only !== "reddit") await fixturePass();
if (only !== "fixture") await redditPass();

if (times.length) {
  const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  say(`\ntempo: ${times.length} calls, fastest ${sorted[0]}ms, median ${med}ms, slowest ${sorted[sorted.length - 1]}ms — every call waits an uneven moment first, by design`);
  step("no call came back instantly", sorted[0] >= 200, `fastest was ${sorted[0]}ms`);
}

say(failed ? "\nsomething is off — see FAIL above" : "\nthe lane works: leased, read, refused, scrolled, released — and the page saw only a person's kind of events.");
process.exit(failed ? 1 : 0);
