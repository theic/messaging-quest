#!/usr/bin/env node
// Messaging Quest — the CLI: one implementation of every verb.
//
// It began as the listener: what the platform did to the comments you already
// wrote. It posts nothing, reads nobody else's account, calls no model, needs
// no key and sends nothing anywhere. Everything is append-only JSONL in .mq/.
//
// From 0.6.0 every read happens in the operator's own browser (lib/browse.mjs)
// — a real tab, rendered, read in the isolated world, closed after — and
// nowhere else; every verb acts on the current PROJECT (lib/projects.mjs); a
// person found under a CAMPAIGN (lib/campaigns.mjs) is judged and drafted
// under its direction; and nothing here names a platform — the active adapter
// (lib/platform.mjs) supplies the pages, the labels and the refusals.
//
// Why this and not a lead tool first: Reddit removed 154 million posts and
// comments in one half-year, 44.7% of them by admins, and told almost nobody.
// Its own description of the work is "our most effective work happens before a
// post is ever seen by a human." The only method anybody has for finding out is
// opening a private window by hand, one comment at a time. This is that, done
// continuously, with a memory.
//
// The store rules, and they are the whole design:
//   - items:  FIRST write wins. A re-read must never overwrite what you said.
//   - checks: nothing is ever overwritten. A comment that was visible on Monday
//             and is not on Thursday is the finding, and you only have it if
//             both reads are still on disk.

import "../lib/node.mjs";   // the Node host for lib/fs.mjs — first, before anything in lib/
import { existsSync, readFileSync } from "node:fs";
import { loadPlatforms } from "../lib/platform.mjs";
import { dataDir } from "../lib/store.mjs";
import { currentDir } from "../lib/projects.mjs";
import { verbs, VerbError } from "../lib/verbs.mjs";

// The verbs themselves are lib/verbs.mjs (0.10.0) — the dashboard and the
// extension's worker run the same functions in-process. This file is the
// terminal's door: argv, usage, stdin, exit codes.
const ROOT = dataDir();          // the root: the default project, the registry, the machine's files
const DIR = currentDir(ROOT);    // the project every verb below acts on
const die = (m) => { console.error(`mq: ${m}`); process.exit(1); };

// The registry finds skills/ and <ROOT>/skills/. Everything platform-mechanical
// the verbs do comes through the active adapter; nothing here names one.
await loadPlatforms(ROOT);
const cmds = verbs({ root: ROOT, dir: DIR });

/* ------------------------------------------------------------------- main */

const [, , cmd, ...args] = process.argv;
if (!cmd || !cmds[cmd]) {
  console.log(`Messaging Quest — your marketing specialist, one card at a time.
Every read below happens in a tab of YOUR browser (keep \`mq serve\` running,
Chrome open, the extension loaded); the stranger's view in an Incognito tab.

  init                    make .mq/ here
  me <username>           whose comments to listen to (yours)
  sync                    read your profile as a logged-out stranger
  add <permalink>         add one by hand — the path that still works
                          when your profile itself is invisible
  check [--all] [--limit N]   re-read each thread as a stranger
  back [--days N] [--limit N] who replied to you, and has not been answered
  waiting [--json]        the conversations waiting on you, oldest first
  status                  what became of the things you said
  log [item-id]           every check, in order

find — other people, and the rooms it refuses to look in

  probe <room> --q "..."  try a room once. Refuses parody rooms, rooms whose
        [--campaign <id>] own words forbid it, and shapes measured dead
  rooms                   which rooms' rules have been read, and which have not
  watch <room> [--q "..."] commit a probed room. Refuses until its rules are read
        [--campaign <id>]
  unwatch <id>            stop
  sources                 what is watched, and when each was last read
  tick [--limit N]        read what is due. No model runs in this loop
  found < items.json      record posts a colleague read in YOUR browser
                          ({place, q, campaign?, items:[{url,title,author,body}]})
                          — same table and refusals as probe, judged the same way
  pending                 what needs a verdict, numbered, as JSON
  judge < verdicts.json   [{n, fit, why}] — the model lives outside this process
  queue [--json]          who is waiting for an answer from you
  mark <id> sent|skip     answered, or discard. "sent" retires that person
                          from every future queue, permanently. Refused if the
                          burst limits or your standing say no; --anyway posts

  ready [<sub>]           where you stand, room by room, and your mix
  voice                   how you write, measured from your own comments
  draft <id>              the material for answering one person — three drafts, one per style
  draft <id> --save       save a reply (text) or a round of three ({"drafts":[…]}) and run the refusals over each
  draft <id> --note "…" --style <straight|deeper|ask>   the material for a rewrite, with your note on the last round

campaigns and projects

  campaigns               this project's campaigns: a direction each, never a template
  campaign show|pause|resume <id>
  projects                every project on this machine; * is the one every verb acts on
  project new "<name>"    another project — its own memory, store, campaigns, colleagues
  project use <id>        switch (the panel and the dashboard follow)

  serve [--port N]        the dashboard, on localhost, in your browser
  models                  where the models run — paid, free or local — and which has each seat
  models use <plan>       paid | free | local
  models set <role> <id>  judge | scout | writer, from that plan's menu (any tag, locally)
  models url <base-url>   the local server, default http://127.0.0.1:11434/v1 (Ollama)
  sweep                   drop stored bodies past 48h
  platforms               the platforms this install can read — each one is a
                          skill folder; drop your own into .mq/skills/
  skills                  the whole registry: running, stuck, refused
  skills use <slot> <id>  when two skills serve one purpose, pick the one
                          that runs (recorded in .mq/skills.json)

sharing one machine's reading with several

  pull <hub-url> --token <t>   take what another machine already found, instead
                          of spending a minute a request reading it again.
                          Public posts only. Judged here, against YOUR rule.md
  node bin/hub.mjs        BE that machine: a read-only feed of found.jsonl on
                          its own port. Tunnel to THAT, never to the dashboard

Nothing here posts, messages, votes, or reads anybody else's account.`);
  process.exit(cmd ? 1 : 0);
}
if (!existsSync(ROOT) && cmd !== "init") die(`no ${ROOT}/ here — run \`mq init\` first`);
// `judge` is the one place a verdict comes IN from outside — the model runs in
// whatever you point at this, never in here.
const wantsStdin = cmd === "judge" || cmd === "found" || (cmd === "draft" && args.includes("--save"));
const stdin = wantsStdin && !process.stdin.isTTY ? readFileSync(0, "utf8") : "";
try {
  await cmds[cmd](args, stdin);
} catch (e) {
  if (e instanceof VerbError) die(e.message);
  throw e;
}
