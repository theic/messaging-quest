#!/usr/bin/env node
// The hub — the one process that is meant to be reachable from off this
// machine, and therefore the one that is allowed to do almost nothing.
//
// It is a SEPARATE PROGRAM ON A SEPARATE PORT from the dashboard, and that is
// the whole security design rather than an organisational preference. The
// dashboard on 8787 has your prospects on it, your memory files, an undo that
// rewrites who you have contacted, and a form that takes an OpenRouter key.
// Tunnelling to 8787 to share a feed publishes every one of those. So the
// tunnel points here instead, and here there is nothing else to reach:
//
//   GET /feed?after=<cursor>&limit=<n>   Bearer token required
//   GET /health                          says "ok", nothing else
//
// There is no POST. There is no HTML. There is no route that reads any file
// except found.jsonl, and what it returns from that is an allowlist of fields.
// Everything a client does with what it gets — judging, drafting, marking,
// retiring somebody — happens on the client's own machine against the client's
// own rule.md. This process never learns any of it.
//
//   node bin/hub.mjs [--port 8788]
//
// Then point a tunnel at 127.0.0.1:8788 (Tailscale if the clients are yours,
// Cloudflare Tunnel if they are customers) and hand each client a token from
// the dashboard's Settings page.

import "../lib/node.mjs";   // the Node host for lib/fs.mjs — first, before anything in lib/
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { store, dataDir } from "../lib/store.mjs";
import { feedSince, validToken } from "../lib/feed.mjs";

const DIR = dataDir();
const argv = process.argv.slice(2);
const PORT = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : 8788;
if (!existsSync(DIR)) { console.error(`mq hub: no ${DIR}/ here — run \`mq init\` first`); process.exit(1); }
const S = store(DIR, (m) => { throw new Error(m); });

const json = (res, body, status = 200) =>
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // Nothing here is meant to be read by a page in a browser, so no CORS
    // header is sent and none should be added: a client is `mq pull`, which is
    // not subject to the same-origin policy and does not need permission.
    "x-content-type-options": "nosniff",
  }).end(JSON.stringify(body));

/** Bearer, or the `token` query parameter for clients behind something that
 *  eats Authorization headers. Both are the same secret and both are hashed
 *  before comparison. */
const presented = (req, url) => {
  const h = String(req.headers.authorization ?? "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : url.searchParams.get("token") ?? "";
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method !== "GET") return json(res, { error: "this hub is read-only" }, 405);
  if (url.pathname === "/health") return json(res, { ok: true });
  if (url.pathname !== "/feed") return json(res, { error: "not found" }, 404);

  const who = validToken(DIR, presented(req, url));
  if (!who) {
    // No detail about why. A hub that distinguishes "no token" from "wrong
    // token" is a hub that helps somebody guess.
    return json(res, { error: "unauthorized" }, 401);
  }

  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 500), 1000);
  const out = feedSince(S.readJsonl("found.jsonl"), url.searchParams.get("after") ?? "", limit);
  console.log(`${new Date().toISOString()}  ${who.label}  ${out.items.length} items  cursor ${out.cursor}`);
  return json(res, out);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mq hub  http://127.0.0.1:${PORT}/feed`);
  console.log(`serving found.jsonl only — public posts, nothing about you or your clients.`);
  console.log(`point a tunnel at this port. Never tunnel to the dashboard on 8787.`);
  console.log(`ctrl-c to stop.`);
});
