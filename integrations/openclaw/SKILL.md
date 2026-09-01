---
name: messaging-quest
description: Triage the operator's Messaging Quest queue — who is waiting for an answer on Reddit, judge new finds against their rule.md, draft replies in their measured voice. Local store, nothing posted, a human sends everything.
---

# Messaging Quest

Messaging Quest is a local tool that watches Reddit two ways: what happened to the
things the operator already said (visibility, as a logged-out stranger sees
it), and who is asking for the thing they sell. Everything lives in
`.mq/` in its project directory. **Nothing in it can post, vote, or
message — and neither do you. You draft; the operator sends.**

## How to drive it

Prefer MCP if this agent speaks it — same seven verbs, typed:

```
node <Messaging Quest>/bin/mcp.mjs        # run with cwd = the project directory
```

Otherwise the CLI (always run from the project directory, or set
`MQ_DIR`):

```
node bin/mq.mjs status            what became of the operator's own comments
node bin/mq.mjs queue --json      people already judged worth answering
node bin/mq.mjs pending           items needing a verdict, numbered JSON
node bin/mq.mjs judge             stdin: [{n, fit, why}] — you are the judge
node bin/mq.mjs draft <id>        the material for answering one person
node bin/mq.mjs draft <id> --save stdin: your reply — saved, refusals run
node bin/mq.mjs mark <id> sent|skip
```

## The rules you inherit

1. **Judge only against `.mq/rule.md`.** Not your own taste. When the
   rule cannot tell, it says to answer yes; unjudged is a state, not a no.
2. **Draft only from the material `draft` gives you.** It carries the
   operator's measured voice rules and `me.md` — what they can honestly claim.
   A first-person claim not grounded in `me.md` is the thing that ends
   accounts; never write one.
3. **Respect refusals.** `mark sent` can be refused by the burst governor
   (two per room, five overall, per 24h) or by standing in the room. Relay
   the refusal to the operator verbatim. `--anyway` only when they state the
   reply is already posted.
4. **Do not run the reading verbs** (`sync`, `check`, `probe`, `tick`) from a
   chat unless asked — each read costs a minute by design; the operator's
   dashboard or cron owns that loop.
5. Long-running setup, prospects, memory editing: point the operator at the
   dashboard, `http://127.0.0.1:8787`.

A good session: `queue` → pick the oldest → `draft <id>` → write the reply
from the material → `--save` → read the refusal flags back → the operator
posts it themselves → `mark <id> sent`.
