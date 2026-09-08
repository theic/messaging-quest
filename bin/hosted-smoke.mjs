#!/usr/bin/env node
// The hosted extension, end to end, in a Chrome of its own.
//
// Loads this checkout unpacked into a scratch profile of a Chrome for
// Testing binary (Google Chrome itself stopped honouring --load-extension
// in 137), drives it over the DevTools protocol, and checks what the panel
// and the worker do with no server anywhere: the worker boots the engine,
// the panel deals the first card from it, a card action lands in IndexedDB,
// the Settings tab offers the account, a probe runs in-process up to the
// grant wall for reddit. Nothing is granted and nothing is read off reddit;
// the lane's reads are the same code the local mode runs live (0.9.2).
//
//   MQ_CHROME="C:/path/to/chrome-win64/chrome.exe" node bin/hosted-smoke.mjs [--headed] [--keep]
//
// Get a binary with `npx @puppeteer/browsers install chrome@stable --path <short dir>`
// (a short path: the browser's side-by-side manifests do not survive a long one).
// Not part of `npm test` — it needs the binary and a minute; bin/test.mjs
// covers the same engine on the memory host under Node.

import "../lib/node.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.MQ_CHROME;
if (!CHROME || !existsSync(CHROME)) { console.error("set MQ_CHROME to a Chrome for Testing binary — see the header of this file"); process.exit(2); }
const PROFILE = join(tmpdir(), "mq-hosted-smoke");
const PORT = Number(process.env.MQ_CDP_PORT) || 9335;
const keep = process.argv.includes("--keep");
const headed = process.argv.includes("--headed");

