---
name: reddit
description: Read Reddit in the operator's own browser — the people asking for what you sell, in your signed-in session; what became of your own words, in an Incognito tab as a stranger sees them. One real tab at a person's pace, no API, nothing posted.
provides: platform:reddit
---

# Reddit, read in your own browser

From 0.6.0 this skill reads Reddit one way only: a real tab in the operator's
own Chrome, rendered, read in the page's isolated world, closed after. There
is no feed transport, no background fetch, no API key. The operator's rule,
recorded 2026-09-04: "reddit must not be accessed anyhow but from the fully
rendered human browser, and for engineering simplicity this is the only
browsing mechanism in the tool."

Every number below was measured, not read off a blog, and carries its date.
The mechanics live beside this file: `pages.mjs` (which elements carry a
post, a comment, an author, a date — declared as `read_dom` specs the
extension runs; the URL shapes; the three-outcome read), `shapes.mjs` (which
reads are worth a page turn, and which are refused), `adapter.mjs` (the
contract the engine calls: the pages, the labels a person sees, the composer
the Insert button looks for).

## Two seats

- **The operator's session** for finding people: a subreddit's new posts, a
  scoped search, a post's own page for its body. What a signed-in person
  sees, in a tab of the "Messaging Quest" window they can watch.
- **The stranger's** for what became of the operator's own words: `sync`,
  `check`, `back` open their pages in an **Incognito** tab. Reddit shows an
  author their own shadow-removed comment as if nothing happened, so
  visibility can only be measured logged out. Chrome lets the extension into
  Incognito only once the operator has ticked "Allow in Incognito" for it
  (chrome://extensions → Messaging Quest → Details); until then those verbs
  refuse with that door named rather than answer from the wrong seat.

## The pages, measured 2026-09-04 (new Reddit, signed in)

| page | what carries a post or a comment | what it gives |
| --- | --- | --- |
| `/r/<sub>/new/` | `<shreddit-post>`, 28 on the first screen | id, title, author, permalink, created-timestamp, comment-count, score, post-type; a text post's body slotted in as `[slot=text-body]`, a link post's absent |
| `/r/<sub>/search/?q=…&type=posts&restrict_sr=1&sort=new&t=week` | `<div data-testid="search-post-unit">`, 7 for the phrase | a title link to `/comments/` and a `<time datetime>` — **no author, no body** |
| `/r/<sub>/comments/<id>/…` | `<shreddit-post>` with the full body; `<shreddit-comment>` (thingid, author, depth, permalink, postid, score, body in `[slot=comment]`) | 94 of a 296-comment thread on the first screen; `<shreddit-comment-tree totalcomments>` says how many there are, so absence from a partial read proves nothing (`truncated`) |
| `/user/<name>/comments/` | `<shreddit-profile-comment>` | comment-id, the comment's permalink, the body in `div.md`, a `<time datetime>` |
| the room's blurb | `<shreddit-subreddit-header description>` | the short public description — the free check for a blunt "no self-promotion" |

Because a search page previews posts without their bodies, a finding read is
followed by a read of each new post's own page, up to eight per read
(`bodiesPerRead`) — a person opens the ones that look like them, not the
whole page. The judge then sees what the person actually wrote.

Three things the read guards, because each was paid for:

- **A tab Chrome is not drawing renders the header and nothing else.** The
  feed loads client-side once the page is visible, and a leased tab moved
  into a collapsed tab group came up hidden. The extension fronts the tab
  (opens the group, raises the window if it must) before every read, and
  looks for a moment when the page was hidden until then.
- **A room that does not exist is a silent redirect** to a search page, with
  a 200. Only the final URL gives it away, and it is compared, not trusted.
- **Zero rows on a page that plainly lists posts is an error** ("the page
  shape changed"), never "nothing new". Three outcomes, always: could not
  read, read and empty, read and full.

## Pace

Page turns to one host are spaced by the control lane — 6 seconds plus up to
80% more, uneven on purpose, across every lease — and every read waits an
uneven moment first (250–900 ms), a page opened is looked at (1.2–3.2 s).
These are guesses at a person's tempo (2026-09-04), not measurements of what
Reddit treats as human; the first measurement replaces them. The old
anonymous ceiling (one feed request a minute per address, Reddit's 2026-06-11
RSS throttle) no longer applies to anything here, because nothing here fetches.

## Where to look (corpus: 57 sources, 5,268 reads, 2026-08)

| shape | fit rate | reads per lead | verdict |
| --- | --- | --- | --- |
| scoped subreddit search (`restrict_sr=1`, `type=posts`) | 42.2% | 2.4 | the workhorse |
| subreddit new submissions | 29.3% | 3.4 | good in problem-first rooms |
| site-wide search | 10.0% | 10.0 | the floor, exactly |
| comments firehose | 4.2% | 23.5 | **refused** |

The ratios were measured on the feeds; the pages carry the same posts, so
they hold. The 10% floor is the one part that generalises (lib/probe.mjs).

## The rules a person reads once

Reddit does not show a subreddit's rules to a logged-out reader, and the
public description is not the rules list — measured on r/slp, whose "no
recruiters" rule is invisible from outside. So a room's rules are read once
by a human at `reddit.com/r/<sub>/about/rules`, recorded in `rooms/<sub>.md`,
and the room cannot be watched until that file answers.

## The scout (milestone 1, 2026-09-03)

`agent.md` beside this file is the Reddit scout: a background colleague the
CMO proposes and the operator starts with one click, run on its own thread
in a tab of the operator's own signed-in Chrome. It reads a **subreddit
search page** at the address a person uses, records what it read through
`mq found` (same table and refusals as `probe`, the campaign it works under
carried on every row), has the judge seat judge it and the writer seat draft,
and stops to ask when it meets a wall. It holds the `browser.read` grant and
nothing else: no click, no type, and the extension refuses a click on any
control labelled post, comment, reply, send or submit even if one were
granted.

## Being tolerable here

Reddit names "the same or similar comments across communities" as reportable
spam. The shape that cost a real operator their visibility was eleven replies
in 83.9 minutes across seven subreddits with no history in any of them.
Hence the engine's limits this skill inherits: two replies per room and five
overall in 24 hours, a standing check before every `sent`, communities whose
own words forbid promotion refused outright — with the sentence quoted — and
a campaign that is a direction, never a template, with the eight-word repeat
guard run over every draft regardless.

Nothing in this skill posts, votes, messages, or reads anybody's private
anything. It reads public pages in a tab you can watch, slowly, and
remembers what it saw.
