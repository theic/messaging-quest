# earshot

**Find out what Reddit actually did to the comments you wrote — and who is
still waiting on an answer from you.**

Reddit removed 154 million posts and comments in one half-year and told almost
nobody. Its own description of the work: *"our most effective work happens
before a post is ever seen by a human."* Comments are auto-collapsed as
"Potential Spam" by a filter that is on by default everywhere. Crowd Control
holds content invisibly. The Reputation Filter drops you on signals you cannot
see.

You are not told about any of it. r/ShadowBan is busy because the only known
method is opening a private window by hand, one comment at a time.

This does that continuously, and remembers.

```
r/smallbusiness  2 of yours
     visible      honestly the pricing thing killed us for about six mo
   ! filtered     we tried three of those and none of them stuck becaus

r/SaaS  1 of yours
   ? unlisted     renders at its own link; the thread was too long to c
```

## What it is

A dashboard on your own machine and a CLI underneath it. No account, no hosted
anything, no bill. It reads your own public profile the way a logged-out
stranger reads it, re-reads each thread you took part in, and tells you which of
the things you said a stranger can actually see. Then it goes and finds the
people asking for what you sell.

It stores everything in `.earshot/` in the directory you run it from, as
append-only JSONL you can read with `cat`, and four markdown files you can open
in any editor.

**The engine has zero dependencies. All of it.** `npm install` installs
nothing — every verb, every screen, the card deck, the extension and all
three model seats run on a bare Node 18. The model layer is
[lib/llm.mjs](lib/llm.mjs): fetch, a JSON-schema check, and a tool loop,
~250 lines you can read in one sitting. A tool that holds your prospect list
and your API key should not come with a supply chain, so this one doesn't.
The models themselves stay optional — each screen that wants one says so and
offers the manual path instead. (The one exception is opt-in and fenced off:
the conversational strategist lives in `agent/` on Deep Agents, installs with
`npm run brain`, and everything else runs without it. See
[PLAN.md](PLAN.md) for the boundary and why.)

## Install

Node 18 or newer.

```bash
git clone https://github.com/YOUR-NAME/earshot && cd earshot && node bin/es.mjs init
```

Then open the dashboard and set it up there:

```bash
node bin/es.mjs serve
```

That is `http://127.0.0.1:8787`, and everything this tool does is reachable from
it — onboarding, the queue, your prospects, the memory files, the models.
(`npm start` does the same thing; the direct form is spelled out because
Windows PowerShell blocks npm's `.ps1` shim under its default execution
policy, and there is no reason to make anybody debug that for a tool with
nothing to install.)

For the scout, judge and writer, add an OpenRouter key on **Settings**. That
is the whole step — there are no libraries to install.

### The specialist in your browser

The primary way to *live* with earshot is the Chrome extension — one card at
a time in a side panel: who to answer, the drafted reply, and the reason when
the answer is "not yet".

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick this
   repo's `extension/` folder.
2. Keep `node bin/es.mjs serve` running; pin the icon and click it.

The panel deals the next action: setup runs as cards (your account, your URL
— the scout reads your site while you answer nine one-tap questions about how
you write — then a proof-read of what it found, then the first room). After
that it deals work: a person worth answering with the reply already written,
**Open the thread & type it in** puts the draft into Reddit's real composer —
and *you* press Reddit's own Comment button. Nothing here can submit: the
code that finds the composer is screened against every label that could, and
"I posted it" is recorded through the same limits the CLI enforces (2 replies
per room, 5 overall, per 24 hours — with the refusing sentence shown on the
card).

No Chrome? The same deck is served at `http://127.0.0.1:8787/panel/` —
everything works there except typing into the composer (you get the draft on
your clipboard instead).

The extension is also the **second reading lane**. Anonymous Reddit sits at a
measured ceiling — one request a minute, and RSS itself is under review — so
when a *finding* read (a probe, a tick) is refused anonymously, the engine
hands that one URL to your browser, which reads it in your own session and
hands the body back. GET only, by construction; your own visible per-site
permission; same pace as everything else. The visibility checks never take
this lane: what a logged-out stranger sees can only be measured logged out,
and the tool would rather fail honestly than answer that question from the
wrong seat.

### Or drive it from the terminal

```bash
node bin/es.mjs me <your-reddit-username>
node bin/es.mjs sync      # read your profile as a stranger sees it
node bin/es.mjs check     # re-read each thread, logged out
node bin/es.mjs status    # what became of the things you said
node bin/es.mjs back      # who replied to you and is still waiting
```

The CLI is still the one implementation of every verb — the dashboard's buttons
spawn it rather than reimplementing it, so the two can never drift.

`check` takes about a minute per thread. That is not politeness — logged out,
Reddit answers one request a minute per address, measured. The tool waits rather
than getting your address rate-limited, and it groups your comments by thread so
one read answers for all of them.

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
node bin/es.mjs probe smallbusiness --q "how do I get clients"
node bin/es.mjs rooms      # whose rules have been read, and whose have not
node bin/es.mjs watch smallbusiness --q "how do I get clients"
node bin/es.mjs tick       # read what is due
node bin/es.mjs queue      # who is waiting for an answer from you
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
room as **unanswered** — writing `.earshot/rooms/<sub>.md` with a line for you
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
hands the result to `es judge`, because that is what stamps the rubric hash,
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
slower. The measurement is in [lib/models.mjs](lib/models.mjs), dated.

All three are changeable on **Settings**, which shows what each costs and what
judging a hundred posts would come to — about a cent on the defaults. Each role
falls back down its own list of alternates when a provider errors, using
OpenRouter's model-level `models:` array, because a `tick` that dies on one
provider's `429` has spent its minute-per-read budget and produced nothing.