if (!keep && existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`, `--load-extension=${REPO}`, `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
  ...(headed ? [] : ["--headless=new", "--window-size=1200,900"]),
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { return []; } };
let pass = 0, fail = 0;
const check = (what, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`); ok ? pass++ : fail++; };
const watchdog = setTimeout(() => { console.log("FAIL  the run took too long"); try { chrome.kill(); } catch { /* gone */ } process.exit(2); }, 150_000);
const timed = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

class CDP {
  constructor(ws) { this.ws = ws; this.n = 0; this.waits = new Map(); this.events = []; ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && this.waits.has(d.id)) { this.waits.get(d.id)(d); this.waits.delete(d.id); } else this.events.push(d); }); }
  static async open(url) { const ws = new WebSocket(url); await timed(new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }), 10_000, "websocket open"); return new CDP(ws); }
  send(method, params = {}, ms = 20_000) { const id = ++this.n; this.ws.send(JSON.stringify({ id, method, params })); return timed(new Promise((res) => this.waits.set(id, res)), ms, method); }
  async eval(expr, ms = 20_000) { const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, ms); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text ?? "eval failed"); return r.result?.result?.value; }
  logs() { return this.events.filter((e) => /^(Runtime\.consoleAPICalled|Runtime\.exceptionThrown|Log\.entryAdded)$/.test(e.method)).map((e) => e.method === "Runtime.consoleAPICalled" ? `${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}` : e.method === "Runtime.exceptionThrown" ? `exception: ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text}` : `log: ${e.params.entry?.text}`); }
  close() { this.ws.close(); }
}
const msg = (pc, body, ms = 15_000) => pc.eval(`chrome.runtime.sendMessage(${JSON.stringify(body)})`, ms);

try {
  let list = [], sw = null;
  for (let i = 0; i < 60 && !sw; i++) { await sleep(500); list = await targets(); sw = list.find((t) => t.type === "service_worker" && /\/extension\/sw\.js$/.test(t.url)); }
  check("the worker is up from the repo root manifest", Boolean(sw), true);
  if (!sw) throw new Error("no worker among " + JSON.stringify(list.map((t) => [t.type, t.url])));
  const extId = new URL(sw.url).host;
  const swc = await CDP.open(sw.webSocketDebuggerUrl);
  await swc.send("Runtime.enable"); await swc.send("Log.enable");
  const pc = await CDP.open(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await pc.send("Runtime.enable"); await pc.send("Log.enable"); await pc.send("Page.enable");
  await pc.send("Page.navigate", { url: `chrome-extension://${extId}/extension/sidepanel.html` });
  await sleep(3000);
  check("the engine's module graph loads in the extension", await pc.eval(`import(chrome.runtime.getURL("extension/engine.js")).then(() => "ok", (e) => "ERR " + (e.stack || e.message))`, 30_000), "ok");
  check("the worker answers a settings message: hosted", (await msg(pc, { type: "settings" }))?.mode, "hosted");

  const state = async () => pc.eval(`(() => ({ card: document.getElementById("card")?.textContent?.slice(0, 160) ?? null, dashHidden: document.getElementById("dash")?.hidden ?? null }))()`);
  let s = await state();
  for (let i = 0; i < 20 && !/username|account/i.test(s.card ?? ""); i++) { await sleep(1000); s = await state(); }
  check("the panel is hosted (no dashboard link) and the first card came from the engine in the worker", [s.dashHidden, /username|account/i.test(s.card ?? "")], [true, true]);

  const cards = await msg(pc, { type: "api", method: "GET", path: "/api/cards", query: {}, body: null });
  check("GET /api/cards over a message: the account card, the lane attached (this worker)", [cards.status, cards.body.cards[0]?.id, cards.body.control.attached], [200, "onboard.account", true]);
  const panel = await msg(pc, { type: "api", method: "GET", path: "/api/panel", query: {}, body: null });
  check("GET /api/panel: free plan, no server, reddit", [panel.status, panel.body.settings.plan, panel.body.settings.server, panel.body.settings.platform.id], [200, "free", null, "reddit"]);
  check("a card is acted on over a message", (await msg(pc, { type: "api", method: "POST", path: "/api/cards/act", query: {}, body: { card: "onboard.account", action: "skip" } })).status, 200);
  check("...and the deck moved", (await msg(pc, { type: "api", method: "GET", path: "/api/cards", query: {}, body: null })).body.cards[0]?.id !== "onboard.account", true);
  await sleep(500);
  const rows = await pc.eval(`new Promise((res, rej) => { const r = indexedDB.open("mq", 1); r.onsuccess = () => { const t = r.result.transaction("files", "readonly"); const q = t.objectStore("files").getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }; r.onerror = () => rej(r.error); })`);
  check("the files are on the disk (IndexedDB), the stash and the rule among them", [rows.length > 5, rows.includes("/mq/cards.json"), rows.includes("/mq/rule.md")], [true, true, true]);

  await pc.eval(`document.querySelector('.es-tabs [data-view="settings"]').click()`);
  await sleep(1500);
  const settingsText = await pc.eval(`document.getElementById("view-settings").textContent`);
  check("the Settings tab offers the account and says where the engine runs", [/Your account/.test(settingsText), /Send a code/.test(settingsText), /messaging\.quest/.test(settingsText), /runs inside this extension/.test(settingsText)], [true, true, true, true]);
  check("account.status: signed out", (await msg(pc, { type: "account.status" })).signedIn, false);
  await pc.eval(`document.querySelector('.es-tabs [data-view="deck"]').click()`);

  check("a probe starts in the worker", (await msg(pc, { type: "api", method: "POST", path: "/api/panel/act", query: {}, body: { do: "probe", place: "saas", q: "cold outreach" } })).status, 200);
  let seen = null;
  for (let i = 0; i < 25 && !seen; i++) { await sleep(1000); const d = (await msg(pc, { type: "api", method: "GET", path: "/api/cards", query: {}, body: null })).body; if (d.control.grants.length || d.recent.length) seen = d; }
  check("the probe opened the lane and stopped at the grant for reddit (a fresh profile has none)", [seen?.control.grants ?? null, seen?.cards[0]?.id ?? null], [["https://www.reddit.com"], "grant.https://www.reddit.com"]);
  const noise = swc.logs().filter((l) => /^(error|exception)/.test(l));
  check("the worker logged no error", noise, []);
  pc.close(); swc.close();
} catch (e) {
  fail++;
  console.log("FAIL  " + e.message);
} finally {
  clearTimeout(watchdog);
  chrome.kill();
  await sleep(500);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
