# Everything optional is a skill

A skill is a folder. Its `SKILL.md` teaches — a person, the strategist, an
MCP client, an OpenClaw agent all read the same file — and the files beside
it, if any, plug into the engine through named doors:

```
skills/<id>/
  SKILL.md       required. What this is, its norms, its measured facts.
  adapter.mjs    optional seat: a PLATFORM — how to read somewhere
                 (door: lib/platform.mjs)
  page.mjs       optional seat: a DASHBOARD SCREEN
                 (door: bin/serve.mjs)
  agent.mjs      optional seat: a SUBAGENT for the strategist, inside a turn
                 (door: agent/strategist.mjs — the one place that owns
                 the LangChain runtime; your module stays bare Node)
  agent.md       optional seat: a COLLEAGUE — a background worker on its
                 own thread, in a tab of the operator's own browser
                 (door: agent/tasks.mjs). Markdown: frontmatter and a prompt.
```

A folder with only a `SKILL.md` is **knowledge** — always active, never in
anybody's way. Copy `skills/_template/` to start one of any shape.

## The manifest

Frontmatter is `key: value` scalars between `---` fences — no YAML library,
no nesting, nothing to misread:

```markdown
---
name: reddit
description: One honest sentence. Every agent reads this to decide relevance.
provides: platform:reddit
---
```

`name` and `description` are required. `provides` is optional and names the
**slot** this skill fills.

## Two rings

Built-in skills ship in `skills/`. Yours load from `<data-dir>/skills/`
(`.mq/skills/` by default) without touching the repo. On an id collision,
yours replaces the built-in entirely — that is the override mechanism, and
there is no other.

## Slots: same purpose, different implementation

Two skills may serve one purpose — two Reddit readers, two queue boards. They
declare the same `provides:` slot, and the instance decides which one runs:

- **one candidate** — active, no ceremony.
- **a sole local candidate** — active: dropping the folder into your own ring
  was the choice.
- **anything else** — *nobody* runs, and the stalemate is surfaced on the
  dashboard's **Skills** screen and by `mq skills`, each with the fix beside
  it. Settle it there, or with
  `mq skills use <slot> <id>` — either way it is recorded in
  `<data-dir>/skills.json`, and the change takes effect immediately: adapters
  re-import, pages re-mount, the strategist rebuilds.

A guess here would be somebody's dashboard quietly running code they did not
pick, so there is no guess.

Slot names are plain strings. The conventions in use: `platform:<id>`,
`page:<name>`, `agent:<name>`. A new convention becomes real the way
everything here does — by a working skill using it.

## The adapter seat (a platform)

`adapter.mjs` default-exports one object. Required:

| member | what it is |
| --- | --- |
| `id` | short stable identifier, `"reddit"` |
| `name` | what to call it in front of a person, `"Reddit"` |
| `gapMs` | what the engine shows as the platform's pace between page turns. The control lane holds the real gap (6 s plus up to 80 % more, per host), so this is a number a person reads, not a governor |
| `read(url, { browse })` | one PAGE, in the operator's own browser — the only reading mechanism there is (0.6.0). `browse` is the engine's browser on a leased tab (`lib/browse.mjs`): `open`, `goto`, `extract(spec)`, `text`, `where`, `scroll`, `close`. Returns `{ok:false, error}` or `{ok:true, entries, redirected, finalUrl, truncated, subtitle}` — three outcomes, never two. A page that could not be read is not a page that said nothing, and collapsing those is the one bug this codebase keeps a diary about. No `fetch` anywhere in a skill: a test fails the build on one |
| `sourceUrl({place, q})` | the page a person opens for a watched source — a room's new posts, or a phrase scoped to that room |
| `refuse(src)` | reason-string or null: the shapes of reading this platform refuses, with the measurement that says why. An adapter with an empty refusal list is claiming every shape on its platform is worth a read — say that out loud in SKILL.md if you mean it |
| `roomOf(url)` | which community a URL belongs to, or null |
| `roomLabel(place)` | `"r/smallbusiness"`, `"~lobsters"`, whatever the platform's people actually write |

Entries returned by `read` are `{id, kind: "post"|"comment", url, author,
title, body, at}` with a **platform-prefixed, stable** `id` — first-write-wins
storage means an id collision is silent data loss.

