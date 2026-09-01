#!/usr/bin/env node
// The MCP server — Messaging Quest as a set of tools inside whatever assistant you
// already talk to. Claude Code, Claude Desktop, a ChatGPT client, an OpenClaw
// agent on your phone: anything that speaks MCP over stdio can triage your
// queue from wherever you are.
//
//   node bin/mcp.mjs            (run from the directory that holds .mq/)
//
// Claude Code:     claude mcp add mq -- node <path-to>/bin/mcp.mjs
// Claude Desktop:  {"mcpServers": {"mq": {"command": "node",
//                    "args": ["<path-to>/bin/mcp.mjs"], "cwd": "<project dir>"}}}
//
// THE DIVISION OF LABOUR, and it is the interesting part: the assistant on the
// other end of this pipe IS a model — so it can BE the judge and the writer.
// `pending` hands it the numbered items, `judge` takes its verdicts back, and
// `draft_material` hands it the same brief the dashboard's writer gets — your
// measured voice, the room's risks, what you can honestly claim — so the reply
// it drafts is written under your rules, not its defaults. Used this way,
// Messaging Quest needs no OpenRouter key at all: the model you already pay for does
// the judging, and this process is just the store and the etiquette.
//
// What is DELIBERATELY absent: `probe`, `tick`, `sync` — the reading verbs.
// Reading Reddit costs a minute a request and belongs to the machine that
// watches (the dashboard, a cron, a hub you pull from), not to a chat turn
// that times out. And there is no tool that posts anything anywhere, because
// there is no such code in this repo to expose.
//
// Zero dependencies, like everything else here: MCP over stdio is
// newline-delimited JSON-RPC, and that is thirty lines of plumbing.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY, readOne } from "../lib/memory.mjs";
import { dataDir } from "../lib/store.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ES = join(ROOT, "bin", "mq.mjs");
const DIR = dataDir();
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

if (!existsSync(DIR)) {
  console.error(`mq mcp: no ${DIR}/ in ${process.cwd()} — run \`mq init\` there first, or set MQ_DIR`);
  process.exit(1);
}

/** Every action goes through the CLI — one implementation of every verb, same
 *  as the dashboard's buttons. stdout IS the protocol channel here, so the
 *  child's output comes back as data and our own logging goes to stderr. */
const es = (args, stdin = null) =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, [ES, ...args],
      { env: { ...process.env, MQ_DIR: DIR }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, text: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() }));
    if (stdin !== null) child.stdin.end(stdin);
  });

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: "status",
    description: "What became of the things the operator said on Reddit, read as a logged-out stranger sees them: visible, filtered, removed, and what changed.",
    inputSchema: { type: "object", properties: {} },
    run: () => es(["status"]),
  },
  {
    name: "queue",
    description: "The people waiting for an answer — posts already judged as a fit and not yet handled. Returns JSON rows with id, place, author, title, body, url.",
    inputSchema: { type: "object", properties: {} },
    run: () => es(["queue", "--json"]),
  },
  {
    name: "pending",
    description: "Numbered items that still need a fit verdict, as JSON [{n, author, title, body}]. YOU can act as the judge: read .mq/rule.md (the rule_md resource), decide each, then call the judge tool.",
    inputSchema: { type: "object", properties: {} },
    run: () => es(["pending"]),
  },
  {
    name: "judge",
    description: "Record fit verdicts for pending items. Judge against the operator's rule.md and nothing else; when you cannot tell, the rule says to answer yes. Items you omit stay pending — that is a state, not a no.",
    inputSchema: {
      type: "object",
      required: ["verdicts"],
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            required: ["n", "fit", "why"],
            properties: {
              n: { type: "number", description: "The item number from `pending`." },
              fit: { type: "boolean", description: "True if this person should be answered." },
              why: { type: "string", description: "One sentence, quoting their words where you can." },
            },
          },
        },
      },
    },
    run: ({ verdicts }) => es(["judge"], JSON.stringify(verdicts ?? [])),
  },
  {
    name: "draft_material",
    description: "Everything needed to answer one person from the queue: what they said, the operator's measured voice rules, the room's risks, and what the operator can honestly claim (me.md). Write the reply FROM this material — never invent a first-person claim it does not contain — then call save_draft.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Item id from `queue`, e.g. t3_abc123." } } },
    run: ({ id }) => es(["draft", String(id ?? "")]),
  },
  {
    name: "save_draft",
    description: "Save a drafted reply and run Messaging Quest's refusals over it: repeated phrasing across your past drafts, invented links, and unverifiable first-person claims. Read the flags back to the operator — the draft is saved either way, and a human sends it themselves.",
    inputSchema: {
      type: "object",
      required: ["id", "text"],
      properties: {
        id: { type: "string", description: "The item this answers." },
        text: { type: "string", description: "The reply, ready to post." },
      },
    },
    run: ({ id, text }) => es(["draft", String(id ?? ""), "--save"], String(text ?? "")),
  },
  {
    name: "mark",
    description: "Log an item as answered (sent) or discard it (skip). `sent` retires that person from every future queue permanently, and is refused when the burst limits or the operator's standing in that room say no — relay the refusal, do not work around it. anyway=true only when the operator says the reply is already posted.",
    inputSchema: {
      type: "object",
      required: ["id", "mark"],
      properties: {
        id: { type: "string" },
        mark: { type: "string", enum: ["sent", "skip"] },
        anyway: { type: "boolean", description: "Only when the operator states the reply was already posted." },
      },
    },
    run: ({ id, mark, anyway }) => es(["mark", String(id ?? ""), String(mark ?? ""), ...(anyway ? ["--anyway"] : [])]),
  },
];

/* -------------------------------------------------------------- resources */

/* persona.md (optional: true) stays home: the assistant on this pipe holds the
   judge tool, and a judge that has read your persona judges in character. */
const RESOURCES = MEMORY.filter((m) => !m.optional).map((m) => ({
  uri: `mq://memory/${m.file}`,
  name: m.file,
  description: m.what,
  mimeType: "text/markdown",
}));

/* ----------------------------------------------------------------- server */

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  const notification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "messaging-quest", version: VERSION },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications get no reply, ever
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `no such tool: ${params?.name}`);
      const { ok, text } = await tool.run(params?.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: text || "(no output)" }], isError: !ok });
    }
    case "resources/list":
      return reply(id, { resources: RESOURCES });
    case "resources/read": {
      const uri = String(params?.uri ?? "");
      const file = uri.match(/^mq:\/\/memory\/([\w.-]+)$/)?.[1];
      const doc = file && readOne(DIR, file);
      if (!doc) return fail(id, -32602, `no such resource: ${uri}`);
      return reply(id, { contents: [{ uri, mimeType: "text/markdown", text: doc.body }] });
    }
    default:
      if (!notification) return fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
const inflight = new Set();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
  const p = handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
  inflight.add(p);
  p.finally(() => inflight.delete(p));
});
// stdin closing is the host hanging up — but a tool call that already started
// still owes its answer, so drain before leaving rather than killing it.
rl.on("close", async () => { await Promise.allSettled([...inflight]); process.exit(0); });

console.error(`mq mcp: serving ${DIR}/ over stdio — 7 tools, ${RESOURCES.length} resources`);
