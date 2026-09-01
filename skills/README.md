# Platforms are skills

A platform is a folder:

```
skills/<id>/
  SKILL.md       what this platform is, its norms, its measured facts —
                 readable by a person, and by an agent driving the CLI
  adapter.mjs    the mechanics the engine calls
```

Two places are searched. Built-in skills ship in `skills/`; yours go in
`.mq/skills/` and load without touching the repo. On an id collision,
yours wins — that is the override mechanism, there is no other.

The engine — the store, the pacing loop, the probe economics, the judge, the
dashboard, the hub — knows nothing about any platform. It asks the adapter.

## The contract (v0)

`adapter.mjs` default-exports one object. Required:

| member | what it is |
| --- | --- |
| `id` | short stable identifier, `"reddit"` |
| `name` | what to call it in front of a person, `"Reddit"` |
| `gapMs` | how long the engine must hold between reads. **The platform's measured number, not a politeness guess** — see the header of `reddit/feed.mjs` for what measuring one looks like |
| `read(url)` | one fetch. Returns `{ok:false, error}` or `{ok:true, entries, redirected, truncated, ...}` — three outcomes, never two. A feed that could not be read is not a feed that said nothing, and collapsing those is the one bug this codebase keeps a diary about |
| `sourceUrl({place, q})` | the URL for a watched source — a room's new posts, or a phrase scoped to that room |
| `refuse(src)` | reason-string or null: the shapes of reading this platform refuses, with the measurement that says why. An adapter with an empty refusal list is claiming every shape on its platform is worth a read — say that out loud in SKILL.md if you mean it |
| `roomOf(url)` | which community a URL belongs to, or null |
| `roomLabel(place)` | `"r/smallbusiness"`, `"~lobsters"`, whatever the platform's people actually write |

Entries returned by `read` are `{id, kind: "post"|"comment", url, author,
title, body, at}` with a **platform-prefixed, stable** `id` — first-write-wins
storage means an id collision is silent data loss.

Optional, and simply absent elsewhere:

- `rulesUrl(place)`, `parody(place)` — where a human reads the room's rules,
  and communities that are jokes about the communities they name.
- the **own-visibility set**: `userFeed(name)`, `threadFeed(url)`,
  `commentFeed(url)`, `threadOf(item)` — what `sync`/`check`/`back` need to
  read *your* words the way a stranger sees them. A platform without these
  cannot run those verbs, and the engine says so rather than guessing.
- `readViaRelay(base, url)` — the same read through the operator's own
  browser (`lib/relay.mjs` is the broker; the extension is the reader). The
  engine offers it to **finding** reads only, when the anonymous lane is
  refused; the visibility verbs never take it, because logged-out *is* the
  measurement. A relayed body must go through the same outcome logic as an
  anonymous one — the day the two seats judge a body differently is the day
  one of them starts lying.

## What a SKILL.md is for

The prose half is not decoration. The judge and the writer are told the norms
of the place they are judging and writing for; an agent driving the CLI reads
the same file to learn what the platform tolerates. Put in it: what the
platform is, what its communities punish, the measured facts behind your
`gapMs` and refusals, and what "being a good participant" means there. Dated
measurements, like everything else in this repo — a number without a date is a
guess wearing a suit.

## The rules that keep this honest

`lib/` never imports from `skills/` — `lib/platform.mjs` is the one door. A
skill may import from `lib/`. If your platform needs a core change, that is a
contract gap: open it as one, don't reach around the seam.

**A skill ships its refusals or it ships nothing.** The refusals are not a
compliance garnish, they are the product's position: an SEO skill refuses
doorway-page plays, a GEO skill refuses fabricated citations, every outreach
skill inherits the governor, and a platform folder with no stated refusals
and no measured pace is a spam cannon with a manifest. Half this tool's
market now *advertises* "never auto-posts"; the difference this repo defends
is refusals that are enforced in code and quotable back to the sentence that
caused them.

This contract is v0 and grows by **extraction** — when the second real
platform lands, whatever it proves generic gets pulled up here, and nothing
gets added because it might someday be needed. Reddit is deliberately the only
one until it is mastered; a tool that half-reads five platforms is worse than
one that reads one properly.
