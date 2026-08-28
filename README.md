# earshot

**Find out what Reddit actually did to the comments you wrote.**

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
node bin/es.mjs watch <your-reddit-username>
node bin/es.mjs sync      # read your profile as a stranger sees it
node bin/es.mjs check     # re-read each thread, logged out
node bin/es.mjs status    # what became of the things you said
```

`check` takes about a minute per thread. That is not politeness — logged out,
Reddit answers one request a minute per address, measured. The tool waits rather
than getting your address rate-limited, and it groups your comments by thread so
one read answers for all of them.

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
failed read being reported as a finding.

## Licence

ELv2 (Elastic License 2.0) — the licence named in the roadmap, chosen so the tool
can be given away without a hosted competitor reselling it.

**The `LICENSE` file is not in this repo yet.** Paste the canonical text from
<https://www.elastic.co/licensing/elastic-license> before the repo goes public;
it is not reproduced here from memory, because a licence transcribed
approximately is worse than no licence file.
