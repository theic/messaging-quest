---
name: reddit
description: Read Reddit logged-out — visibility checks on your own words, and finding the people asking for what you sell. One request a minute, no account, no API key, nothing posted.
provides: platform:reddit
---

# Reddit, read as a stranger

This skill reads Reddit the way a logged-out stranger reads it, because that is
the only honest way to ask the question the tool exists for: *what does
somebody who is not you actually see?*

Every number below was measured, not read off a blog, and carries its date.
The mechanics live beside this file: `feed.mjs` (transport, Atom parsing, URL
shapes), `shapes.mjs` (which reads are worth a minute), `adapter.mjs` (the
contract the engine calls).

## The facts that shape everything

- **One request per 65 seconds, per address** (measured 2026-08-28). Every
  anonymous 200 returns `x-ratelimit-remaining: 0.0`. It is not a clean
  60-second window — a request at 61s was still refused — so the gap is 65s
  and the 429 handler defers to the number Reddit itself reports. This is
  Reddit's 2026-06-11 RSS throttle, and it is the *ceiling*, not a polite
  distance under one — there is no headroom above this gap, and Reddit has
  told moderators RSS is a scraping surface under review. The gap buys time;
  the browser lane and the hub are the plan (see PLAN.md).
- **`.json` paths answer 403 to strangers; `.rss` answers 200** — same
  second, same address (measured 2026-08-28). This tool reads feeds, not the
  JSON API, and that is why it needs no key and breaks no terms.
- **A subreddit that does not exist is a silent redirect with a 200**, not a
  404. Only comparing the final URL catches it.
- **A 200 that is not Atom is a block page**, and it is treated as a failed
  read, never as "nothing new". Three outcomes, never two.
- **The public description is not the rules.** Reddit does not serve the
  sidebar to a logged-out reader — measured on r/slp, whose "no recruiters"
  rule is invisible from here. So a room's rules are read once by a human at
  `reddit.com/r/<sub>/about/rules`, recorded in `rooms/<sub>.md`, and the room
  cannot be watched until that file answers.

## Where to look (corpus: 57 sources, 5,268 reads)

| shape | fit rate | reads per lead | verdict |
| --- | --- | --- | --- |
| scoped subreddit search (`restrict_sr=1`) | 42.2% | 2.4 | the workhorse |
| subreddit new submissions | 29.3% | 3.4 | good in problem-first rooms |
| site-wide search | 10.0% | 10.0 | the floor, exactly |
| comments firehose | 4.2% | 23.5 | **refused** |

## Being tolerable here

Reddit names "the same or similar comments across communities" as reportable
spam. The shape that cost a real operator their visibility was eleven replies
in 83.9 minutes across seven subreddits with no history in any of them. Hence
the engine's limits this skill inherits: two replies per room and five overall
in 24 hours, a standing check before every `sent`, and communities whose own
words forbid promotion are refused outright — with the sentence quoted.

Nothing in this skill posts, votes, messages, or reads anybody's private
anything. It reads public pages slowly and remembers what it saw.
