# Messaging Quest — the reference

The long form. The short one is the [README](../README.md): the idea in three paragraphs, the picture, the install. Everything below is how each part works and why it works that way, with the measurements that decided it. It is kept whole on purpose — most of what is written about reading Reddit is out of date in a specific and expensive way, and the dates here say when each number was true.

## What it is

A dashboard on your own machine and a CLI underneath it. No account, no hosted
anything, no bill. It reads your own public profile the way a logged-out
stranger reads it, re-reads each thread you took part in, and tells you which of
the things you said a stranger can actually see. Then it goes and finds the
people asking for what you sell.

It stores everything in `.mq/` in the directory you run it from, as
append-only JSONL you can read with `cat`, and five markdown files you can open
in any editor.

**The engine has zero dependencies. All of it.** `npm install` installs
nothing — every verb, every screen, the card deck, the extension and all
three model seats run on a bare Node 18. The model layer is
[lib/llm.mjs](../lib/llm.mjs): fetch, a JSON-schema check, and a tool loop,
~250 lines you can read in one sitting. A tool that holds your prospect list
and your API key should not come with a supply chain, so this one doesn't.
The models themselves stay optional — each screen that wants one says so and
offers the manual path instead. (The one exception is opt-in and fenced off:
the conversational strategist lives in `agent/` on Deep Agents, installs with
`npm run brain`, and everything else runs without it. See
[PLAN.md](../PLAN.md) for the boundary and why.)

## Install

Node 18 or newer.

```bash
git clone https://github.com/theic/messaging-quest && cd messaging-quest && node bin/mq.mjs init
```

Then open the dashboard and set it up there:

```bash
node bin/mq.mjs serve
```

That is `http://127.0.0.1:8787`, and everything this tool does is reachable from
it — onboarding, the queue, your prospects, the memory files, the models.
(`npm start` does the same thing; the direct form is spelled out because
Windows PowerShell blocks npm's `.ps1` shim under its default execution
policy, and there is no reason to make anybody debug that for a tool with
nothing to install.)

For the scout, judge and writer, pick where the models run on the panel's
**Settings** tab or the dashboard's Settings. Three plans, one file, **Free is
the default** (0.8.0), and everything that reads Reddit needs none of them:

| Plan | What it needs | What it costs |
|---|---|---|
| **Free** (default) | a free OpenRouter key — [openrouter.ai/keys](https://openrouter.ai/keys), no card | nothing — OpenRouter's free variants, at 20 requests a minute and 50 a day (1,000 a day once $10 of credit was ever bought, which is not required), read off its docs 2026-09-01 |
| **Paid** | the same key with credit on it | cents per hundred verdicts; the writer is the seat that costs |
| **Local** | Ollama, or any OpenAI-compatible server, on this machine | nothing, and nothing leaves the machine; minutes per batch on a CPU |

`mq models use free` does the same from the terminal, and each plan keeps its
own picks, so a week on the free one does not lose the paid writer you chose.
There are no libraries to install on any of them.

### The specialist in your browser

The primary way to *live* with Messaging Quest is the Chrome extension — one card at
a time in a side panel: who to answer, the drafted reply, and the reason when
the answer is "not yet".

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick this
   repo's folder itself (the manifest is at its root, so the package the
   store gets is `git archive`) — or install it from the Chrome Web Store.
2. Pin the icon and click it. From 0.10.0 the engine runs INSIDE the
   extension (hosted mode, the default): no server, the files in this
   browser and, once you sign in on the Settings tab, in your account. For
   this dashboard and the CMO, keep `node bin/mq.mjs serve` running and
   press **Use that server** on the Settings tab (local mode); the extension
   reloads itself.

The panel deals the next action: setup runs as cards (your account, your URL
— the scout reads your site while you answer nine one-tap questions about how
you write — then a proof-read of what it found, then the first room). After
that it deals work: a person worth answering with the reply already written,
**Open the thread & type it in** puts the draft into Reddit's real composer —
the thread's own comment box for a comment on their post, the reply box under
their comment when they wrote back, never the first comment's Reply — and
*you* press Reddit's own Comment button. It reads back that the words landed
before it says so, and pastes them with a real Ctrl+V from your clipboard when
the editor ignored the first try. Nothing here can submit: the code that finds
the composer is screened against every label that could, and "I posted it" is
recorded through the same limits the CLI enforces (2 replies per room, 5
overall, per 24 hours — with the refusing sentence shown on the card).

Everything that runs is named in the strip at the top of the panel, on every
tab — the judge, the writer, a read, a colleague in its tab, your own question
in flight — with a clock; when nothing runs, the strip says what last finished
and how it went. The judge starts by itself whenever something is pending and
a model is there (0.9.1); the card waits while it runs and says why when it
failed. A draft being written is a wait, not the same button; a failed attempt
puts its reason on the card and offers once more.

