# Messaging Quest

[![tests](https://github.com/theic/messaging-quest/actions/workflows/ci.yml/badge.svg)](https://github.com/theic/messaging-quest/actions/workflows/ci.yml)

**A marketing colleague that lives in your browser.** It finds the people
asking in public for what you sell, writes the reply three ways in your own
voice, and puts it in the comment box for you. You press Comment. It never
does. Free to run: free models, your own Chrome, no server anywhere.

Where it looks is a **skill** — a folder with the mechanics of one place
(`skills/reddit` ships; `skills/README.md` is the contract for the next).
Nothing in the engine or the panel knows a platform by name: the words on
screen, the rooms, the composer and even how the browser tells you are signed
in all come from the skill.

## TL;DR

Chrome, and a free OpenRouter key from [openrouter.ai/keys](https://openrouter.ai/keys)
— no card. Nothing to install on your machine: the whole engine runs inside
the extension.

1. Install the extension — from the Chrome Web Store once it is listed, or
   from this repo: `chrome://extensions` → **Developer mode** → **Load
   unpacked** → the repo folder itself (the manifest is at its root). One
   Chrome profile. Pin the icon and click it: the panel opens.
2. On the panel's **Settings** tab, paste the OpenRouter key. The free plan is
   the default: the scout, the judge and the writer run on free models, with
   nothing to choose.
3. The first cards ask for your site's address and your account on the place
   it watches — and the panel offers to **find that in this browser** rather
   than have you type it. The first time a read opens the site, a card asks
   you to allow it; click it once.
4. Optional: sign in on the Settings tab (a 6-digit code by email, or
   **Connect this browser** on [messaging.quest/link](https://messaging.quest/link))
   and your files — what you sell, the rule, the campaigns, the rooms, the
   ledgers — follow you to any browser with the extension. The key stays in
   the browser it was typed into. Tick **Allow in Incognito** on the
   extension's details page so the stranger's reads of your own profile can run.

Want the dashboard and the CMO too? That is the **local** mode — the same
extension pointed at an engine on your machine:

```bash
git clone https://github.com/theic/messaging-quest && cd messaging-quest && node bin/mq.mjs init && node bin/mq.mjs serve
```

Node 18 or newer. Then, on the panel's Settings tab, **Use that server**
(`http://127.0.0.1:8787`); `npm run brain` installs the CMO. The extension
reloads itself; open the panel again.

## The idea, in three paragraphs

**You tell it once what you sell.** Paste your site's address on the first
card; it reads the site in a tab of your own browser and proposes three short
files — what you sell, who it is for, and the rule that decides who is worth
answering. You correct them; nothing saves itself. Nine one-tap questions
measure how you write. Then it asks for one room (say r/smallbusiness) and the
phrase somebody types when they have your problem, probes it, and watches it
only if enough of what came back fits.

**Then it works one card at a time, in a side panel.** It reads the room in
your browser at a person's pace — real tabs, never a background fetch. A judge
model scores each post against your rule. For everyone who fits, the writer
writes **three drafts**, each a different move: *Straight* (the answer, short),
*Deeper* (what is behind their question), *Ask back* (one real thing and a
question you want answered). Pick a tab, edit it, or comment on it and all
three are written again. **Insert** puts your words into Reddit's own comment
box — the thread's, never under somebody's comment — and reads back that they
landed; you read them there and press Reddit's button. Everything that runs
is named at the top of the panel, and the judge runs by itself. Nothing in
this repository can submit.

**A CMO watches the whole thing** (local mode). When somebody writes back,
their reply lands on your deck before any new person, with the next turn
drafted. Once a day it reads the numbers per campaign and proposes: pause the
one that is saturated, aim a new one at a different kind of person. A
**campaign** is a direction — an angle, a room, a tone, a rule about naming
what you built — never a template: the writer applies it to one person at a
time, and the same eight words twice is flagged before you post.

<p align="center"><img src="docs/how-it-works.svg" alt="How it works: you and the side panel on the left, the engine in the middle, your Chrome reading Reddit and the free models on the right. Only you press Comment." width="820"></p>

## Where the engine runs

The engine is one set of files (`lib/`) with a filesystem underneath, and it
runs in two places on the same files:

- **Hosted** (the default): inside the extension's own service worker, on a
  memory filesystem that the browser keeps between sessions and, once you
  sign in, mirrors to your account — one table under row-level security,
  reached directly, no API of ours in between. No server. The models are
  called from the browser with your own key.
- **Local**: `node bin/mq.mjs serve` on your machine — the dashboard, the
  CLI, the CMO — with the extension as its hands in Chrome. Your data is
  `.mq/` on your disk, as files you can read with `cat`.

Either way every read of a platform is a real tab in your own Chrome, at a
person's pace, and the click that submits is yours.

The package the store gets is the checkout: `npm run pack` writes
`messaging-quest-extension.zip` with `git archive` — the manifest at its
root, `lib/` and `skills/` inside, nothing built.

## What free means here

Every seat — the scout that reads your site, the judge, the writer — runs on
OpenRouter's free models by default, and nothing is ever charged. The
platform's limits, read off its docs on 2026-09-01: 20 requests a minute and
50 a day on a fresh account (1,000 a day once $10 of credit was ever bought,
which is not required). A judge call covers five posts; a reply is one call
for all three drafts. Paid and Local (Ollama, nothing leaves the machine) are
one click away on the panel's Settings tab.

## The panel

Four tabs. **Next** is the deck: one card, one obvious thing to press — a
person to answer with three drafts, somebody who wrote back, a room's rules to
record, a read that is due. **Campaigns**: what you are trying, each with its
numbers, a focus for the deck, a room to search under it, pause and done.
**Rooms**: what is watched and when it was last read, a room to try. **Settings**:
where the models run, the key, the seats, your account, your projects, and
where the engine runs. The box at the bottom talks to the CMO (local mode),
and under the card sit the questions people typically ask it — what to do
next, who is waiting, how a campaign is going, why this person — one press
each. When an answer needs an action, the CMO deals it as a card rather than
telling you where to click.

In local mode the dashboard at `http://127.0.0.1:8787` is the ledger behind
it — Today, People, Campaigns, You — and `node bin/mq.mjs` is the same engine
from the terminal.

## What it never does

It does not post, reply, vote, message, or read anybody else's account. It
has no verb that writes to Reddit. Every read is a real tab in your own
Chrome, rendered, at a person's pace, with Chrome's own input pipeline — the
page sees only trusted events, and a test fails the build on the first
synthetic one. Every draft is checked before you see it: a first-person claim
your notes do not support, a link that was not in the thread, a phrase nobody
types to one person, eight words you have used before. The check names it;
you decide. Everything it learns stays yours: in your browser, in your
account if you sign in, or in `.mq/` on your disk — never on a server that
reads forums, because there is none.

## Everything else

The long form — how reading works, the visibility half (what Reddit did to the
comments you already wrote), the models and their measurements, campaigns,
projects, the return loop, skills, MCP, tests — is in
[docs/reference.md](docs/reference.md). The decisions and their reasons are in
[PLAN.md](PLAN.md).

```bash
node bin/test.mjs                # the engine, the cards, the seams, the routes, the memory host, the account
node --test bin/voice-test.mjs   # the voice fingerprint
node agent/test.mjs              # the runtime (needs npm run brain)
```

## Licence

ELv2 (Elastic License 2.0) — the canonical text is in [LICENSE](LICENSE). Use
it, change it, redistribute it, for yourself or your company, free. The one
thing you may not do is sell it to others as a managed service.