`mark <id> sent` retires that person from every future queue, permanently.
Showing you the same human twice is what makes a queue feel like a lottery.

## Writing the reply

```bash
node bin/es.mjs voice          # how you write, measured from your own comments
node bin/es.mjs draft <id>     # the material for answering one person
node bin/es.mjs draft <id> --save < reply.txt
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
measured voice, the community's risks — and asks for three options that differ
by **move**: answering the literal question, versus answering what is behind it,
versus pointing at whoever already solved it. Never three tones of one sentence.
If there is only one honest thing to say, one option is a correct answer.

### The two refusals

`--save` runs them and stays loud:

- **Repeated phrasing.** The longest run of identical consecutive words between
  this draft and everything you have drafted for somebody else. Reddit names
  "the same or similar comments across communities" as reportable spam.
- **Claims about you.** Every first-person claim of experience, surfaced next to
  `me.md` for you to check. A competitor was observed posting *"at my last job i
  used [product] for some basic bridge work during intake"* into a clinical
  thread under a real name. Nobody had ever had that job.
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
node bin/es.mjs ready
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
node bin/es.mjs serve      # then open http://127.0.0.1:8787
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
| **Memory** | The four markdown files, edited in the browser. |
| **Settings** | Your OpenRouter key, a model per role, and what each costs. |

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

## Platforms are skills

Reddit is not wired through the tool — it is a folder. `skills/reddit/` holds
a `SKILL.md` (what the platform is, its norms, its measured facts) and an
`adapter.mjs` (how to read it, how fast it may be read, which shapes of
reading it refuses). The engine — store, pacing, judging, dashboard, hub —
asks the adapter and knows nothing else.

Connecting another platform is writing that same folder and dropping it into
`.earshot/skills/` — it loads without touching the repo, and on a name
collision yours wins. `node bin/es.mjs platforms` shows what is loaded. The
contract is [skills/README.md](skills/README.md), it is deliberately small,
and it grows by extraction from platforms that exist rather than speculation
about ones that might. Reddit stays the only built-in until it is mastered;
a tool that half-reads five platforms is worse than one that reads one
properly.

## Plug it into what you already use

The dashboard is one surface, not the product. The same store speaks three
other ways:

- **Your Claude / ChatGPT app, via MCP.** `bin/mcp.mjs` serves seven tools
  over stdio — status, queue, pending, judge, draft material, save draft,
  mark — plus the four memory files as resources. The assistant on the other
  end is a model, so it can *be* the judge and the writer: judged against
  your `rule.md`, drafting from your measured voice and `me.md`, refusals
  relayed verbatim. Used this way earshot needs no OpenRouter key at all.

  ```bash
  claude mcp add earshot -- node bin/mcp.mjs
  ```

- **Your messenger, via OpenClaw.** Copy
  [integrations/openclaw/SKILL.md](integrations/openclaw/SKILL.md) into your
  agent's skills directory and it knows the verbs, the etiquette it inherits,
  and the line it must not cross (it drafts; you send).

- **Other machines, via the hub.** `node bin/hub.mjs` serves what one machine
  found as a read-only feed on its own port — public posts only, never
  verdicts, marks or people. Everything that makes a queue *yours* happens on
  your machine. See the sharing section below.

- **A colleague, via the strategist.** `npm run brain` installs `agent/` —
  the one dependency-carrying directory, built on Deep Agents — and the
  panel's ask-box comes alive: "who's waiting and what should I do first?"
  gets an answer that reads your queue *and your panel* (it has a `deck`
  tool, so its advice and the card on screen cannot disagree), does the
  pacing math, and offers the next move. Who it *is* lives in
  `persona.md` — the fifth memory file, yours to rewrite on the memory
  page; it reaches only the strategist, never the judge. Its hands are the
  same CLI verbs as everything else, its education is the same
  `skills/<id>/SKILL.md`, and it inherits every refusal. It proposes; you
  press the buttons.

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
node bin/es.mjs add https://reddit.com/r/.../comments/.../
node bin/es.mjs check
```

That path is the one that still works when the profile itself is invisible,
which is the person who most needs an answer.

## What it does not do

It does not post, reply, vote, message, or read anybody else's account. It has
no verb that writes to Reddit. It reads public feeds, logged out, one request a
minute, and everything it learns stays on your disk.

Stored comment bodies are dropped after 48 hours (`node bin/es.mjs sweep`); the
ids, urls, dates, hashes and the full check history are kept, and every number
here is computed from those.

## Why the measurements are in the source

Every URL and field in `lib/reddit.mjs` carries the date it was measured, because
most of what is written about reading Reddit is out of date in a specific and
expensive way. `/r/<sub>/new.json` and every other `.json` path returns 403 with
a page of HTML; `.rss` returns 200 in the same second from the same address. A
feed answers valid, well-formed Atom with zero entries for at least three things
that are not "nothing new", one of which is a 404. A subreddit that does not
exist is answered by a silent redirect to a search feed with status 200.

If you find one of these numbers is wrong now, that is a genuinely useful issue
to open.

## Tests

```bash
node bin/test.mjs
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

ELv2 (Elastic License 2.0) — the canonical text is in [LICENSE](LICENSE).

In one breath: use it, change it, redistribute it, for yourself or your
company, free. The one thing you may not do is sell it to others as a managed
service. That line is chosen deliberately: it keeps the local tool honestly
free forever while leaving room for a first-party hosted version to fund the
work — the same trade Elastic, and half the infrastructure you already run,
settled on.
