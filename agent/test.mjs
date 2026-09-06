#!/usr/bin/env node
// The runtime's tests — the ones that need the brain installed, so they live
// beside it and not in bin/test.mjs (which must run on a bare Node with no
// node_modules anywhere). CI's brain job runs this after `npm run brain`.
//
//   node agent/test.mjs
//
// No model is called: a SCRIPTED chat model plays the colleague, so what is
// tested is the runtime around it — the thread pausing on ask_person, the
// answer resuming it, the record surviving a "restart" (a second manager on
// the same directory), cancel, the deadline, the lease opened and released,
// and every one of those said into the inbox. The control lane is a stub
// that remembers what it was asked to do.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { taskManager, normalizeQuestions } from "./tasks.mjs";
import { loadSkills } from "../lib/skills.mjs";
import { setPlan } from "../lib/models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ES = join(here, "..", "bin", "mq.mjs");

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } };

/* ------------------------------------------------------------ the players */

/** A chat model that follows a script: each call runs the next step, which
 *  looks at the messages so far and returns an AIMessage. The count is shared
 *  across bound copies, because createAgent binds tools onto a new instance. */
class ScriptedModel extends BaseChatModel {
  constructor(script, shared = { calls: 0 }) { super({}); this.script = script; this.shared = shared; }
  _llmType() { return "scripted"; }
  bindTools() { return new ScriptedModel(this.script, this.shared); }
  async _generate(messages) {
    const step = this.script[Math.min(this.shared.calls, this.script.length - 1)];
    this.shared.calls++;
    const message = step(messages);
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

const lastToolContent = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const type = typeof m.getType === "function" ? m.getType() : m._getType?.();
    if (type === "tool") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  return "";
};

/** The control lane, stubbed: leases are tabs 100, 101, …; every call is
 *  remembered; a screenshot answers a one-pixel PNG. */
function stubControl() {
  const calls = [];
  let n = 100;
  const released = [];
  const adopted = [];
  return {
    calls, released, adopted,
    async lease({ task, url }) { const tabId = n++; calls.push(["lease", url]); return { id: `L${tabId}`, tabId, groupId: 1 }; },
    async act(lease, tool, input) {
      calls.push([tool, input?.action ?? input?.url ?? input?.query ?? null]);
      // A wait takes time in a real browser; instantly answered, a looping
      // colleague spends its 120 steps in a second and "fails" before a
      // cancel or a deadline could ever reach it.
      if (tool === "computer" && input?.action === "wait") await sleep(200);
      if (tool === "computer" && input?.action === "screenshot")
        return { screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", width: 1, height: 1, scale: 1 };
      return { ok: true, tree: `heading "Example Domain"\nlink "More information" [ref_1]`, text: "Example Domain. This domain is for use in illustrative examples." };
    },
    async release(lease) { released.push(lease); return { ok: true }; },
    adopt(l) { adopted.push(l.id); return l; },
  };
}

/* ------------------------------------------------------------- the stage */

const box = mkdtempSync(join(tmpdir(), "mq-agent-"));
const DIR = join(box, ".mq");
execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DIR }, stdio: "ignore" });
setPlan(DIR, "local");   // a model seat that needs no key, so start() is allowed; the model itself is scripted

// The template colleague, dropped into the LOCAL ring the way a person would
// try it: copy skills/_template/ to .mq/skills/<id>/, give the SKILL.md a name.
const ring = join(DIR, "skills", "pause-test");
mkdirSync(ring, { recursive: true });
writeFileSync(join(ring, "SKILL.md"), "---\nname: pause-test\ndescription: The template colleague, for the pause test.\n---\n\n# pause-test\n\nReads a page and asks before a second.\n");
writeFileSync(join(ring, "agent.md"), readFileSync(join(here, "..", "skills", "_template", "agent.md"), "utf8"));
loadSkills(DIR);

/* ---------------------------------------------------------- the question */

check("a question list is normalised, bad ids dropped, duplicates dropped",
  normalizeQuestions([{ id: "ok", question: "q" }, { id: "bad id!", question: "q" }, { id: "ok", question: "again" }]).map((q) => q.id), ["ok"]);
check("...and capped at twelve", normalizeQuestions(Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, question: "q" }))).length, 12);

/* --------------------------------------------------- the pause, end to end */

