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

A single Node script. No dependencies, no account, no API key, no server, no
model, no bill. It reads your own public profile the way a logged-out stranger
reads it, re-reads each thread you took part in, and tells you which of the
things you said a stranger can actually see.

It stores everything in `.earshot/` in the directory you run it from, as
append-only JSONL you can read with `cat`.

## Install

Node 18 or newer. Nothing else.

```bash
git clone https://github.com/YOUR-NAME/earshot && cd earshot
node bin/es.mjs init
```

## Use

```bash
node bin/es.mjs me <your-reddit-username>
node bin/es.mjs sync      # read your profile as a stranger sees it
node bin/es.mjs check     # re-read each thread, logged out
node bin/es.mjs status    # what became of the things you said
node bin/es.mjs back      # who replied to you and is still waiting
```

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

## Judging, and where the model is not

`tick` reads feeds and stores what is new. That loop is plain code — **no model
runs in it.** Judging is a bounded call that happens outside this process
entirely: `pending` prints what needs a verdict as numbered JSON, and `judge`
takes `[{n, fit, why}]` back on stdin.

That is what keeps the tool free, local and model-swappable: point it at
whatever you already pay for. Every verdict is stamped with a hash of your
`rule.md`, so when the queue changes you can tell whether it was your rule or
the model that moved.

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

ELv2 (Elastic License 2.0) — the licence named in the roadmap, chosen so the tool
can be given away without a hosted competitor reselling it.

**The `LICENSE` file is not in this repo yet.** Paste the canonical text from
<https://www.elastic.co/licensing/elastic-license> before the repo goes public;
it is not reproduced here from memory, because a licence transcribed
approximately is worse than no licence file.