**How a page is read.** The extension runs `read_dom` — a declared spec,
`{items: <selector>, limit, fields: {name: how}}`, where `how` is
`attr:<name>`, `attr:<name>@<selector>`, `text:<selector>`,
`href:<selector>`, `text`, `href`, `tag`, and `a|b` takes the first that
answers — through every shadow root, reading only. The skill declares the
shapes it measured, with dates (`reddit/pages.mjs`); the extension executes
them; no platform code ever runs in a page. Rows come back to the skill,
which turns them into entries. A shape the platform changes is a read that
comes back empty — say so as an error, never as "nothing new".

Optional, and simply absent elsewhere:

- `rulesUrl(place)`, `parody(place)` — where a human reads the room's rules,
  and communities that are jokes about the communities they name.
- `idOf(url)`, `itemOf(url)` — a post's stable id off its permalink, and
  what a permalink names (`{id, kind}`), so a colleague cannot invent an id
  and `mq add` checks the right thing.
- `readPost(url, { browse })` and `bodiesPerRead` — a page that previews
  posts without their bodies (Reddit's search does) is followed by a read of
  each new post's own page, up to that many per read.
- `labels` — what the deck and the dashboard say when they mean this
  platform: `account {question, help, placeholder}`, `room {question, help,
  placeholder}`, `phrase {placeholder}`, `rules`, `submit` ("Reddit's own
  Comment button"), `appeals`. The heart's cards carry no platform word of
  their own; a platform that declares none still reads as plain English.
- `account` — how the browser can answer for the person, so nobody types a
  name the machine could have found:
  - `cookies {url, names}` — the cookies this site sets when you are signed
    in. Checked for **presence only**: the panel asks Chrome whether one is
    there, never what is in it, and nothing is fetched or opened. That is the
    honest limit of a cookie — a session does not carry a handle — so this
    answers "signed in here" and no more. Needs the `cookies` permission,
    which is optional in the manifest and asked for on a press.
  - `whoami {url, of(finalUrl)}` — an address that **redirects** to your own
    profile while you are signed in. The engine opens it on the lane like any
    other page, at a person's pace, in a tab you can watch, and reads the
    handle out of where it landed with `of()`. The page itself is never
    parsed. Return `null` from `of()` for anything that is not a profile —
    a login page is what a signed-out browser gets, and guessing there would
    record a stranger as you.
- `composer` — `{opens, replies, hosts, comments}`: the labels that open a
  composer, the labels on a reply box, the custom elements that host one,
  and the custom element that holds one comment (so a comment on the post
  goes into the thread's own box and a reply under the person's comment).
  Rides on the reply card to the extension's Insert flow; the words that may
  never be pressed are the extension's own list, not a platform's.
- the **own-visibility set**: `userPage(name)`, `threadPage(url)`,
  `commentPage(url)`, `threadOf(item)` — the pages `sync`/`check`/`back`
  open to read *your* words the way a stranger sees them, in an **Incognito**
  tab (the lease asks for the stranger's seat; the extension needs "Allow in
  Incognito" once). A platform without these cannot run those verbs, and the
  engine says so rather than guessing.

## The page seat (a dashboard screen)

`page.mjs` default-exports:

```js
export default {
  path: "/board",          // one lowercase segment; core paths are refused
  title: "Board",          // the nav label and the <title>
  nav: true,               // default true; false keeps it off the nav
  render: (ctx) => "...",  // the page body as HTML; ctx = { dir }
};
```

The body renders inside the dashboard chrome — header, nav, job strip, the
`default-src 'none'` CSP. Your render runs on the server and may import
anything in `lib/` to read the store; a render that throws shows its failure
on the page instead of taking the dashboard down. There is no client-side
framework to learn because there is no client-side framework.

## The agent seat (a colleague for the strategist)

`agent.mjs` default-exports, in bare Node — skills carry no dependencies:

```js
export default {
  name: "seo-auditor",
  description: "When to hand this colleague a task. The strategist reads this.",
  prompt: "You are ... (the subagent's system prompt)",
  tools: [{                       // optional
    name: "check_page",
    description: "…",
    schema: { type: "object", properties: { url: { type: "string" } } },
    run: async ({ url }, { dir }) => "a string the model reads",
  }],
};
```

The strategist (installed with `npm run brain`) seats it as a Deep Agents
subagent and can delegate to it mid-conversation. Everything it does inherits
the house law: it drafts, it proposes, it never submits — there is no code in
this repo that posts, so there is nothing for a tool to reach.

## The colleague seat (a background worker, in markdown)

`agent.md` is the agent seat for work that runs in the BACKGROUND — on its
own thread, in a tab the runtime leased in the operator's own Chrome, started
by the operator's click on a card the CMO proposed:

```markdown
---
name: reddit-scout
description: When the CMO should propose this colleague, in one sentence it reads.
tools: browser.read, ask_person, record_findings, judge_pending, write_draft
model: scout
---

The prompt. Plain sentences: what to read, when to stop and ask, what never.
```

- `tools` names what the runtime seats and screens: the browser families
  `browser.read` / `browser.click` / `browser.type` (Claude-in-Chrome's
  toolkit — `navigate`, `read_page`, `read_dom`, `find`, `get_page_text`,
  `computer`, `batch` … — on the leased tab, checked against this line
  before the extension hears of it), `ask_person` (the question list: one or
  many questions, dealt as cards on the deck — each with a field for the
  operator's own words — answered together, the thread paused meanwhile),
  and the engine's verbs by name (`queue`, `pending`, `judge`,
  `draft_material`, `save_draft`, `rooms`, `campaigns`, `waiting`, `read_memory`, and
  for scouts `record_findings`, `judge_pending`, `write_draft`). A task
  started under a campaign carries its id in the brief, and
  `record_findings` passes it on, so the judge and the writer apply the
  campaign's direction. **No colleague is granted click or type in milestone
  1**, and the extension refuses a click on any control labelled post,
  comment, reply, send or submit even if one were.
- `model` is a SEAT — `scout`, `judge` or `writer` — never a model id. The
  seats in `lib/models.mjs` decide what runs it; there is no second way.
- The body is the prompt. The folder's `SKILL.md` is inlined into it too, so
  the colleague learns the platform's facts and refusals from the same bytes
  everyone else does.

Both rings, same slot rules as every seat. `agent.mjs` stays for a colleague
that needs tools written in code. `skills/_template/agent.md` is a colleague
that reads one page and asks before a second, so the pause can be tried on
purpose; `skills/reddit/agent.md` is the scout. The dashboard's **Tasks**
page lists every colleague the registry resolved and lets you start one by
hand.

## What a SKILL.md is for

The prose half is not decoration. The judge and the writer are told the norms
of the place they are judging and writing for; the strategist reads every
ACTIVE skill's file natively; an agent driving the CLI learns what the
platform tolerates from the same bytes. Put in it: what this is, what its
communities punish, the measured facts behind your `gapMs` and refusals, and
what "being a good participant" means there. Dated measurements, like
everything else in this repo — a number without a date is a guess wearing a
suit.

## The rules that keep this honest

`lib/` never executes skill code except through a named door — the adapter
door (`lib/platform.mjs`), the page door (`bin/serve.mjs`), the agent door
(`agent/strategist.mjs`). A skill may import from `lib/`. If your skill needs
a core change, that is a contract gap: open it as one, don't reach around the
seam.

**A skill reads a platform in the operator's browser, or not at all.** There
is no fetch in a skill and none in the engine: a page is a real tab a person
can watch, leased through the control lane, read in the isolated world,
closed after. The visibility verbs read from the stranger's seat (Incognito);
the finding verbs from the operator's own session. A skill that needs a
background request has a contract gap to argue, not a lane to add.

**A skill ships its refusals or it ships nothing.** The refusals are not a
compliance garnish, they are the product's position: an SEO skill refuses
doorway-page plays, a GEO skill refuses fabricated citations, every outreach
skill inherits the governor, and a platform folder with no stated refusals
and no measured pace is a spam cannon with a manifest. Half this tool's
market now *advertises* "never auto-posts"; the difference this repo defends
is refusals that are enforced in code and quotable back to the sentence that
caused them.

This contract grows by **extraction** — when a real skill proves something
generic, it gets pulled up here, and nothing gets added because it might
someday be needed. Reddit is deliberately the only built-in platform until it
is mastered; a tool that half-reads five platforms is worse than one that
reads one properly.