{
  const control = stubControl();
  // Turn 1: read the page. Turn 2: ask. Turn 3 (after the answer): report.
  const script = [
    () => new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "read_page", args: { filter: "interactive" } }] }),
    () => new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "ask_person", args: { questions: [{ id: "second", question: "Read a second page?", choices: [{ id: "yes", label: "yes, this one" }, { id: "no", label: "no, that is enough" }], field: { placeholder: "https://…" } }] } }] }),
    (messages) => new AIMessage({ content: `The page is Example Domain. You answered ${lastToolContent(messages)}. Done.` }),
  ];
  const T = taskManager(DIR, { control, modelFor: () => new ScriptedModel(script) });
  const local = T.colleagues().find((c) => c.id === "pause-test");
  check("the local ring's agent.md is a colleague, beside the built-in scout", [local?.name, local?.grants, T.colleagues().some((c) => c.id === "reddit")], ["page-reader", ["read"], true]);
  check("...with the question list and no click", local?.tools, ["browser.read", "ask_person"]);

  check("a colleague nobody installed is refused by name", (await T.start("nobody", {})).error?.startsWith("no colleague"), true);
  check("a browser colleague needs somewhere to open", (await T.start("pause-test", {})).error?.includes("url"), true);

  const { id } = await T.start("pause-test", { url: "https://example.com/" }, { title: "read example.com" });
  check("a task starts at once, running", T.get(id).status, "running");
  const blocked = await until(() => T.get(id).status === "blocked" && T.get(id));
  check("the ask_person call pauses the thread — the task is blocked", blocked?.status, "blocked");
  check("...on the question it asked", blocked?.questions?.map((q) => [q.id, q.choices.length]), [["second", 2]]);
  check("the tab was leased before the first turn, on the task's url", control.calls[0], ["lease", "https://example.com/"]);
  check("...and the read went through the lane with the lease's grants", control.calls.some((c) => c[0] === "read_page"), true);
  const shot = await until(() => T.get(id).shot);
  check("a blocked worker's card carries what it saw", Boolean(shot), true);
  check("...saved on disk, never anywhere else", existsSync(T.screenshotPath(id)), true);

  const types = () => T.inbox().events.map((e) => e.type);
  check("the inbox heard it start, take a tab, and block", ["task.started", "task.tab", "task.blocked"].every((t) => types().includes(t)), true);

  /* The restart: a second manager on the same directory. The record is on
     disk, the interrupt is in the checkpoint, the tab is re-adopted. */
  const control2 = stubControl();
  const T2 = taskManager(DIR, { control: control2, modelFor: () => new ScriptedModel(script, { calls: 2 }) });
  check("after a restart the task is still blocked on the same question", [T2.get(id).status, T2.get(id).questions[0].id], ["blocked", "second"]);
  check("...and its tab was re-adopted, not re-opened", [control2.adopted, control2.calls.filter((c) => c[0] === "lease").length], [[`L100`], 0]);

  check("answering a question that was not asked is refused", T2.answerQuestion(id, "nope", "x").error?.includes("not the one"), true);
  const one = T2.answerQuestion(id, "second", { choice: "no", text: "" });
  check("the last answer completes the list and resumes the thread", one, { ok: true, complete: true });
  const done = await until(() => T2.get(id).status === "done" && T2.get(id));
  check("the resumed thread finishes", done?.status, "done");
  check("...with the answer in the tool's return, so the model read it", /"choice":"no"/.test(done?.result ?? ""), true);
  check("...and its tab released", control2.released.length, 1);
  check("the result is the report, for the card", done?.result?.startsWith("The page is Example Domain"), true);
  const t2 = T2.inbox().events.map((e) => e.type);
  check("the inbox heard the answer and the finish", ["task.answered", "task.done"].every((t) => t2.includes(t)), true);
  check("a done task needs acknowledging once", [T2.get(id).acked, T2.ack(id).ok, T2.get(id).acked], [false, true, true]);

  /* Kill mid-run, come back: a task left "running" on disk is resumed from
     its checkpoint by the next manager. The finished thread has nothing left
     to do, so resuming it lands on done — without a model call. */
  const raw = JSON.parse(readFileSync(join(DIR, "tasks.json"), "utf8"));
  raw.tasks.find((t) => t.id === id).status = "running";
  writeFileSync(join(DIR, "tasks.json"), JSON.stringify(raw));
  const T3 = taskManager(DIR, { control: stubControl(), modelFor: () => new ScriptedModel([() => { throw new Error("the model should not be called"); }]) });
  const again = await until(() => T3.get(id).status === "done" && T3.get(id));
  check("a task found running after a restart continues from its checkpoint", again?.status, "done");
  check("...and says so", T3.inbox().events.some((e) => e.type === "task.resumed" && e.from === "checkpoint"), true);
}

/* ------------------------------------------------------------- cancelling */