No Chrome? The same deck is served at `http://127.0.0.1:8787/panel/` —
everything works there except typing into the composer (you get the draft on
your clipboard instead).

### The account (hosted mode)

Hosted, the files live in the browser — a memory filesystem the extension
keeps in IndexedDB between sessions — and, once you sign in on the Settings
tab, in your account: one table (`mq_files`, a row per file) under
row-level security on messaging.quest's Supabase, reached directly with your
own token, no API of ours in between. Two ways in: a 6-digit code mailed to
you and typed into the panel (the site's own sign-in; never a link to
click), or **Connect this browser** on
[messaging.quest/link](https://messaging.quest/link) while signed in there
— the site hands the extension a one-time token and it gets a session of
its own. The rules are plain: every change goes up a moment after it is
made, the account is pulled at start and once a minute for what another
browser wrote, and per file the last writer wins — the account wins over a
browser joining it. What never goes up: the OpenRouter key (it stays in the
browser it was typed into, so a database is never a file of keys), the job
log, the task screenshots, the hub's tokens. Sign out and the account keeps
its files; this browser keeps its own.

### Colleagues: the specialist at work in your browser

From 0.5.0 the specialist is a CMO: it does not only talk, it puts
**colleagues** to work — each a background task on its own thread, in a tab
it leased in your own Chrome window under a "Messaging Quest" tab group. It
proposes one as a card ("Search r/saas for people asking this?"); your click
starts it; you go and do something else. Later the panel says what it found,
or asks you something when it hits a wall — a login, a captcha, a choice —
with a screenshot of its tab on the card and a button to show you the tab.
Closing a task closes its tab. The **Tasks** page has the log, the colleagues
installed, and a Stop button.

A colleague is a markdown file, `skills/<id>/agent.md`, beside the SKILL.md
that teaches it ([skills/README.md](../skills/README.md)). The first is the
Reddit scout: it reads a subreddit search in your signed-in session, records
the posts, has the judge seat judge them and the writer seat draft the
replies — and never clicks. **No colleague may click or type**: every browser
call is checked against the colleague's `tools:` line before the extension
hears of it, and the extension refuses a click on any control labelled post,
comment, reply, send or submit even if one were granted. The colleague
runtime lives in `agent/` with the strategist (`npm run brain`); without it
the deck, the extension and everything else run exactly as before.

Upgrading the extension: reload it on `chrome://extensions` after pulling —
it asks for three more permissions (tabs, tab groups, and the debugger, which
is what screenshots, the mouse, the wheel and the keys need; Chrome shows its
bar while a task is working a tab and drops it after a minute idle).

The browser stays a person's. A task's tab is a real tab, under the
"Messaging Quest" group in a window of its own (Chrome
only processes input for a tab it is drawing, so the extension asks the page
whether it is on screen before every step and raises that window when it is
not); nothing fetches a page in the background. Reading writes nothing into the
page. Every scroll, click and key goes through Chrome's own input pipeline,
with a mouse that travels and rests, wheel ticks of uneven size, typing one
key at a time, and an uneven pause before every step — the page sees only
trusted events, and a test fails the build on the first synthetic one. The
Insert button works the same way: a real click on the thread's own box ("Join
the conversation" on Reddit — a small textarea that a click swaps for the real
editor), a real click into the editor, the draft as one piece, a real Ctrl+V
when the editor ignored that. Reddit's own button is yours.

One Chrome profile at a time. The extension loaded in two profiles is two
workers on the lane, and a tab is visible only to the profile that opened it.
So each worker names itself (a random id kept for the browser session), the
engine binds every tab to the worker that opened it and sends that tab's jobs
— the reads, the closing — to that worker only, and a new tab opens in the
profile whose panel is open (the first, when both are). The strip says so in
both panels when it counts more than one. Measured 2026-09-07, on the 0.9.1
retest: without this, one probe's jobs went to whichever profile answered
first, and the tab one had opened was "that tab is gone" to the other.

The extension is also **the only way anything here reads Reddit** (0.6.0).
There is no feed, no background fetch, no API: a probe, a tick, a colleague's
search, the site scout — each is a real tab in the "Messaging Quest" window,
rendered, read the way the extension reads everything, closed after. What a
page looks like is written down in the reddit skill with the date it was
measured; the extension runs that spec in the page and hands rows back. The
visibility checks (`sync`, `check`, `back`) read from the stranger's seat —
an **Incognito** tab — because Reddit shows you your own shadow-removed
comment as if nothing happened. Chrome lets the extension into Incognito
only after you tick "Allow in Incognito" on chrome://extensions; until then
those verbs say so and stop, rather than answer from the wrong seat.

### Projects