{
  const control = stubControl();
  // A colleague that never stops waiting.
  const loop = [() => new AIMessage({ content: "", tool_calls: [{ id: `w${Date.now()}`, name: "computer", args: { action: "wait", duration: 1 } }] })];
  const T = taskManager(DIR, { control, modelFor: () => new ScriptedModel(loop) });
  const { id } = await T.start("pause-test", { url: "https://example.com/" }, { title: "wait forever" });
  await until(() => control.calls.some((c) => c[0] === "computer"));
  const out = await T.cancel(id, "the operator pressed Stop");
  check("a running task can be cancelled", [out.ok, T.get(id).status], [true, "cancelled"]);
  check("...its tab is released", control.released.length, 1);
  check("...and the inbox says why", T.inbox().events.find((e) => e.type === "task.cancelled")?.why, "the operator pressed Stop");
  check("cancelling it again is refused, not repeated", Boolean((await T.cancel(id)).error), true);

  /* The deadline is a running-time budget: a task that outlives it is
     cancelled with the budget named. */
  const T4 = taskManager(DIR, { control: stubControl(), modelFor: () => new ScriptedModel(loop), deadlineMs: 400 });
  const { id: slow } = await T4.start("pause-test", { url: "https://example.com/" }, { title: "too slow" });
  const late = await until(() => T4.get(slow).status === "cancelled" && T4.get(slow), 5000);
  check("a task past its running budget is cancelled, budget named", /budget/.test(late?.error ?? ""), true);
}

/* ------------------------------------------------------------- the grant */

{
  // A colleague whose definition grants nothing but reads asks for a click:
  // the runtime's tools carry the definition's grants, and the lane's screen
  // refuses before the browser hears of it. The stub lane accepts anything,
  // so this uses the REAL broker with a claimer that answers every job.
  const { controlBroker } = await import("../lib/control.mjs");
  let note = null;   // the lane's events reach the inbox once the manager exists, as in bin/serve.mjs
  const broker = controlBroker({ ttlMs: 5000, paceMs: 0, onEvent: (e) => note?.(e) });
  const claimer = (async () => { for (let i = 0; i < 40; i++) { const jobs = await broker.claim(150); for (const j of jobs) broker.answer(j.id, j.tool === "lease" ? { tabId: 7 } : { ok: true, tree: "x" }); } })();
  const heard = [];
  const script = [
    () => new AIMessage({ content: "", tool_calls: [{ id: "k1", name: "computer", args: { action: "left_click", coordinate: [3, 3] } }] }),
    (messages) => { heard.push(lastToolContent(messages)); return new AIMessage({ content: "gave up clicking" }); },
  ];
  const T = taskManager(DIR, { control: broker, modelFor: () => new ScriptedModel(script) });
  note = (e) => T.note(e.type, e);
  const { id } = await T.start("pause-test", { url: "https://example.com/" }, { title: "tries to click" });
  const done = await until(() => T.get(id).status === "done" && T.get(id));
  check("a read-only colleague's click is refused by the lane", /needs the .?.click.?. grant/.test(heard[0] ?? ""), true);
  check("...and the model is told, in the tool's own answer, so it can stop", done?.result, "gave up clicking");
  check("...while the refusal is on the record", T.inbox().events.some((e) => e.type === "call.refused"), true);
  await claimer;
}

/* ---------------------------------------------------------------- the scout */

// The built-in reddit colleague, driven by a script: it reads the page,
// records what it saw through record_findings — which is `mq found`, the same
// table and refusals as a probe — and reports the CLI's own count.
{
  const control = stubControl();
  const script = [
    () => new AIMessage({ content: "", tool_calls: [{ id: "s1", name: "get_page_text", args: {} }] }),
    () => new AIMessage({ content: "", tool_calls: [{ id: "s2", name: "record_findings", args: { place: "saas", q: "how do I get clients", url: "https://www.reddit.com/r/saas/search/?q=x", items: [{ url: "https://www.reddit.com/r/saas/comments/zz9/x/", title: "how do I get clients", author: "u/ana", body: "stuck" }] } }] }),
    (messages) => new AIMessage({ content: `Recorded: ${lastToolContent(messages).split("\n")[0]}` }),
  ];
  const T = taskManager(DIR, { control, modelFor: () => new ScriptedModel(script) });
  check("the built-in reddit scout is a colleague, read-only", T.colleagues().find((c) => c.id === "reddit")?.grants, ["read"]);
  const { id } = await T.start("reddit", { url: "https://www.reddit.com/r/saas/search/?q=how+do+I+get+clients&type=posts&restrict_sr=1" }, { title: "search r/saas" });
  const done = await until(() => T.get(id).status === "done" && T.get(id));
  check("its findings land in found.jsonl through the CLI", readFileSync(join(DIR, "found.jsonl"), "utf8").includes("t3_zz9"), true);
  check("...and its report quotes the CLI's count, not its own", /1 new post/.test(done?.result ?? ""), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