You work on more than one thing. A project is a whole data directory — its
own memory files, store, voice, deck, campaigns, colleagues and threads —
and the folder you started in (`.mq/`) is the default one, so nothing
changes for a single product. Make another from the panel's project picker,
the dashboard's **Projects** page, or `mq project new "Name"`: it is created
complete under `.mq/projects/<id>/`, switched to at once, and its setup
starts on the panel like a fresh install. Your account, voice, me.md and
persona are copied in as a start. Shared across every project, on purpose:
your key and the model seats, the people you have already answered (the same
human never reaches a queue twice, in any project), and your local skills.
Switching in one place switches everywhere; a colleague started under one
project keeps working when you switch to another.

### Campaigns

The voice you answered at setup is how you sound. A **campaign** is what you
are trying — a tactic, an angle, a different tone for a different room, a
different rule about naming what you built. Tell the specialist ("under posts
asking how to find clients, say honestly that…") and it proposes one as five
cards: the idea in your words, who it fits, whether a first message may name
what you built, the room, the phrase. Every card is seeded with its text and
takes your own words instead; your last Save writes `campaigns/<id>.md` and
probes the room in your browser. From then on what is found under the
campaign is judged with its "who it fits" beside `rule.md` and drafted with
its direction — as an idea to apply to *this* person, never wording: the
writer is shown what it already said under the campaign and told not to reuse
a phrase, and the save flags any eight-word run it repeats anyway. The one
lift a campaign may ask for is *disclosed*: named once, plainly, as yours, no
link unless they ask. There is no undisclosed setting. The **Campaigns** page
edits, pauses and writes them by hand; `mq campaigns` lists them.

### The return

An opener is not the product; the second and third replies are. When you
press **I posted it**, a conversation opens with the words you actually
posted — the card's field as you edited it, not the draft. The next profile
read binds it to your own comment; the next tick reads that comment's own
page from the stranger's seat and, if somebody answered, the reply lands on
your deck as a **turn card** before any new person: what you said, what
they wrote back, a draft for this turn in a field you edit, Insert, I
posted it, Rewrite, Let it go. No judge on a reply — they are already
talking to you. **Rewrite** on any draft asks one question, what should
change, and hands your note and the rejected draft to the writer. What is
due is computed, never remembered: the deck's due card says how many reads
are waiting and runs them; **Today** on the dashboard says the same. Once a
day the engine writes the numbers per campaign into the specialist's inbox
— found, fit, sent, replied, second turns, waiting, and *crowding*, the
median number of comments a post already had when it was found — and the
specialist answers three questions with cards or silence: who is waiting
(already dealt), which campaign is saturated (a card to pause it), where is
the gap (one new campaign aimed at a different kind of person). `mq waiting`
lists who is waiting on you.

### Four pages

The dashboard asks four questions: **Today** (the next card, who is
waiting, what is due, who is worth answering, the campaigns' numbers),
**People** (everybody found, judged, waiting for you, answered, retired),
**Campaigns** (each with its numbers, voice and sources), **You** (your
account and standing, your voice, what the specialist knows, projects,
models, skills — and the by-hand screens under Advanced). The panel is where
things are answered; the dashboard is the ledger.

### Or drive it from the terminal

```bash
node bin/mq.mjs me <your-reddit-username>
node bin/mq.mjs sync      # read your profile as a stranger sees it
node bin/mq.mjs check     # re-read each thread, logged out
node bin/mq.mjs status    # what became of the things you said
node bin/mq.mjs back      # who replied to you and is still waiting
node bin/mq.mjs campaigns # this project's campaigns, a direction each
node bin/mq.mjs projects  # every project; * is the one the verbs act on
node bin/mq.mjs waiting   # who wrote back and is waiting on you
```

The verbs are one implementation (`lib/verbs.mjs`) — the CLI, the dashboard's
buttons and the extension's worker call the same functions in-process rather
than reimplementing them, so the three can never drift.

`check` opens each thread in an Incognito tab of your own browser — the
stranger's seat — a page turn every few seconds, at a person's pace, and it
groups your comments by thread so one read answers for all of them. Keep
`mq serve` running and Chrome open with the extension loaded: every verb
that reads does it there, and says so when it cannot.

## Coming back

```
! waiting   3 replies  Karma and Age gates are really blunt tools that, w

3 waiting for you — oldest first, because that is the one going cold:

  u/Extolord111 · 19d ago
    they said: Could you perhaps replicate the old comment sorting as well?
    you said:  Karma and Age gates are really blunt tools that, while we un
    https://reddit.com/r/.../p1xmnfk/
```

Almost nobody goes back to their own comments, and second and third replies are
what a community actually reads as membership — the version of warming that is
not karma farming. `back` finds the conversations where somebody answered you
and you never answered them.

It compares *times*, not just "did you reply at all": answering once in March
does not settle something said to you yesterday, so a thread you already
replied in re-opens when they speak again.

It costs one read per comment, because a reply tree only exists in a comment's
own view — the flat thread feed carries no parent for anything. So it is bounded
by recency (`--days`, default 14) rather than by a page count, and it skips
anything `check` already found a stranger cannot see. **It writes nothing.** The
answering is yours.

## Finding people

The second half is monitoring — and it is mostly a list of things it will not
read.

```bash
node bin/mq.mjs probe smallbusiness --q "how do I get clients"
node bin/mq.mjs rooms      # whose rules have been read, and whose have not
node bin/mq.mjs watch smallbusiness --q "how do I get clients"
node bin/mq.mjs tick       # read what is due
node bin/mq.mjs queue      # who is waiting for an answer from you
```

**A room you have not read the rules of cannot be watched.** Not warned about —
refused. So are parody subreddits (Reddit's own `-jerk` suffix), rooms whose
description forbids promotion, and any source that did not clear a 10% floor on
a real probe.

That last one deserves its own note, because it is where this differs most from
what else exists. A competitor's picker was observed returning
`r/languagelearningjerk` — a parody community — as an "Excellent Match" at
100/100, and beside it `r/slp` at 80/100 **while rendering that subreddit's own
rule on the card**: *"No recruiters ever. Seriously. Never."* It displayed the
rule prohibiting its use case and scored it Excellent.

### And here is the honest limit of doing it keylessly

Reddit does not serve a subreddit's rules to a logged-out reader. Measured:
`/r/<sub>/about.rss` is a 404, `about.json` is a 403 like every `.json` path,
and the one thing that *is* readable — the `<subtitle>` on a feed — is the short
community description, not the rules.

We checked that against r/slp, the exact room the refusal exists to catch. Its
description is the community blurb. **The rule about recruiters is not in it.**

So a keyless rules check would have returned "looks clear" for the one
subreddit that most needed a no. Rather than ship that, the tool checks the
description (free, and it does catch blunt cases) and otherwise records the
room as **unanswered** — writing `.mq/rooms/<sub>.md` with a line for you
to fill in after reading the sidebar once. Until that line says something, the
room cannot be watched.

"I could not read the rules, go and look" is worth more than a confident
80/100.

## Judging, and where the model is

`tick` reads feeds and stores what is new. That loop is plain code — **no model
runs in it**, and that is not going to change: it is the loop that spends the
one-request-a-minute budget, and a model in it would be a model deciding how to
spend your address's quota.

Judging is a bounded call, and you have two ways to make it:

- **In the dashboard.** Press *Judge*, and the judge model scores everything
  pending against your `rule.md`, five at a time.
- **Outside this process entirely.** `pending` prints what needs a verdict as
  numbered JSON, and `judge` takes `[{n, fit, why}]` back on stdin. Point it at
  whatever you already pay for — the MCP server below makes your Claude or
  ChatGPT that judge, and then no OpenRouter key is needed at all.

Both write through the same code path — the dashboard calls the model and then
hands the result to `mq judge`, because that is what stamps the rubric hash,
clears the pending list and settles the probe. Two implementations of that is
how a queue starts disagreeing with itself.

Every verdict is stamped with a hash of your `rule.md`, so when the queue
changes you can tell whether it was your rule or the model that moved.

### The models

Three roles, because they are not the same job. A flash model is genuinely good
enough at *"does this person have the problem, yes or no"* and runs on
everything; the writer runs once per reply and the output goes out under your
name.

| Role | Default | Per M in/out |
|---|---|---|
| **judge** | `deepseek/deepseek-v4-flash-0731` | $0.065 / $0.18 |
| **scout** | `z-ai/glm-5.3` | $1.40 / $4.40 |
| **writer** | `moonshotai/kimi-k3` | $3.00 / $15.00 |

The judge default was moved off GLM 5.3 Flash on a measurement: reasoning is
mandatory on that endpoint, and ~300 forced reasoning tokens made the
cheapest-per-token model eleven times the price per verdict and six times
slower. The measurement is in [lib/models.mjs](../lib/models.mjs), dated.

All three are changeable on **Settings**, which shows what each costs and what
judging a hundred posts would come to — about a cent on the defaults. Each role
falls back down its own list of alternates when a provider errors, using
OpenRouter's model-level `models:` array, because a `tick` that dies on one
provider's `429` has spent its minute-per-read budget and produced nothing.

**The free plan** was picked the same way, on 2026-09-01: every free model on
OpenRouter that takes a tool call was asked the judge's own two-item verdict,
and the two that answered best were then given the scout's real tool loop
and the writer's real material.

| Role | Free default | Measured |
|---|---|---|
| **judge** | `poolside/laguna-s-2.1:free` | 5.2s and 4.7s, zero reasoning tokens, conformed first ask, agreed with the paid judge |
| **scout** | `nvidia/nemotron-3-super-120b-a12b:free` | three pages and a conforming proposal in 102s + 18s |
| **writer** | `nvidia/nemotron-3-super-120b-a12b:free` | the next measured free run; a writing measurement is still owed |

MiniMax M2.7's free variant held both seats until 2026-09-07, when OpenRouter
retired it (404 "unavailable for free") — and a model-level fallback does not
cover an id that 404s, so every draft failed at once. It is out of the menu.

The whole table, including the models that were full (Gemma 4 and GLM 5.2
answered 429 on every ask) or refused, is in [lib/models.mjs](../lib/models.mjs)
with the numbers. A 429 from a free provider is that plan's weather, so the
free fallbacks are picked to be different providers — two of them, because
OpenRouter takes three entries in a fallback list and refuses a fourth.

**The local plan** talks to `http://127.0.0.1:11434/v1` — Ollama's
OpenAI-compatible endpoint — with no key, and to any other address you give
it (`mq models url <base-url>`; LM Studio, llama.cpp and vLLM speak the same
protocol on other ports). The default tag for every seat is `qwen3.5:9b`,
which fits a 16 GB machine and makes tool calls through Ollama, and it is
**not measured**: this project has had no local box to measure on, and the
Settings page says so rather than dressing a guess as a number. Two things
that are known: start Ollama with a window the scout can read a page into
(`OLLAMA_CONTEXT_LENGTH=32768 ollama serve` — the default silently drops the
start of a long page), and if your server accepts `tool_choice` and ignores
it, the JSON inside the prose answer is taken, checked by the same validator.

`mark <id> sent` retires that person from every future queue, permanently.
Showing you the same human twice is what makes a queue feel like a lottery.

## Writing the reply

```bash
node bin/mq.mjs voice          # how you write, measured from your own comments
node bin/mq.mjs draft <id>     # the material for answering one person
node bin/mq.mjs draft <id> --save < reply.txt
```

`voice` needs no new reads: your own comments are already stored by `sync`, so
the fingerprint is measured off your actual words rather than picked from a
persona menu. **Presence is decisive at one sample; absence is never decisive
below five.** A thin corpus therefore produces a mostly-empty fingerprint, which
renders no style instructions at all — that is the right answer, not a gap to
fill with a default.

Exactly one rule fires with no evidence: no em dashes. It is the single most
reliable machine signature in a forum reply, and one sample of you using one
lifts the ban.

`draft` writes nothing. It assembles what is already on disk — the post, your
measured voice, the community's risks, the campaign — and asks for **three
drafts, one per style, every time** (0.8.0): *Straight* (the answer, shortest),
*Deeper* (what is behind their question), *Ask back* (one real thing and a
question you want answered). They differ by what the reply does for the
person, never by tone — the voice owns the tone. `--save` takes the three as
JSON (`{"drafts":[{"style":"straight","text":"…"},…]}`) or one reply as plain
text, which is recorded as yours; a round is one row with the three in it, and
the flags below are computed for each. `--note "…" --style deeper` is the
material for a rewrite: your note, the draft you were looking at as the
rejected one, and all three asked for again. On the panel the three are tabs;
the tab you press Insert or "I posted it" from is written on the mark and on
the conversation's first turn, so what you actually choose is on the ledger.

How it sounds is part of the rules, since 2026-09-01: one person who has done
the thing, typing to one other person — the answer in the first sentence,
their words rather than marketing words, an opinion rather than padding, and
none of the phrases nobody types to a stranger ("great question", "hope this
helps", "at the end of the day"). The measured fingerprint still outranks all
of that on casing, sentence length and punctuation: the register says what a
comment is, the fingerprint says how you type.

### The two refusals

`--save` runs them and stays loud:

- **Repeated phrasing.** The longest run of identical consecutive words between
  this draft and everything you have drafted for somebody else. Reddit names
  "the same or similar comments across communities" as reportable spam.
- **Claims about you.** Every first-person claim of experience, surfaced next to
  `me.md` for you to check. A competitor was observed posting *"at my last job i
  used [product] for some basic bridge work during intake"* into a clinical
  thread under a real name. Nobody had ever had that job.
- **Template phrases.** The phrases nobody types to one person — "hope this
  helps", "great question", "at the end of the day" — named back, plus the em
  dash unless you have been seen typing one. Phrases, never vocabulary: "that
  said" is what people write, "that being said" is what templates write.
- Plus the inherited one: any URL not lifted from the thread is invented.

Nothing is rejected outright, because you are the one sending it.

**Why runs and not a similarity score.** The predecessor's mail-merge check
reported its drafts clean — it fired on 0 of 406 pairs, because it subtracted
the template's vocabulary before comparing. Re-run over the drafts still on
disk, this one flags 25 of 120 pairs, with a real 19-word identical run in it.
A duplicate detector that never fires is worse than none, because it is also a
reassurance.

## Where you stand

```bash
node bin/mq.mjs ready
```

```
  thin       r/Entrepreneur
             1 visible comment here. You are a member, which is what Crowd
             Control tests, but membership is made of second and third replies
             last comment 27 days ago
  not ready  r/SaaS
             all 1 of your comments here are invisible to strangers. More of
             them will not help
  not ready  r/freelance
             no comments here at all. Crowd Control's maximum tier filters
             exactly this, by definition
  ready      r/smallbusiness
             7 visible comments over 21 days
```

The r/SaaS line is the one no other tool can produce, because it needs the
first half of this one: a comment you cannot be seen making is not standing,
and counting comments alone reports it as ready.

`mark <id> sent` is refused when the burst limits or your standing say no — two
replies per room and five overall in 24 hours, from the shape that actually
caused the damage here: **eleven replies in 83.9 minutes across seven
subreddits with no history in any of them.** The refusal always offers
`--anyway`, because you are the one posting and a tool that cannot be overruled
just gets worked around.

### What it counts, and what it refuses to

The warm-up is a countdown over **signals**, not days. A competitor ships this
as a fixed seven-day timer with a badge reading "Browse only, 6 days left". The
pattern is worth taking wholesale; the timer is not — waiting a week in a room
you have never spoken in leaves you exactly as filterable as you were on day
one.

And the self-promotion ratio is shown as a mirror, never as a rule. The 1:5
figure is folklore. Reddit's own words: promotional content *"is not inherently
considered to be spam"*, some communities abide by a 10% rule, and — verbatim —
*"It is ultimately up to you and your team to decide what works best for your
community."* There is no sitewide ratio. You can hit a perfect 1:5 and still be
filtered, so selling it as safety is a checkable false claim.

Contributor Quality Score is named and not scored. It is account age, email
verification and network signals, none of it readable from a keyless surface. A
number invented for it would be decoration.

## The dashboard

```bash
node bin/mq.mjs serve      # then open http://127.0.0.1:8787
```

Everything is here. Not a window onto the CLI — the whole product.

| | |
|---|---|
| **Setup** | Paste your URL, the scout reads it, you confirm what it found one card at a time. |
| **Queue** | One person, one card, the draft already there. |
| **Prospects** | Everybody found, judged, answered, skipped or retired. Searchable, paginated, undoable. |
| **Standing** | What became of the things you said. |
| **Waiting** · **Ready** · **Voice** | Who is owed an answer, where you stand, how you write. |
| **Sources** · **Rooms** | What is watched, and whose rules have been read. |
| **Tasks** | Colleagues at work in your browser: each one's log, its tab, a Stop button, and the ones installed. |
| **Memory** | The five markdown files, edited in the browser — and the sixth, AGENTS.md, the specialist's own notebook, the one file the model writes. |
| **Skills** | Everything installed: what runs, what refused to load, and the choice when two skills serve one purpose. |
| **Settings** | Where the models run — paid, free or local — a model per seat, and what each costs. |

Every verb that reads Reddit is a button, and every one of them is long — a
minute per request, measured. They run as jobs with a progress strip at the top
of every page and a Stop button, because a `check` over twenty threads is a
twenty-minute job and a request handler is not where that belongs.

### Prospects, and the undo that was missing

Marking somebody answered retires them from every future queue, permanently and
across every project. That is the right default — showing you the same human
twice is what makes a queue feel like a lottery — but until now there was no
screen that could show you the list, and no way back from a misclick.

`contacted.jsonl` stays append-only. An undo appends `{author, removed: true}`
and the last word about a person wins, so the history of the mistake is still on
disk rather than edited out of it.

It is bound to `127.0.0.1`, never `0.0.0.0` — that one argument is the whole
"you, not me, are the data controller" position expressed as a bind address.
There is no account, no hosted anything, and no bill. A hosted dashboard would
forfeit exactly the position that makes the free tier defensible, after CNIL
fined KASPR €240,000 for a Chrome extension reading through a customer's own
session.

**The Queue is a deck, not a table.** One person, one card, the draft already
there when it opens, and the gate's reason at the top if the gate is saying not
yet. A queue rendered as forty rows is a lobby, and a lobby is where good
intentions go to be skimmed.

`I posted it` is the only control that writes anything, and what it writes is on
your disk: a mark, plus that person retired from every future queue, permanently.

### Two things about it that are load-bearing

**Everything on the page came off Reddit, which means a stranger wrote it.** Post
bodies are escaped at a single seam, and a test feeds the dashboard an `<img
onerror>` payload and asserts the markup never reaches the browser. If that test
ever goes red, a Reddit post can run script in your session.

**Nothing loads from anywhere.** The pages ship `Content-Security-Policy:
default-src 'none'` as the base, so a later edit that reaches for a CDN font,
an analytics snippet or a hosted script breaks loudly instead of quietly making
a local-only dashboard phone home.

Two sources are allowed and both are this process: `script-src 'self'` for the
one local file that paints the job progress strip, and `connect-src 'self'` for
the one endpoint it polls. Every other resource type is still refused by
default rather than by omission. Before the job runner there was no script at
all — which was a stronger guarantee and also meant a minute-long job could not
report progress without reloading the page under your cursor.

## Everything optional is a skill

Reddit is not wired through the tool — it is a folder. `skills/reddit/` holds
a `SKILL.md` (what the platform is, its norms, its measured facts) and an
`adapter.mjs` (how to read it, how fast it may be read, which shapes of
reading it refuses). The engine — store, pacing, judging, dashboard, hub —
asks the adapter and knows nothing else.

That folder shape is the whole extension story, and it goes past platforms.
A skill's `SKILL.md` teaches every agent the same bytes, and the files
beside it plug in through named doors: `adapter.mjs` is a platform,
`page.mjs` is a screen on the dashboard (rendered inside the house chrome,
under the same CSP), `agent.mjs` is a colleague the strategist can hand a
task to — written in bare Node, seated as a Deep Agents subagent when the
brain is installed. A folder with only a `SKILL.md` is knowledge.

Two skills may serve one purpose — declare the same `provides:` slot, and
*you* pick which one runs, on the dashboard's **Skills** screen or with
`mq skills use <slot> <id>`. Until a stalemate is settled, nobody runs and
the screen says exactly that: a guess there would be your dashboard quietly
running code you did not pick.

**Nothing on any screen names a platform either.** The words the panel and the
dashboard use when they mean the place — the account question, the room
placeholder, the example room, the rules note, the name of the button you
press — all come from the adapter's `labels`, with plain English where a skill
declares none. A room typed with its own decoration ("r/saas") is the same
room as "saas", because `labelsOf().bare()` undoes whatever `roomLabel` adds
rather than knowing about an "r/". When two platform skills are active, the
Rooms tab shows both and the one you pick is what a probe, a new campaign and
every word on screen mean (`preferred()`, stored per project). One is active
today, so that row is not drawn at all.

**And the browser answers about your account before you are asked.** A skill
can declare `account.cookies` — the names the site sets when you are signed in
— and the panel asks Chrome whether one is there. Presence only: no value is
read, nothing is fetched, no page is opened, and the `cookies` permission is
optional and asked for on a press rather than at install. It can also declare
`account.whoami`, an address that redirects to your own profile while you are
signed in; `mq me` with no argument opens it on the lane like any other page,
at a person's pace, in a tab you can watch, and takes the handle off the
address it landed on without parsing the page. Reddit declares both, so the
panel offers **Find it in my browser** instead of a blank field. A skill that
declares neither simply asks, as everything did before 0.11.0.

Your own skills load from `.mq/skills/` without touching the repo (on a name
collision, yours wins); the version for everybody is a pull request adding
one folder to `skills/`. The contract is [skills/README.md](../skills/README.md),
the checklist is [CONTRIBUTING.md](../CONTRIBUTING.md), and the starting point
is `skills/_template/`. The contract grows by extraction from skills that
exist rather than speculation about ones that might; Reddit stays the only
built-in platform until it is mastered, because a tool that half-reads five
platforms is worse than one that reads one properly.

## Plug it into what you already use

The dashboard is one surface, not the product. The same store speaks three
other ways:

- **Your Claude / ChatGPT app, via MCP.** `bin/mcp.mjs` serves seven tools
  over stdio — status, queue, pending, judge, draft material, save draft,
  mark — plus four of the five memory files as resources (persona.md stays
  out: the assistant on this pipe is also your judge). The assistant on the other
  end is a model, so it can *be* the judge and the writer: judged against
  your `rule.md`, drafting from your measured voice and `me.md`, refusals
  relayed verbatim. Used this way Messaging Quest needs no OpenRouter key at all.

  ```bash
  claude mcp add mq -- node bin/mcp.mjs
  ```

- **Your messenger, via OpenClaw.** Copy
  [integrations/openclaw/SKILL.md](../integrations/openclaw/SKILL.md) into your
  agent's skills directory and it knows the verbs, the etiquette it inherits,
  and the line it must not cross (it drafts; you send).

- **Other machines, via the hub.** `node bin/hub.mjs` serves what one machine
  found as a read-only feed on its own port — public posts only, never
  verdicts, marks or people. Everything that makes a queue *yours* happens on
  your machine.

- **A colleague, via the strategist.** `npm run brain` installs `agent/` —
  the one dependency-carrying directory, built on Deep Agents — and the
  panel's ask-box comes alive: "who's waiting and what should I do first?"
  gets an answer that reads your queue *and your panel* (every message
  arrives with the deck and the engine's counts in front of it, and a
  `deck` tool for a second look, so its advice and the card on screen
  cannot disagree and a number is never carried over from an earlier
  answer), does the pacing math, and offers the next move. Who it *is* lives in
  `persona.md` — the fifth memory file, yours to rewrite on the memory
  page; it reaches only the strategist, never the judge. Its hands are the
  same CLI verbs as everything else, its education is the same
  `skills/<id>/SKILL.md`, and it inherits every refusal. It proposes; you
  press the buttons. The questions people typically ask it sit under the
  card as buttons (0.9.0) — what to do next, who is waiting, how the
  focused campaign is going, why the person on the deck, which room next —
  drawn from the panel's state, so the campaign is named and the waiting
  counted; and when an answer needs an action, it arrives as a card and the
  answer says so.

What is deliberately not pluggable: nothing exposes `probe`/`tick`/`sync` to a
chat surface. Reading costs a minute a request and belongs to the machine that
watches, not to a conversation that times out — and no surface, anywhere, can
submit. The extension may type a draft into the composer; the click that posts
is yours, on Reddit's own button, forever.

## What the words mean

| | |
|---|---|
| `visible` | a stranger sees it, in the thread, in your words |
| `removed` | present, but the text is gone — somebody took it down |
| `deleted` | present, but the text is gone — **you** took it down |
| `filtered` | not in the thread a stranger reads, at all |
| `unlisted` | reachable at its own link, absent from the thread page we read |
| `gone` | the thread itself is unreachable |
| `inconclusive` | we did not see enough of the thread to say |
| `error` | the read failed — **this is not a finding about your comment** |

## What it will not tell you, and why

This matters more than the feature list, because a monitoring tool that
guesses is worse than no monitoring tool.

- **Whether a moderator or Reddit removed it.** The Atom feed carries
  `[removed]` and no actor. The web UI distinguishes them; the feed does not. So
  this says "somebody took it down" and stops.
- **Whether a comment is collapsed** as "Potential Spam". Not exposed in any
  keyless surface we could find.
- **That you are shadowbanned, from one absent comment.** A thread longer than
  one page does not contain most of itself either. When the read was
  incomplete, the answer is `inconclusive` and the tool goes and reads the
  comment's own view before it says anything stronger.
- **Anything, when the read failed.** A timeout is an `error`, never a removal.

If your profile returns zero entries to a logged-out reader, that is the
loudest thing this tool can find — and it is still reported as a question,
because an account with genuinely nothing on it looks identical from outside.
To tell the two apart, paste in a permalink you know you posted:

```bash
node bin/mq.mjs add https://reddit.com/r/.../comments/.../
node bin/mq.mjs check
```

That path is the one that still works when the profile itself is invisible,
which is the person who most needs an answer.

## What it does not do

It does not post, reply, vote, message, or read anybody else's account. It has
no verb that writes to Reddit. It reads public pages in a tab of your own
browser, at a person's pace, and everything it learns stays on your disk.

Stored comment bodies are dropped after 48 hours (`node bin/mq.mjs sweep`); the
ids, urls, dates, hashes and the full check history are kept, and every number
here is computed from those.

## Why the measurements are in the source

Every page shape in [skills/reddit/pages.mjs](../skills/reddit/pages.mjs) carries
the date it was measured, because most of what is written about reading
Reddit is out of date in a specific and expensive way. A post on a listing is
a `<shreddit-post>` whose attributes carry the author, the date and the
permalink, with the body slotted in beside it; a search result is a
`div[data-testid=search-post-unit]` with a title link and a time and no
author or body at all, which is why each new post's own page is opened; a
thread renders 94 of its 296 comments on the first screen and says how many
there are elsewhere; and a tab Chrome is not drawing renders the header and
nothing else. A subreddit that does not exist is answered by a silent redirect
to a search page with status 200. (The feed facts this section used to hold —
`.json` 403, `.rss` 200, one request a minute — are history: nothing here
fetches a feed any more.)

If you find one of these numbers is wrong now, that is a genuinely useful issue
to open.

## Tests

```bash
node bin/test.mjs                # the engine, the cards, the seams, the control lane
node --test bin/voice-test.mjs   # the voice fingerprint
node agent/test.mjs              # the runtime (needs npm run brain): workers on a scripted model
node bin/control-smoke.mjs       # the control lane by hand, against your own Chrome
MQ_CHROME=<chrome-for-testing> node bin/hosted-smoke.mjs   # the hosted extension end to end, in a Chrome of its own
```

They cover only the things that would break quietly — a body that gets
overwritten by a later read, a truncated thread being reported as a removal, a
failed read being reported as a finding, a thread you answered in March being
reported as settled.

One of them guards an assumption rather than a behaviour: `back` is only correct
because a comment's own feed returns its **descendants**. That was verified, not
assumed — a child's subtree is a strict subset of its parent's, and the parent
never appears inside the child's. If Reddit ever changes it, the tests still
pass while the tool quietly reports strangers as people who answered you, so the
check is written down where somebody will find it.

## Licence

ELv2 (Elastic License 2.0) — the canonical text is in [LICENSE](../LICENSE).

In one breath: use it, change it, redistribute it, for yourself or your
company, free. The one thing you may not do is sell it to others as a managed
service. That line is chosen deliberately: it keeps the local tool honestly
free forever while leaving room for a first-party hosted version to fund the
work — the same trade Elastic, and half the infrastructure you already run,
settled on.
