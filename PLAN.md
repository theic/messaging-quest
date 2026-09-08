# The plan

Messaging Quest wants to be the open engine under SaaS marketing — the way OpenClaw
became the standard for local assistants — and this file records what that
means in decisions, so the next contributor argues with reasons rather than
with archaeology. The market picture behind the newest decisions is measured,
dated and sourced in [research/market-2026-08-31.md](research/market-2026-08-31.md).

## North star

A virtual marketing specialist for solo and vibecoded SaaS founders — a
colleague, not a control panel. It holds the brand's memory, listens where
the buyers talk, drafts in the founder's own voice, checks what search and AI
engines say about them, and *tells you the next action* instead of waiting to
be operated: one card on screen, prepared options, you almost never type. All
local, all refusable, and a human sends everything. Milestone 1 (2026-09-03)
is the colleague itself: a CMO on Deep Agents that drives your own browser
through leased tabs, proposes the next action as a card, and runs the Reddit
search as its first background task — onboarding, reading and posting without
shadowbans, done *by* it rather than around it.

**The suite is emergent, never built.** Core stays the primitives below;
every marketing capability arrives as a skill. The day `lib/` grows an
`seo.mjs` is the day this became the thing it replaces.

| primitive | today | grows into |
| --- | --- | --- |
| memory | rule/project/icp/me.md, voice.json | the brand book — positioning, proof, competitors |
| store | append-only ledgers, hash-stamped verdicts | the measurement history any channel writes into |
| governor | 65s gap, bursts, room refusals | etiquette as a first-class object, per channel |
| judge | "is this person our fit" | "does this page answer our ICP", "is this thread ours" |
| writer | replies in measured voice | any copy in measured voice, guarded by me.md |
| skills | reddit | linkedin, hn, seo, geo — each with its own measured facts |
| surfaces | dashboard, CLI, MCP, hub | the same four; the assistant is the harness |

## The shape (as of 0.4.0)

```
heart       lib/ — the store, the probe economics, the burst limits, the
            memory files, the model seats (paid, free or local — one file,
            lib/models.mjs, nothing above it knows), the DECK (lib/cards.mjs:
            state → the one next action, deterministically), the PROJECTS
            (lib/projects.mjs: the root is the default, every other one a
            whole data directory of its own; lib/dirs.mjs says what is the
            machine's), the CAMPAIGNS (lib/campaigns.mjs: a direction, never
            a template), the BROWSER (lib/browse.mjs: the engine's client on
            the control lane — the only way anything reads a platform),
            the CONVERSATIONS (lib/conversations.mjs: what happens after
            the opener — opened on "I posted it", bound to the operator's
            own comment, read again from the stranger's seat, dealt as a
            turn card before any new person; the digest that reminds the
            specialist).
            Knows no platform: labels, page shapes, the composer's words all
            come through the adapter door. Zero dependencies, non-arguable.
skills      skills/<id>/ — a platform is a SKILL.md + adapter.mjs. Reddit is
            the first and deliberately the only one. Local skills load from
            .mq/skills/ without forking. Contract: skills/README.md.
brain       agent/ — the CMO (strategist.mjs) and its runtime (tasks.mjs:
            workers on their own threads, the inbox, the tab leases;
            threads.mjs: the SQLite checkpointer; verbs.mjs: the CLI's verbs
            as tools), on Deep Agents. The ONE directory that carries
            dependencies, behind one lazy import; everything else runs
            without it being installed (`npm run brain` turns it on). Its
            tools are the CLI's verbs; its skills are skills/<id>/SKILL.md;
            its colleagues are skills/<id>/agent.md. The control lane's
            broker (lib/control.mjs) is heart, not brain: zero-dep, screened
            by grant, paced per site.
surfaces    the Chrome extension (primary: the deck in a side panel, and the
            only surface that can type a draft into Reddit's real composer;
            from 0.10.0 also the ENGINE's own host — lib/ in its service
            worker on a memory filesystem, no server, the files mirrored to
            the account (extension/engine.js, extension/account.js);
            from milestone 1 also the control lane — a browser toolkit like
            Claude in Chrome's, on tabs a task leased; from 0.6.0 the only
            way anything here reads a platform, in the operator's own
            session or, for the visibility verbs, an Incognito tab)
            the dashboard (the back office: stats, prospects, memory, models —
            and /panel/, the same deck served as a page)
            the CLI (scripts, cron, OpenClaw — one implementation of every verb)
            the MCP server (Claude/ChatGPT/any MCP host — bin/mcp.mjs)
            the hub feed (other machines — bin/hub.mjs, the only outward port)
memory      five markdown files the human owns. The model proposes; a person
            presses Save. rule.md's hash rides on every verdict; persona.md
            reaches only the strategist.
skills      the common directory. SKILL.md always; seats optional —
            adapter (a platform), page (a dashboard screen), agent (a
            colleague for the strategist). Two rings (skills/, .mq/skills/);
            slots resolved in skills.json; doors in lib/platform.mjs,
            bin/serve.mjs, agent/strategist.mjs.
```

**The heart has zero runtime dependencies; the brain carries them.** The
engine's model layer is `lib/llm.mjs` — fetch, a JSON-schema check, a tool
loop — and `npm install` at the root still installs nothing: the engine, the
dashboard, the deck and the extension all run on bare Node. The open-source
foundation stays non-arguable — only what you cannot avoid — while the
strategist gets the harness it genuinely needs. One directory, one seam, one
install command between the two.

## Decisions of record

**Not built on OpenClaw.** OpenClaw is an assistant *host*, not a library —
the correct relationship is that an OpenClaw agent drives Messaging Quest, which
`integrations/openclaw/SKILL.md` and the MCP server both provide. What Messaging Quest
takes from OpenClaw is the *pattern* that made it a standard: local-first, one
job owned completely, markdown memory, skills as folders, nothing to install.

**Not built on Hermes.** A model family plus a harness tuned for it. Messaging Quest
is model-agnostic through OpenRouter on principle — any model can occupy a
seat by id, including a Hermes model. The chassis must not belong to a vendor.

**Deep Agents removed from the ENGINE (was: 0.2.0's model layer) — and
re-adopted for the STRATEGIST (2026-09-01).** The removal reasoning stands
unchanged: the engine used one tool-loop and three structured calls from
three frameworks, and `lib/llm.mjs` (fetch + schema check + tool loop) still
runs every seat — judge, scout, writer. The same paragraph wrote down the
re-adoption triggers: *unbounded steps, hours of held state, subagents*. The
north star's move from "a reading tool" to "a marketing specialist that
plans, researches in parallel, and holds a conversation" is those triggers
firing — so the strategist (`agent/strategist.mjs`) is built on Deep Agents
and the LangChain ecosystem: the planning loop, the virtual scratch
filesystem for context management, subagents for research, summarization for
long threads, and a skills loader that reads the same `skills/<id>/SKILL.md`
every other surface learns from. The boundary is the decision: `agent/` owns
the dependency, `lib/` and `skills/` never import from it, its every action
goes through the same CLI verbs (refusals and governor included), and the
repo runs without it installed. Verified live 2026-09-01: first strategist
turn read the real queue, picked the freshest fit, did the 2-per-room pacing
math unprompted, and offered the draft for human review.

**The extension returns, as the primary surface (2026-09-01).** 0.3.0's
"MCP + dashboard, no extension" stood on the old goal. Under the specialist
goal the user's own daily browser is the seat that matters — it holds the
logged-in sessions, it is where posting happens, and (the predecessor's
market file, researched 2026-08-03, still holds) it is the categorically
strongest answer to ban-fear: same browser, same fingerprint, same IP, human
volume, human presses Post. The panel is ONE CARD — no list, no landing
screen — and the deck it renders is built server-side in `lib/cards.mjs`, so
the dashboard's `/panel/` page, a future Telegram relay and the extension are
one surface in three places. The dashboard remains the back office. The
extension is also the future **browser read lane**: the predecessor's relay
(Node reads Reddit *through* the panel, GET-only by construction) is the
measured shape for it, not yet rebuilt here.

**Cards are the HITL protocol (2026-09-01).** One card, one question, one
primary action; options are worked answers, free text never required; the
site read fires first and runs while the voice habits are answered; every
proposal names the address it was read off; the flow never dead-ends; empty
states are honest ("nothing worth your name" only when the machine is really
on). These laws are inherited from the predecessor's onboarding rework
(messaging-quest, docs/onboarding-cards.md, built and user-tested 2026-08),
along with its card renderer and its insert-never-submit page function —
ported, not reinvented.

**Posting: nothing is ever SUBMITTED by the machine (2026-09-01).** The
doctrine sharpens from "nothing posts" to its load-bearing form. The
extension may *type* an approved draft into Reddit's real composer (native
value setter, appends, click-allowlist screened so the opening click can
never be a submitting click) — the human reads it there and presses Reddit's
own button. "I posted it" is then recorded through the same gate the CLI
enforces: standing checked, burst limits counted, room refusals quoted. The
governor's no arrives on the card as a disabled button that says why.

**Platforms grow by extraction, not speculation.** The adapter contract (v0)
is exactly what Reddit proved necessary. When platform #2 lands, whatever it
proves generic moves up; nothing is added because it might be needed. Known
debts to extract then: `r/…` labels still cosmetically hardcoded in UI
strings; `lib/rules.mjs` still holds reddit's sidebarUrl/parody.

**Contract law: a skill ships its refusals or it ships nothing.** An SEO
skill refuses doorway pages; a GEO skill refuses fabricated citations; every
outreach skill inherits the governor. Also stated in skills/README.md.

**The moat, restated (2026-08-31).** The visibility check is the hook, not
the moat — Reveddit does it free. "Never auto-posts" is now advertised by
half a 30-tool category, so etiquette *stated* is worth nothing. Etiquette
*enforced* — rules parsed, the forbidding sentence quoted back, limits that
actually stop the click — is still shipped by nobody else, and it must be
demonstrable: refusal receipts and `mq ready` are product surface, built to
be screenshotted. The moat is user-owned memory + enforced refusals + the
open engine behind agent surfaces.

**Reading survives by never depending on one lane (2026-08-31).** The facts:
Reddit killed unauthenticated `.json` in May 2026, throttled RSS to ~1
request/minute/IP on 2026-06-11 — so the 65s gap "measured" on 2026-08-28 was
a measurement of that throttle, and the anon lane sits at the ceiling with
zero headroom and a dated warning (RSS named to mods as a scraping surface;
Nitter died by C&D 2026-08). The official Data API is not a plan either: new
keys are manually gated (2025-11) and GummySearch died holding out for a
license. Therefore three lanes, carried by the adapter contract: **anon**
(kept while it lasts), **the user's own logged-in browser** (human-paced,
promoted from convenience to survival architecture), and **the hub** (one
machine reads, many pull — scarcer reads make it more valuable). To measure:
Reddit's account-bound private feed token as a compliant finding fallback.
The stranger-check stays logged-out at low volume, because logged-out *is*
the measurement. *Superseded 2026-09-04:* the anonymous lane and the hub as
a reading lane are gone; one mechanism remains — the operator's browser —
see "One browser" below. The hub still shares what one machine found.

**AI-citation tracking: exclusion revised (2026-08-31).** Earlier versions of
this file listed it under "deliberately not built" — a scope decision under
the old goal, not a principle. Under the north star it returns as a GEO
skill, and only in this repo's epistemology: ask the engines the ICP's own
questions, record cited / not cited / could not ask — three outcomes, dated,
and no invented 0–100 visibility score. The suites sell those scores; we
refuse them for the same reason we refused subreddit match scores.

**Distribution (2026-08-31).** The OpenClaw/ClawHub channel is proven
(5,400+ skills), and its Reddit-listening slot is currently a *paywalled
hosted* skill. An actually-open engine aimed at that slot is the cheapest
land-grab available — so publishing (public repo, npm name, CI, the open
OpenClaw skill) outranks feature work as soon as milestone 1 has testimony.

**The hosted twin (Vercel/Supabase) reuses the core by seams, not by fork.**
`lib/store.mjs` reimplemented over Postgres, `seat().baseUrl` pointed at the
metered proxy, auth in front; judging, drafting, refusals, memory unchanged.
Priced inside what founders demonstrably pay — $19–49/mo — because GEO-only
pricing is collapsing into $50–99 suite line items (HubSpot AEO,
Adobe/Semrush) and subscription resistance in this audience is loud. Licence
supports the split: Elastic-2.0 — free to use, modify, redistribute; nobody
may resell it as a managed service, which is exactly the twin's moat.

**Skills generalised: seats, slots, rings (2026-09-01).** The extension
story stops being platform-only. One common directory (`skills/`, plus the
local `.mq/skills/` ring that wins on id collision); one manifest (SKILL.md
frontmatter, now with optional `provides: <slot>`); three executable seats,
each behind a named door — `adapter.mjs` (lib/platform.mjs), `page.mjs`
(bin/serve.mjs, PostHog's configurable-dashboard move at our scale),
`agent.mjs` (agent/strategist.mjs adapts bare-Node modules into Deep Agents
subagents — the Okara shape, one CMO with purpose-specific colleagues, as
folders instead of a paywall). Competing implementations of one purpose
coexist; the instance chooses in `skills.json` / the Skills screen /
`mq skills use`, and an unresolved stalemate runs NOBODY, loudly — a guess
there is a dashboard quietly running code the operator did not pick. The
registry (lib/skills.mjs) only discovers and resolves; it never executes
seat code. Contracts grow by extraction, same as ever.

**The brand (2026-09-01).** Messaging Quest, settled: the working name
earshot retired everywhere a person or a machine reads — package
`messaging-quest` (npm name checked free 2026-09-01), bin `mq`, data dir
`.mq/` with a one-time rename migration so nobody's queue starts over. The
domain (play.messaging.quest) predates the rename; the repo home is
theic/messaging-quest.

**Three plans for the seats (2026-09-01).** The model seats had one address
— OpenRouter, a key, a bill — and a tool whose pitch is "runs on your
machine" should run for free on it. So `lib/models.mjs` grew a plan: paid
(the measured defaults, unchanged), free (OpenRouter's `:free` variants —
every one that takes a tool call was measured on the judge's own two-item
verdict, and the two best on the scout's loop and the writer's material; the
defaults are the measurements, the menu keeps the ones that were full and
says so), and local (Ollama's OpenAI endpoint by default, any address by
choice, no key, nothing leaves the machine). Each plan keeps its own picks.
`lib/llm.mjs` learned two things and nothing else: OpenRouter's routing
fields go only to OpenRouter, and a conforming JSON object inside a prose
answer is the answer — a local server that ignores `tool_choice` should not
cost a retry. The local defaults are the one unmeasured thing in the file,
and the Settings page says so in those words rather than dressing a size as
a number; the first local measurement replaces the note.

**The register (2026-09-01).** The writer's rules gained how a comment
sounds, as channel mechanics rather than taste: one person who has done the
thing, typing to one other person; the answer in the first sentence; their
words, not marketing words; an opinion, not padding; and none of the phrases
nobody types to a stranger. The fingerprint still outranks it on everything
it measures. The mechanical half is a third flag on `--save`
(`lib/guards.mjs` `tells`): phrases, never vocabulary, and the em dash only
against a voice not seen typing one. Measured before the change, the phrase
check fired on none of the six drafts on disk — the paid writer was already
clean at that level — so what the register buys is shape, which no regex
scores and a reader notices at once. One more line, from one measurement:
told to answer through the tool, Kimi K3 wrote a draft in 34s; handed the
material bare it wrote prose first and took 128s and two calls.

**The look (2026-09-01).** The dashboard and the panel wear the brand's own
tokens, read off play.messaging.quest's computed styles: warm paper with a
dot grid, near-black ink, lime for the one action, coral for the bad number,
square corners, a hard offset shadow, pixel-style uppercase labels. The
typefaces are the site's when installed and the system's when not — the CSP
still forbids fetching a font, and a wordmark is not a reason to bend it.

**The 404 that vanished (2026-09-01).** A profile that 404s to a stranger
stores nothing, so every "nothing stored yet" screen — Standing, Ready,
`mq status` — reported the tool's loudest finding as a blank slate the moment
`sync`'s output scrolled away. The read ledger remembers; now every one of
those surfaces asks it first, and a test pins that a 404'd profile is never
again reported as "not read".

**The CMO is milestone 1 (2026-09-03).** The strategist of 0.4.0 talks and
proposes; a colleague also *does* — in the background, in your browser — and
comes back with something. So the agent gets a runtime around it: the CMO on
one long-lived thread; each background task a second Deep Agent on its own
thread, in a tab it leased inside the user's own Chrome window; an inbox
between them that the CMO reads when idle and is allowed to ignore. This
replaces the old milestone 1 ("a Reddit reply tool done properly") by
containing it — onboarding, the Reddit search and the reply are the first
things the CMO does. Every earlier decision stands; the ones below are what
the CMO adds. The brief for building it is "Milestone 1, for the next agent"
below.

**Background work is a thread, not a tool call (2026-09-03).** Deep Agents'
`task` tool runs a subagent inside the caller's turn: the CMO would wait for
the slowest scout, and one worker's pause would freeze the chat. A scout is
therefore its own run on its own LangGraph thread, started by the runtime,
reporting by events. `task` stays for research inside a reply. This is the
shape Claude Code uses for its own background agents, and it is what lets
the CMO decide whether to react.

**Approvals are cards; interrupts live only in workers (2026-09-03).**
LangGraph drops a pending interrupt when a thread is invoked with fresh input
instead of a resume — so the CMO's thread is never left waiting on one. When
it wants something started it deals a proposal card (the 0.4.x mechanism:
re-parsed by the server at act time, so a card can never do more than its
label says); the click starts the work and the CMO hears of it as an event.
A worker that needs a person — a captcha, a permission, a choice — calls
`interrupt()` on its own thread, which is persisted, queued on the deck
oldest-first, and survives a restart. Several blocked workers are several
paused threads; nothing is lost, one card shows at a time. A blocked worker
the CMO has not surfaced within a minute is surfaced by the runtime itself:
discretion for signal, none for a person waiting.

**The control lane, beside the read lane (2026-09-03).** `lib/relay.mjs`
stays GET-only by construction and unchanged (*retired 2026-09-04* — the
control lane is the one lane now). The extension gains a second
protocol: a browser toolkit with the same reach as Claude in Chrome, on tabs
a task leased. That reach includes click and type, so the posting doctrine
moves from construction to grant plus a screen: no agent may click or type
unless its definition says so, none does in milestone 1, and the extension
refuses a click on any control whose label the insert screen already refuses
(post, comment, reply, send, submit) — by construction again, one layer down.
Reads on this lane pace themselves per site inside the lease, because the
CLI's governor cannot see them. Visibility checks (sync/check/back) never
take this lane: logged-out is the measurement.

**The browser behaves like a person (2026-09-04).** The agent's browsing is
a real tab, and nothing else: no fetch of a page from the extension's page
code, ever. The tabs sit under the "Messaging Quest" group in a window of
their own, opened unfocused so the operator's window keeps the keyboard, and
the tab being worked is the active one there — found live: Chrome processes
input events only for a tab it is drawing, so a hidden tab in the operator's
window stalled every click, and a tab brought forward there would steal
their view. Claude in Chrome works in its own window for the same reason.
Before any input the extension asks the page whether Chrome is drawing it
(`document.visibilityState`, a read) and raises its window when not — the
machine's window comes up when the machine acts — falling back to a fresh
unfocused window, and answering with a clear error, Chrome's windows listed,
when it is still hidden; nothing is clicked into the void. A container is
not a control: a custom element on Reddit is screened only when it carries
an aria-label or a label of forty characters or less, so a title link is
clicked for its own words and not refused for the "1 vote" beside it. Reading is `chrome.scripting` in
the isolated world and writes nothing into the page — no attribute, no
element, no synthetic event, no script scroll. Doing is Chrome's own input
pipeline through `chrome.debugger`: the mouse travels to a control along a
curve and rests before it presses, off-centre; a scroll is wheel ticks of
uneven size; typing is one key at a time at an uneven rate; every job waits
an uneven moment first and a fresh page gets looked at for a few seconds.
Every event the page sees is `isTrusted`. The console reader enables the
Log domain only — `Runtime.enable` is the one CDP call sites test for and
nothing makes it. The panel's Insert button goes through the same hands (a
real click on "Add a comment", a real click into the box, the draft pasted
as one piece), and the platform's own button stays the human's. A test
reads the extension's page code and fails on the first synthetic event,
script scroll, value assignment or `Runtime.enable` that creeps back. The
tempo's ranges are guesses at a person's (2026-09-04); the first measurement
of what a site treats as human replaces them. The relay's background fetch
(`extension/relay.js`, a GET in the user's session with no tab) was the one
remaining read that was not a tab; the operator decided it the same day —
retired, see "One browser".

**One browser (2026-09-04).** The operator's rule, verbatim: "reddit must
not be accessed anyhow, but from the fully rendered human browser and for
engineering simplicity this should be the only browsing mechanism in the
tool." So there is exactly one way anything here reads a platform: a real
tab in the operator's own Chrome, leased through the control lane, rendered,
read in the isolated world, closed after. `lib/relay.mjs`,
`extension/relay.js` and the reddit feed transport are deleted; the CLI's
verbs, the site scout and every colleague read through `lib/browse.mjs`;
a test fails the build on a `fetch` in the skill, the site scout or the
engine (the CLI's one fetch is the hub pull). What a page looks like is the
skill's to declare — `read_dom`, a selector and a field map the extension
executes, never platform code in the page (`skills/reddit/pages.mjs`, every
shape dated) — and the engine only ever sees entries. Two seats: the
operator's session for finding people; an **Incognito** tab for
sync/check/back, because Reddit shows an author their own shadow-removed
comment as if nothing happened and the stranger's view is the measurement.
Chrome admits the extension to Incognito only once the operator allows it
there, so until then those verbs refuse with that door named. Found on the
first live read: a tab Chrome is not drawing renders Reddit's header and
nothing else (the feed loads client-side once visible), and a tab grouped
into a collapsed group is hidden — so the extension fronts the tab before
every read, not only before input. The pace is the lane's (6 s plus up to
80 % more between page turns to one host; a look-pause on every page), a
guess at a person's tempo until measured.

**Projects (2026-09-04).** The operator works on more than one thing, and a
queue judged against the wrong rule.md is worse than no queue. A project is
a whole data directory — memory files, store, voice, deck, tasks, threads,
campaigns — and the root `.mq/` IS the default project, so nothing
migrates and the first onboarding happens where it always did. Others live
at `<root>/projects/<id>/`, made complete from the seeds and switched to at
once; `projects.json` is the pointer every surface reads (the panel's
picker, the dashboard's Projects page, a bare `mq` command), so switching
in one place switches everywhere. What crosses the line is short and
pinned (`lib/dirs.mjs`): the key and the seats, `contacted.jsonl` (never
the same human twice, in any project), the local skills ring. Copied once
at birth, because they are about the person: the account, the voice, me.md,
the persona. The server runs one runtime per project — its own CMO thread,
colleagues and inbox — so a task started under one keeps running when the
operator switches; the control lane is the machine's, and its events carry
the project whose lease raised them.

**Campaigns are directions, never templates (2026-09-04).** The voice
measured at onboarding is how the operator sounds; a campaign is what they
are trying, this month, in this room — a tactic, an angle, a different
disclosure rule for a different platform. It is a markdown file the operator
owns (`campaigns/<id>.md`: the idea, who it fits, what it never does,
`mention`) that the CMO may PROPOSE (`propose_campaign` deals it as five
cards, each seeded with its text and each with a field for the operator's
own words) and only a person's Save writes — the same law as the five
memory files. The file holds instructions, not wording: Reddit names "the
same or similar comments across communities" as reportable spam, so the
writer is handed the direction and the last drafts written under it, told
not to reuse a phrase, and `mq draft --save` runs the eight-word repeat
guard regardless. The guard is the enforcement; the prompt is the intent.
`mention` is the one lift of the opener's no-mention rule and it has one
form — disclosed: named once, plainly, as theirs, no link unless asked. There
is no undisclosed setting and there will not be one. Findings, probes,
sources, verdicts (with the campaign's own rubric hash) and drafts carry
the campaign they came in under, and the deck's watch/judge/draft walk runs
under it. A campaign walk the operator started outranks the queue, not a
colleague waiting on them. Verified live the same day: the CMO's proposal
for the operator's dogfooding tactic, the walk on the panel, the probe under
the campaign in the browser, 7 judged and 4 fit, the room watched under it,
and a draft that disclosed once, linked nothing, offered and asked — with the
claims guard firing because me.md was empty.

**The engine moves into the extension; the site keeps the account
(2026-09-08, 0.10.0).** The goal set on 2026-09-08: replace the old
messaging.quest backend/extension pair with this engine, no local server,
the extension from the store, the files synced with the account, the old
database's users and quests untouched, KISS. Two ways to have no local
server: run the engine on messaging.quest (a stateful broker in Postgres,
every act a round trip, a per-user process for anything long, our compute
on every read) or run it inside the extension. The second is the one:
the engine is plain files with a filesystem underneath, so `lib/fs.mjs` is
now the one door to that filesystem, installed by a HOST — `lib/node.mjs`
(the real modules) or `lib/fs-memory.mjs` (a Map, POSIX paths, a change
hook; IndexedDB keeps it between the worker's lives) — and the same
`lib/` runs in the extension's service worker with no server anywhere: the
deck dealt there, the verbs run there (`lib/verbs.mjs`, the CLI's bodies as
a factory), the models called from there with the operator's own key, and
every read through the control lane's broker IN THE SAME WORKER — the
tabs, the mouse, the pauses, the refusals as audited, minus the HTTP
between a verb and its tab. `lib/engine.mjs` is the middle of the old
bin/serve.mjs as a factory (the deck, the jobs, the panel's tabs, the
broker, one route table); the dashboard serves that table over HTTP and
keeps its HTML views, the worker serves it over chrome.runtime messages.
The manifest is at the repo root so Load unpacked on the checkout is the
extension and `git archive` is the package. Two modes, one setting: hosted
(default) and local (a `mq serve` — the dashboard, the CMO; an install from
before saved a server address and stays local). Supabase directly, no API
of ours between: the 6-digit code the site already uses, or the site's
/link handing the extension a one-time token hash (externally
connectable); the data directory mirrored to one table, `mq_files`, under
row-level security, last writer wins per file, pulled once a minute; the
key never leaves the browser it was typed into. The site keeps auth,
/link, /files (the mirror, read-only), the Quest Board, billing, the MCP
connector; its extension backend (api/ext, lib/ext, lib/signals' watcher,
the Fly drains for it) goes. Two facts measured on the way: a service
worker may not await at the top of a module, and may not import() at run
time — so nothing in lib/ loads at import (every entry point calls
loadPlatforms first) and skills/index.mjs imports the built-in adapters
statically for the worker to hand in. Not in the hosted product: the CMO
(agent/ needs Node — local mode has it), the dashboard's pages, a second
way to read anything.

**One Chrome profile at a time on the lane (2026-09-07, 0.9.2).** The
retest after 0.9.1 merged: every probe ended within a second with "that tab
is gone", alternating with a good answer. The extension was loaded in two
Chrome profiles, both workers long-polling the one lane; a job went to
whichever answered first, and a tab is visible only to the profile that
opened it. The rule, in the broker: each worker names itself (a random id
in session storage — a worker restart keeps it, a Chrome restart does not)
and every poll carries the name; a lease is bound to the instance that ran
its first job, and every later job on it — the reads, the release — goes
to that instance only; a job that opens a new tab goes to the OWNER: the
instance whose panel the operator has open (the panel puts the name on its
deck poll), else the first to arrive; a second panel does not take the lane
from one seen within the minute, so two open panels are stable; an instance
silent for ninety seconds is off the lane (a worker does not poll while it
runs a job, so one with a job in hand is busy, not silent), and a call on
its tab is answered out of reach at once instead of after the job's
timeout; the owner role moves after thirty seconds without a poll, so a
reloaded or closed profile does not stall the next tab until the job's own
timeout — measured on the first live run: a lease unanswered for sixty
seconds while the old owner aged out at ninety. `/api/cards`
carries `control.instances`; the strip says, in both profiles, that the
extension is loaded in two and where tabs open. Not chosen: refusing the
second worker outright (a profile the operator just switched to would be
dark until the other closed), or the server picking a profile itself (it
cannot see them; the panel can).

**Where a reply lands, the strip at the top, the judge on its own clock
(2026-09-07, 0.9.1).** Three things the operator hit on the first day with
the extension in hand. ONE: "Open the thread & type it in" put the words
under the first comment, or nowhere. Measured on Reddit's thread page: the
thread's own composer is not a button — it is a twenty-pixel textarea whose
placeholder reads "Join the conversation", swapped for the real editor (a
44-pixel contenteditable inside shreddit-composer) on a click — so a finder
that wanted a box at least 28px tall or a button wearing an opener's label
saw neither and fell through to the first comment's Reply, which every
comment carries. Now a typable thing wearing an opener's words IS the
opener; the reply knows where it belongs (the card says `target`: post —
outside every comment; comment — inside the first one on the page, which on
a comment's own page is the one being answered; the platform says what
holds a comment, `composer.comments`); the search field is never a box; the
composer's own buttons are never openers; and whether the words landed is
READ back from the box before the panel says so — an editor that ignored
the IME-style insert gets a real Ctrl+V with the draft the panel itself put
on the clipboard, and only then. TWO: silence meant working. Everything that
runs is named in one strip at the top of the panel, on every tab — the
server's jobs with their progress and a clock, the colleagues in their tabs,
the panel's own work (a question in flight, a thread being opened) — and
when nothing runs, what last finished and how it went, in coral when it
failed; "Nothing running." is said in so many words. The card follows: a
draft being written is a wait, not the same button; a failed attempt puts
its reason on the card and offers once more; a refused start ("draft is
already running") comes back to the panel as words instead of a button that
seemed to do nothing. The card is redrawn only when it changed, so the
panel can poll while idle without wiping an edit. THREE: the judge starts
by itself — a verdict is not the operator's decision to make; the rule is
theirs and the reading is the model's — every ten seconds when something is
pending, a model is there, no read is still filling the queue, none is
running, and the last one did not fail within five minutes (a 429 on the
free plan asked again every ten seconds is how a day's budget goes). The
card waits while it runs and says why when it failed; the Rooms tab's
button stays for the impatient.

**Publish-ready: the tree read for dead code, the type up, the specialist
shown the deck (2026-09-07, 0.9.0).** Three passes before the repository
goes to people who did not build it. First, WHAT NOBODY CALLS GOES. Every
export was counted against every file: six functions with no caller were
deleted (an HTML reducer, a role summary, an active-campaigns filter, a
draft-count constant, an empty-voice check, an etiquette note), twenty-one
exports nobody imports lost the keyword, and the two comments that still
spoke of the relay were reworded. No behaviour moved; the suites say so.
Second, THE TYPE. Nothing under 12px anywhere; the panel's body at 15px
and its drafts at 15px on 1.55 — a side panel is read at arm's length and
the draft is what the operator reads most carefully; eyebrows, tags and
table heads in the monospace or the bold sans rather than a pixel face that
was never installed on anybody's machine; the faces stay the site's when
they are installed and the system's when not, and no font is ever fetched.
Third, THE SPECIALIST IS SHOWN THE DECK, NOT ASKED TO LOOK. The questions
people typically ask sit under the card as buttons (extension/suggest.js —
pure, drawn from the panel's state, so the campaign is named and the
waiting counted). Every panel message arrives with the deck in front of it
— each card's kind, the button it actually carries, whether its drafts are
written and, for the card on screen, the drafts' own words — and with the
engine's counts, because a free seat does not always call the tool the
doctrine tells it to: asked "what next" it offered to draft what was
drafted and named a button that did not exist; asked for a count it
carried "0 sent" over from an earlier turn. The doctrine gained: name only
the button the deck shows, never offer to write what is written, answer a
count from the numbers in this message, never send the operator to a
terminal, plain text under 120 words. The panel says where a dealt card
went (on top, or behind the one on screen) and, after twenty seconds, that
a turn which writes takes a minute or two. And ONE GUARD, from the run: the
writer, told it may name what the operator built and handed a me.md that
was still the seed, wrote "i built doctick" to the person who built
DocTick. So an unfilled me.md is empty to the writer, the disclosed rules
say whose X is, and `theirs` (lib/guards.mjs) flags a name claimed as
built that appears in their post as a name and nowhere in me.md — a flag,
never a rejection, like the others.

**Three drafts, four tabs, free by default (2026-09-06, 0.8.0).** Before
the tool is shared with people who did not build it, three things were
decided at once. First, THE WRITER WRITES THREE, ALWAYS. It used to be
asked for "up to three options differing by move" and allowed to send one;
the server kept the first and the other two lived in a job log nobody
opened. The three moves are now named once (lib/writing.mjs STYLES:
straight, deeper, ask back — what the reply DOES for the person, never a
tone; the measured voice and a campaign's `## Voice` own the tone), the
writer is told to write one of each, a round that comes back short is asked
once more for what is missing with the good ones in front of it, and a
round saves as ONE row with the three as `drafts` and the first doubled as
`text` so every older reader still finds a draft. The card shows them as
tabs; each tab keeps its own edits; the button says which tab it was
pressed from, and that style is written on the mark and on the
conversation's turn — so what people actually choose is on the ledger. A
note on any tab (Rewrite) goes to the writer with that draft as the
rejected one and ALL THREE come back written again, the one commented on
most of all: iteration by comment, like a chat product, without ever
touching the field's contents behind the operator's back. The guards run
over every tab; the repeat guard reads every tab of everybody else's
rounds. Second, THE PANEL STANDS ON ITS OWN. One card and an ask box was
minimalism that hurt: nobody could tell how to switch a project or a
campaign, change a seat, or try another room without finding the
dashboard. The panel now has four tabs — Next (the deck, with a campaign
FOCUS above the card), Campaigns (numbers, focus, pause, done, edit, a
room to search under one, a new one from a name alone), Rooms (what is
watched and when it was read, rules to record, a room to try), Settings
(plan, key, seats, account, projects, this browser's Incognito standing) —
on one state route (`/api/panel`) and one act route (`/api/panel/act`,
JSON-only like the deck's). The deck stays the point: every tab's button
that starts work lands back on Next. Third, FREE IS THE DEFAULT. The plan
is `free` on a fresh install, the key card says a free key with no card
and links to where one is made, and the free menu was re-read against
OpenRouter's own list on 2026-09-06 (GLM 5.2's free variant is gone, so it
is gone from the menu). The README was cut to the idea in three paragraphs,
a picture (docs/how-it-works.svg), and a three-step install; the long form
moved whole to docs/reference.md.

**The return (2026-09-06).** The strategy the operator started with —
find the threads where people ask how to get clients and answer them —
saturated in a week: each such post gets a dozen generated answers on day
one. Two things follow, and neither is a new strategy. First, an opener is
not the product; the second and third replies are (lib/conversation.mjs
said so on day one and nothing acted on it). A CONVERSATION is now a row
of its own (`conversations.jsonl`, last write wins): opened the moment the
operator presses "I posted it", with the words as they edited them on the
card and not the writer's draft — so the campaign's "already said" memory
and the repeat guard hold what went up; bound to their own comment when
`sync` reads the profile (same thread, written after the post); read again
from the stranger's seat by the return half of `tick` (twelve hours
between looks, two weeks and it is cold); and dealt on the deck as a TURN
card before any new person, because a reply going cold costs more than a
missed post. The turn card is the reply card's twin — the exchange, the
draft in a field, Insert, "I posted it", Rewrite, "Let it go" — with no
judge (they are already talking to you) and no governor (a reply in a
thread you are in is not the shape that got anybody filtered). The writer
is handed the exchange and the conversation-stage rules that were written
in 0.5 and never reached. Second, the specialist has to manage several
campaigns at once without forgetting — so it does not remember. Tracking
is the engine's and deterministic; the CLOCK is the tick, computed from
cadence and `checked_at`, run from the deck's due card (or a person's
button), never remembered; and the specialist is reminded by one event,
`day.digest`, written into its inbox by the CLI at most once in twenty
hours or when replies land — numbers per campaign counted by the engine
(found, judged, fit, sent, replied, second turns, waiting, and CROWDING:
the median comment count a post already had when found, which is the
saturation signal the operator found by hand). On a digest its doctrine
asks three questions answered only with cards or silence: who is waiting
(already dealt — nothing to say), which campaign is saturated
(`propose_status`: one card, pause or finish it, one line of why), where
is the gap (`propose_campaign`: ONE new campaign aimed at a different
group of people or kind of post). A rewrite is a card too: Rewrite on a
reply or a turn deals a note card, and the note and the rejected draft go
to the writer as a critique that outranks everything but the refusals. A
campaign may carry a voice of its own, laid over the measured voice.
Verified live 2026-09-06 on the panel: Rewrite with a note produced a
draft that did what the note said; "I posted it" opened the conversation
with the edited words; a seeded reply dealt the turn card; the writer
answered the turn at the conversation stage. Not live-verifiable on this
machine: the return read itself (the stranger's seat is still not allowed
for the extension), so the row the return pass writes was seeded by hand
and the pass is covered by tests.

**Four questions, not fourteen tabs (2026-09-06).** The dashboard's nav
was the engine's table of contents. It is now the person's questions —
Today, People, Campaigns, You — and every older page still answers at its
old path under one of them. Today mirrors the deck's top card ("Next, on
the panel"), then who is waiting, what is due, who is worth answering, and
the campaigns' numbers; a person who only ever opens this page knows what
to do next. People gained "Waiting for you". Campaigns carries each
campaign's numbers and voice and a third status, done. You is a hub with
one line of state per page under it and the by-hand screens named as
Advanced — starting a colleague, watching a source, the hub pull — because
the specialist proposes all of that on the panel. The setup banner points
at the panel, where the onboarding walk already is. Nothing was built for
this; it was regrouping, renaming and deleting.

**The heart carries no platform word (2026-09-04).** The debt recorded
under "Platforms grow by extraction" is paid: `lib/cards.mjs` and the
dashboard take their labels from the adapter (`labels`: the account
question, the room's name, its rules page, the platform's own button, where
appeals go) with plain-English fallbacks, the Insert flow takes the
composer's words off the reply card (`composer`), a permalink's id and kind
are the adapter's to say (`idOf`, `itemOf`), and `lib/rules.mjs` no
longer knows Reddit's parody suffix or rules URL. The CLI names no platform
either: every verb goes through the active adapter. A test reads the card
module and fails on the word.

**A colleague is a markdown file (2026-09-03).** `skills/<id>/agent.md` —
frontmatter `name`, `description`, `tools`, `model`; body the prompt — is
the agent seat in markdown, beside the SKILL.md that teaches it. Both rings,
same registry, same slot rules. `agent.mjs` remains for a colleague that
needs tools written in code. No separate `agents/` folder: the knowledge and
the one who uses it live in one folder.

**One input primitive: a question list, dealt as cards (2026-09-03).**
Onboarding is a quiz — nine habits, a proof-read, a first room — and the quiz
is not special. Any agent that needs something from the person hands the deck
a list of questions; the deck deals them one card at a time and returns the
answers together. A worker's captcha, a room's missing rules line, a choice
among three drafts, the CMO's "which of these first?" are the same primitive
with one or many questions. The card kinds already exist in `lib/cards.mjs`;
what is new is the tool that hands a list over, and it is the same tool in
the CMO and in every worker. Build the tool once, and onboarding becomes its
first caller rather than its own machinery.

**AGENTS.md is the sixth memory file, and the only one the model writes
(2026-09-03).** The five stay the operator's: propose, never save. AGENTS.md
is the CMO's own notebook — standing instructions, what it learned about this
brand and this operator — in the Deep Agents convention, loaded into its
prompt and mounted read-write.

**The hosted app is the shell; the engine is the package (2026-09-03,
revising "the hosted twin").** Auth, extension pairing, profiles, projects
and Stripe already exist in messaging.quest (Projects/messaging-quest, the
Next.js + Supabase repo). The engine is consumed there as the
`messaging-quest` package — the way `agent/` already consumes it — with the
store over Postgres and the seat's base URL on the metered proxy. The merge
is the last milestone, after the local CMO is the thing people recommend to
each other. The website's first job is tracing: the inbox mirrored as events,
one table. Checkpoints, page bodies, screenshots and drafts never leave the
machine.

**Platform two arrives as a scout, not an adapter (2026-09-03, refining
"platforms grow by extraction").** The adapter contract is for feeds. A scout
reads a platform in the user's own session with the toolkit, and its contract
is the agent.md shape. LinkedIn is a stub definition until it is measured;
Reddit stays the only scout built.

## Done

- 0.1–0.2: listener, waiting-for-you, find, drafts, the gate; dashboard;
  models on OpenRouter with measured defaults; hub + pull federation.
- 0.3.0: zero-dep model layer; platforms-as-skills with local override dir;
  `mq platforms`; MCP server (7 tools, 4 memory resources); OpenClaw skill;
  LICENSE (canonical ELv2); loader + schema-check tests; `--port 0`.
- 2026-08-31: market check researched and recorded
  (research/market-2026-08-31.md).
- 0.4.0 (2026-09-01): the specialist. The deck (`lib/cards.mjs` +
  `/api/cards`) — card-based onboarding (account → url → nine voice habits
  while the scout reads → proof-read of the proposal → probe → watch) and
  work cards (rules, judge, reply with the gate's reason on the button). The
  Chrome extension (side panel = the deck; insert-never-submit into Reddit's
  composer; per-site permission inside the click). `/panel/` — the same deck
  served by the dashboard. The strategist on Deep Agents (`agent/`,
  `npm run brain`, `/api/agent`) with the CLI as its hands and SKILL.md as
  its education. 161 engine tests + the voice suite, green.
- 0.4.x (2026-09-01, same day): the browser read lane — `lib/relay.mjs`
  broker + `/api/relay/*` + the extension as reader; finding reads fall back
  to the user's own session when the anonymous lane refuses; the
  visibility-verbs-stay-anonymous doctrine pinned by a test that counts the
  call sites. 179 engine tests green.
- 2026-09-01, published: branch pushed, PR #1 merged green, CI live (engine
  jobs with NO install step on Ubuntu 18/22 + Windows 22; brain job installs
  agent/ and imports the strategist keyless). CI's first run caught its
  first real bug — the /api/agent empty-message answer sat behind the lazy
  brain import, invisible on every machine that had agent/ installed.
- 2026-09-01, the foundation for a community: the brand (Messaging Quest,
  `mq`, `.mq/` with rename migration), the skill registry (rings, slots,
  skills.json), three seats behind three doors (adapter / page / agent), the
  Skills screen + `mq skills`, live re-resolution on choice,
  CONTRIBUTING.md + skills/_template/ + the rewritten skills/README.md.
  224 engine tests + 31 voice, green.
- 2026-09-01, free and local, and the voice: three plans for the seats with
  the free menu measured (judge on every free model that takes a tool call;
  scout and writer on the best two) and the local lane wired against a stub
  and honestly unmeasured; the Settings screen and `mq models`; the
  register in the writer's rules and the template-phrase flag on `--save`;
  the 404 finding surfaced from the read ledger on every empty screen; the
  queue's backlog said out loud; the strategist told to quote counts, never
  tally; the dashboard and panel in the brand's own tokens. 259 engine tests
  + 34 voice, green.

- 2026-09-03, designed: the CMO — a runtime around the strategist, workers
  on their own threads in leased tabs, approvals as cards, interrupts only
  in workers, the control lane beside the read lane, colleagues as
  `skills/<id>/agent.md`, one question-list primitive for every human
  input. Recorded as decisions above and as milestone 1 below.
- 0.5.0 (2026-09-03), built — milestone 1 in the four ordered steps. **The
  control lane**: `lib/control.mjs` (leases, the toolkit screened by grant,
  navigations paced per site, `adopt` after a restart) + `/api/control/*` on
  the relay's long-poll + `extension/control.js` (the toolkit on
  `chrome.scripting`, `chrome.debugger` for the hands, tab groups) +
  `extension/screen.js` (the click screen, a superset of the insert screen,
  pinned by a test) + `bin/control-smoke.mjs`. Verified on the fixture and on
  a live Reddit search page (106 shadow roots walked; "Add a comment",
  "Reply", "Upvote" and a form's submit refused in-page; a label read through
  nested shadow roots — the first version missed Reddit's icon buttons).
  **Workers**: `agent/tasks.mjs` on the SQLite checkpointer
  (`agent/threads.mjs`, shared with the CMO's thread), `inbox.jsonl`, the
  question list backed by `interrupt()`, a running-time deadline, cancel,
  `agent.md` in the registry, the template colleague, the Tasks page and the
  `task.ask` / `task.done` / `task.failed` cards. Verified live from the
  dashboard on the paid scout seat: started, read through the lane, paused on
  its question, the panel dealt it with the screenshot, answered, resumed,
  reported; killed mid-run and resumed from its checkpoint on restart. **The
  CMO**: `propose_tasks`, `ask_person` (dealt, never an interrupt), `tasks`,
  `answer_task`, `cancel_task`, `inbox`, `notify`, the notebook
  (`read_notebook` / `write_notebook` on `.mq/AGENTS.md`, the sixth memory
  file on the Memory page), read-only browser tools on a per-turn lease,
  inbox delivery when idle, one turn at a time per directory. Answered a live
  question about its colleagues and tasks correctly without starting
  anything. **The scout**: `skills/reddit/agent.md` + `mq found` +
  `record_findings` / `judge_pending` / `write_draft` (the judge and writer
  SEATS do the judging and writing; the CLI records). 337 engine tests + 37
  runtime + 34 voice, green. Two things learned while building: Deep Agents'
  skills middleware lists SKILL.md paths the agent's file tools cannot reach
  (two wasted calls on the first live run), so SKILL.md is now INLINED into
  every agent's prompt; and the 6s per-site pace on the control lane is a
  human-browsing guess, written as one — the first measurement replaces it.
  Reloaded from this tree by the operator on 2026-09-04: lease, tab group,
  broker refusal, debugger screenshot and release passed live; reads waited
  on the reddit.com grant. The grant ask now outlives the lease that hit
  the wall (it vanished with the smoke test's tab before).
- 0.10.0 (2026-09-08), built — the engine inside the extension, and the
  account. lib/fs.mjs the one filesystem door (lib/node.mjs, lib/fs-memory.mjs
  the hosts; sha256 checked against node:crypto, paths against POSIX);
  lib/verbs.mjs the CLI's bodies as a factory, bin/mq.mjs argv/usage/stdin;
  lib/jobs.mjs start() (a verb in-process with the job's log); lib/engine.mjs
  the deck, the jobs, the panel's tabs, the broker and one route table out of
  bin/serve.mjs (the dashboard keeps the views); lib/browse.mjs takes a lane
  object (laneOf(broker)); nothing in lib/ loads at import. manifest.json at
  the repo root; extension/engine.js boots the engine on the memory host
  (extension/disk.js: IndexedDB, every change as it happens; the built-in
  skills out of the package; skills/index.mjs hands the adapters in
  statically); sw.js hosts it, two modes (hosted/local), the panel over
  messages or fetch; extension/account.js: Supabase directly — the code
  sign-in, the site's connect (externally connectable), mq_files mirrored
  last-writer-wins, the key never. The site (theic/messaging.quest, branch
  claude/one-account): the mq_files migration, POST /api/ext/session (a
  one-time token hash for the signed-in user), /link rewritten, /files as
  the signed-in home, the old extension backend removed. Verified in
  Chrome for Testing with the repo loaded unpacked (the worker boots, the
  panel deals from it, IndexedDB holds the files, a probe reaches the grant
  wall). Tests: 572 engine, 34 voice, 37 runtime.
- 0.9.2 (2026-09-07), built — one Chrome profile at a time on the lane.
  lib/control.mjs: `claim(wait, instance)` binds a lease to the instance
  that ran its first job and hands its jobs to that instance only; a job
  that opens a tab goes to the owner — the instance whose panel was seen
  last (`panelSeen`, fed by `/api/cards?instance=`), else the first
  poller; an instance silent for 90 s is dropped, `act` on its lease fails
  at once and `release` does not wait; `instances()`, `owner()`.
  extension/control.js `instanceId()` (chrome.storage.session) on every
  poll; sw.js answers `{type: "instance"}`; sidepanel.js sends it on the
  deck poll, and the strip warns when `control.instances > 1`. Found on
  the 0.9.1 retest: the extension in two profiles, every probe "that tab is
  gone" within a second. Tests: the two-profile block in bin/test.mjs.
  README: a TL;DR at the top — the install in five steps, with the free
  OpenRouter key and "in one Chrome profile"; the old Install section is
  now "What free means here".
- 0.9.1 (2026-09-07), built — where a reply lands, the strip, the judge by
  itself. INSERT: extension/insert.js composerState takes the elements that
  hold a comment and the card's target; a typable box wearing an opener's
  label is the opener (Reddit's collapsed "Join the conversation" textarea,
  measured); the composer's own buttons and the search field are never
  candidates; the box reports how many characters it holds, and
  control.js insertDraft reads it back after Input.insertText, falls back
  to a real Ctrl+V (⌘V with the Paste command on a Mac) when the panel had
  put the draft on the clipboard, answers `not_taken` honestly, and looks a
  few times for a composer that mounts late. Verified live against a Reddit
  thread with nine comments: target post → the "Join the conversation" box
  and never a Reply; target comment → the first comment's Reply; a real
  click on the box mounts the 44-pixel editor the finder then picks, with
  the composer's Cancel and Comment beside it screened out. THE STRIP:
  sidepanel.html #status in the header, on every tab; /api/cards carries
  `recent` (finished within ten minutes) and jobs with startedAt/done/total;
  the panel names its own work; a clock ticks while anything runs; the card
  is redrawn only when it changed, so the idle poll (15 s; 2.5 s while
  anything runs) never wipes an edit. THE JUDGE: serve.mjs autoJudge every
  ten seconds under five conditions; DRAFTING/LAST per project feed
  `judging`, `judgeFailed`, `drafting`, `draftFailed` into the snapshot;
  work.judge.wait / work.draft.wait / work.turn.wait cards; the act
  handlers return the runner's refusal; jobs.mjs keeps a job's closing
  sentence as its note. THE ROOT OF "Write the draft is not always
  working": OpenRouter retired minimax/minimax-m2.7:free the same day (404
  "This model is unavailable for free"), the free scout and writer — and a
  model-level fallback does not cover an id that 404s, so every draft
  failed, silently until the strip. Nemotron 3 Super 120B fills both seats
  (the next measured free run), the retired id is out of the menu, and a
  writing measurement is owed. Live: a round of three drafts on the new
  seat in under a minute, with the strip's clock and the card's "Writing…"
  in view. The CMO's client (agent/strategist.mjs) now reads OpenRouter's
  200-with-an-error-body the way lib/llm.mjs does ("Upstream error from
  Nvidia: Service temporarily overloaded" killed a turn with a TypeError)
  and sends the seat's fallback list. 512 engine + 34 voice + 37 runtime
  tests green; the Insert flow end to end needs the extension and was not
  run here.
- 0.9.0 (2026-09-07), built — publish-ready. DEAD CODE: every export
  counted against every file; six uncalled functions deleted, twenty-one
  needless exports dropped, the relay wording gone; no dead CSS class. THE
  TYPE: extension/card.css and lib/ui.mjs on one scale — nothing under
  12px, the panel's body 15px and its drafts 15px/1.55, no pixel face in
  running text, the dashboard's nav, tags and table heads in bold small
  sans, td/th allowed to wrap so no page scrolls sideways. THE PANEL: the
  questions people typically ask under the card (extension/suggest.js, pure,
  from the panel's state: what next, who is waiting, why this person, how
  the focused campaign is going, what campaign next / propose the first,
  what is my brand about, which room next, plus Try a room / The campaigns);
  the answer box with the question in bold, bold and bullets rendered as
  text nodes, "a new card is on the deck above" / "behind the one on
  screen", a line after twenty seconds that a writing turn takes a minute
  or two; `brain` on /api/cards, `contacted` on /api/panel. THE
  SPECIALIST: the deck (each card's kind, its actual button, whether the
  drafts are written, the on-screen card's tab texts) and the engine's
  numbers in front of EVERY turn (agent/strategist.mjs deckPreface), the
  deck tool kept for a second look; doctrine lines on buttons, counts, no
  terminal, plain text; `mq waiting` names the tracked conversations. THE
  WRITER: an unfilled me.md is empty to it, DISCLOSED_RULES say whose X is,
  lib/guards.mjs `theirs` and the THEIRS flag on the round, in the CLI and
  on the card's tab. THE QUESTION RUN (2026-09-07, the served panel, the
  free plan, minimax-m2.7 in the scout seat, fifteen turns at 30–60s each):
  brand in two sentences, right; what next — named the reply, offered to
  draft what was drafted, invented an "Accept" button (fixed by the
  preface); why this person — wrong before the preface ("the drafts can't
  be written yet"), right after (fit, three tabs, picks Ask back and says
  why); how is Launch posts going — every number matched the panel; what
  campaign next — the walk dealt ("Honest outreach", r/Entrepreneur) and
  the answer said so; brand in three lines, right; which room next — a
  probe card for r/saas, dealt behind the walk (the panel now says where);
  who is waiting — right count, wrong name (the verb now names them);
  refused: post it for me, one message for twenty threads (named the
  repeat guard), a DM against the house rules (quoted the room's rule),
  switching projects (the panel's); exact counts — "0 sent" carried over
  from an earlier turn, then right with the numbers in the preface
  (contacted 1, fit 8); make the deeper draft shorter — 216s, ran the
  writer and relayed the flags honestly, and the round it wrote claimed "i
  built doctick" to DocTick's author, which is the guard above. 504 engine
  + 34 voice + 37 runtime tests green. Not verified: the extension's own
  side panel (the served panel is the same files).
- 0.8.0 (2026-09-06), built — three drafts, four tabs, free by default.
  `lib/writing.mjs` STYLES + draftsBlock (straight, deeper, ask back — the
  same block in `mq draft` and the on-page prompt); `lib/agents.mjs`
  draftReply → {drafts, no_fit}, three held to shape with a second ask for
  what is missing; `mq draft --save` takes a JSON round or plain text
  ("yours"), one row per round with `drafts`, `round`, `note`, `style`,
  per-draft flags; `--note … --style <id>`; the guards read every tab. The
  deck: `tabs` on the reply and turn cards (lib/cards.mjs draftTabs, flags
  in words per tab), the note card naming the tab, the walk from a name
  alone, probe cards for a room tried from the panel, the quiet card under
  a focus. The server: `tab` on an act, `style` on marks and turns,
  campaign focus in the snapshot, `/api/panel` + `/api/panel/act`, the
  person page showing all three. The panel: card.js tabs with per-tab
  edits; sidepanel.html/js the four tabs, the project picker in the header,
  the focus line, badges; card.css for all of it. Free by default
  (lib/models.mjs DEFAULT_PLAN, KEY_URL, PLANS ordered free first, GLM 5.2
  free dropped), the key card and Settings say so. README cut to three
  paragraphs + docs/how-it-works.svg + install; the long form in
  docs/reference.md. Tests: the styles and the block, the writer held to
  three on a stub, the CLI round (flags per tab, the note, the repeat guard
  across tabs, the odd inputs), the deck's tabs, the panel's routes and
  every button's refusal, a project made and switched from the panel.
  THE FRESH-USER RUN (2026-09-06, a moved-aside .mq, the free plan, the
  operator's own Chrome): the account, the site, nine voice answers, the
  three files, r/smallbusiness probed for "how do I get clients" (7 read,
  judged 3 fit in 29s on the free judge), rules recorded, the first person
  drafted three ways by the free writer (80s), tabs switched with edits
  kept, Rewrite from the Deeper tab with a note (a shorter round in 25s),
  Insert → confirm → "I posted it" from the Ask back tab (the mark and the
  conversation carry `ask`), the room watched, the welcome, the CMO's first
  proposal within a minute, a campaign walked from a name on the Campaigns
  tab and its room probed under it (7 read, 5 fit), the focus, pause/edit,
  the Rooms tab's two-step stop, the Settings refusals and plan switch, a
  project made and switched back. What it found and what was fixed: the
  scout, refused on the site (no grant yet), wandered to example.com and a
  Google search and proposed three files from nothing — it is now held to
  the site's own host and refuses to propose when no page of it opened;
  the free writer's line breaks arrived as "n", "|n" and "|" across three
  rounds — the seam is mended on the writer's output (never on a person's
  words); Watch pressed dealt the room question for the second the job took
  — the probe now stays on the stash marked `watching` and deals a wait; a
  source's found-count compared the lowercased id to the probe's tag as
  typed; the panel's sections stacked because a display rule beat the
  hidden attribute. Not verified here: Chrome's own grant prompt for a new
  site (a person's click), the stranger's seat (Incognito not allowed on
  this machine), and the extension's own side panel (the served panel is
  the same files).
- 0.7.0 (2026-09-06), built — the return, and four questions.
  `lib/conversations.mjs` (conversations.jsonl: open on "I posted it" with
  the words as edited; bind on sync; recordReturn from the stranger's seat;
  waiting/due/unbound; campaignDigest with crowding; digestText).
  `mq waiting`; `mq tick` runs the return pass after the sources and
  writes `day.digest` and `reply.waiting` into the specialist's inbox
  (the CLI writes the same file the runtime reads); `mq draft` at the
  conversation stage with the exchange, `--note` for a rewrite, `turn` on
  drafts; crowding (`comments`) on found rows and in the judge's material.
  The deck: work.turn before any new person, work.rewrite, work.due (the
  clock), campaign.status (the specialist's proposal), Rewrite on the reply
  card. The CMO: REACT_TO reply.waiting/day.digest/campaign.status, the
  three-question digest ask, `propose_status`, `waiting`, numbers on the
  campaign line, the return doctrine; propose_campaign takes a voice.
  Campaigns: `## Voice`, status done. The dashboard: NAV = Today, People,
  Campaigns, You; Today (the next card, waiting, due, the queue, the
  numbers); You (a hub, Advanced named); People "Waiting for you";
  Campaigns numbers + voice + Mark done; Standing at /standing; older
  pages highlight under their question; the banner points at the panel.
  The panel passes the posted text. 442 engine tests + 37 runtime tests
  green; live on the panel: Rewrite with a note → a draft that obeyed it;
  "I posted it" → the conversation with the edited words; a seeded reply →
  the turn card → the writer's turn-2 draft; the due card → a tick in the
  browser. Not live: the return read (Incognito still not allowed here).
- 0.6.0 (2026-09-04), built — projects, campaigns, one browser, no platform
  word in the heart. `lib/projects.mjs` + `lib/dirs.mjs` (the root is the
  default project; children under projects/<id>/; the key, the seats, the
  contacted ledger and the local ring shared; one runtime per project in the
  server; the panel's picker, /projects, `mq projects`/`project new|use`).
  `lib/campaigns.mjs` (campaigns/<id>.md with idea/fit/never and
  mention never|disclosed; writerBlock with what was already said; judgeLine;
  campaign on found/probes/sources/verdicts/drafts; `mq campaigns`,
  `campaign show|pause|resume`, /campaigns, the CMO's `propose_campaign`
  and the five-card walk with a field for the operator's words on every
  choice card; DISCLOSED_RULES in lib/writing.mjs). The one lane:
  `lib/browse.mjs` over the control lane (MQ_SERVER), `read_dom` in the
  extension (declared specs, `a|b` fallbacks, `attrs` for measuring), the
  stranger seat (Incognito, `incognito_not_allowed` refused in words), tabs
  fronted before every read, relay + feed transport deleted, the site scout
  in the browser, sync/check/back/probe/tick rewritten on pages
  (skills/reddit/pages.mjs, shapes measured live 2026-09-04). 401 engine
  tests + 37 runtime tests green; fixture and Reddit smoke green with
  read_dom; live: probe → 7 posts with bodies; the CMO's campaign → panel
  walk → probe under it → judge (7, 4 fit) → watch under it → a disclosed
  draft with the claims guard firing. Not live-verified, of record: the
  stranger seat (Incognito not yet allowed on the machine) and Insert with
  the composer words off the card (the real side panel only).
- 0.5.2 (2026-09-04), built — milestone 1's "done when" run, live: a fresh
  `.mq/` onboarded from the panel (account, the site read off
  play.messaging.quest, nine voice cards, three proof-read files, room,
  phrase, probe, judge, rules, watch, welcome); the CMO dealt "Search
  r/sideproject for 'where do I find clients'?"; Start it ran the reddit
  scout in a tab of the machine's window — reads only, no click, no refusal —
  7 posts on the page, 4 new, 3 judged fit, 3 drafts in the voice, tab
  closed; the deck led with the reply card and Insert. Two things had to be
  built for it to close: the welcome card now says `setup.done` into the
  inbox and the CMO's inbox delivery asks for the first proposal in so many
  words (before that it read the files and answered "noted"); and the deck's
  watch step looped — `mq watch` refuses a room whose rules nobody recorded,
  the job said ok, the deck went back to the room card — so the probed room
  is on the rooms list and its rules card is dealt first, the watch handler
  refuses with a message for an unanswered or forbidden room, and the watch
  carries the probed phrase. Read on the way: r/SaaS's rule 11 bans outreach
  and lead-detection tools outright (recorded no); r/SideProject exists for
  sharing your own project (recorded yes). Left standing, of record: the
  deck's probe and tick still read Reddit through the engine's own read path
  (a fetch from Node, or the relay's background GET), not the human browser —
  the decision on retiring that is the operator's; the scout read the search
  page only, so the judge saw titles without bodies; the proposal rides
  second behind a judged draft card, so the side panel shows the person
  first; the strategist sits in the scout seat and once emitted a broken
  tool call instead of proposing.
- 0.5.1 (2026-09-04), built — the browser behaves like a person (the
  decision above, in full). `extension/control.js` rewritten around trusted
  input: one debugger session per worked tab (idle a minute, dropped on
  release), a mouse that travels and rests, wheel-tick scrolling and
  scroll_to by the wheel, typing key by key, a think-pause before every job,
  Enter/Space through the click screen and ctrl+Enter refused outright,
  `form_input` by click-select-type, the console reader on the Log domain,
  `front()` asking the page whether it is drawn before any input and raising
  the machine's window when not, `find` naming a control from its inner
  text with read_page's roles; the smoke's Reddit pass opens a result with
  a real click on its title and has the thread's own "Comment" button
  refused in the page (both passes green, 2026-09-04).
  `extension/insert.js` reads only (finds the composer or its opener);
  `insertDraft` in control.js does the human's insert through the service
  worker, the one debugger owner. `bin/control-smoke.mjs` gained a fixture
  pass: a page served from the script itself that tallies every event and
  whether it was trusted, so the tally is the proof — plus the Reddit pass.
  `/api/control/reload` asks the extension to reload itself after a pull.
  The broker's per-site pace is uneven (paceMs plus up to 80%). Left: the
  live fixture and Reddit passes with the reloaded extension, then the
  "done when" run.

**0.11.0 — one book, no platform in the furniture, the browser answers for
you.** Three surfaces (the website, the panel, the local dashboard) now share
`extension/tokens.css` — the palette, the type and both themes, one file whose
copy in the website's repo is checked byte for byte by a digest pinned in both
suites (`docs/design.md`). No rule on any surface names a colour any more; the
panel and the dashboard carry no literal at all, and `--on-lime` exists so the
one colour dark must not invert cannot be. The three faces ship with the
extension (68 KB, SIL OFL) and the dashboard serves them, so the brand draws
offline and nothing is fetched. The logo is the site's Q, one 512px file, and
the toolbar sizes are its downscales. The panel gained System/Light/Dark
(`extension/theme.js`, before first paint, this browser only). Platform words
left the furniture: the panel's placeholders, the room forms and the account
question are the adapter's (`labelsOf`, plus a new `bare()` that undoes
whatever `roomLabel` decorates a room with), an instance can prefer one active
platform over another (`preferred()`, the stash's `platform`), and the page
toolkit stopped knowing two custom-element prefixes by name — a hyphen in a
tag is the web platform's own definition of a component. And the browser now
answers for you: an adapter may declare `account.cookies` (presence only,
optional `cookies` permission, asked on a press) so the panel can say which
platforms this browser is signed into, and `account.whoami` — an address that
redirects to your own profile — so `mq me` with no argument reads the handle
off the URL bar instead of your memory. Left: a live whoami against a
signed-in Reddit (the redirect is measured off Reddit's documented behaviour,
not off a run here).

## Next, in order

1. **The CMO, v1 — milestone 1.** The brief is the next section. Built
   2026-09-03 and its "done when" run passed 2026-09-04 (see Done, 0.5.2): a
   fresh `.mq/` onboarded from the panel, the CMO's first proposal the Reddit
   search, the search in a tab of the machine's window, the result as a reply
   card with a draft in the voice. Insert and Reddit's button were left to the
   human, which is the point. What the run left standing is recorded there.
2. **Live with it.** A week on a real project through the panel: the
   onboarding the CMO ran, the searches it proposed, three replies through
   insert and Reddit's own button, "I posted it" recorded through the gate.
   Everything below gates on this testimony.
3. **Publish.** The repo is public and CI is green; left: the npm name, the
   Web Store listing (the predecessor's submission kit is written), the open
   OpenClaw skill aimed at the occupied slot.
4. **Events out.** `inbox.jsonl` mirrored to one Supabase table under a
   device token, read by the website as a trace per task. The first hosted
   feature, and only a mirror.
5. **Telegram relay.** The same cards over a bot. With the question-list
   primitive this is a transport, nothing more.
6. **Receipts + usability.** Refusal receipts designed to share; an
   `add <permalink>` card; hub per-token scoping when multi-client is real.
7. **Platform two, as a scout.** LinkedIn or HN — measured first, then
   `agent.md` + `SKILL.md`, nothing in the engine.
8. **GEO skill.** The checks ledger: cited / not cited / could not ask,
   dated, no score.
9. **Merge into messaging-quest — the final milestone.** Built 2026-09-08
   as 0.10.0, the other way round from how this line first read: not the
   engine as a package the app imports with the store over Postgres, but
   the engine inside the extension with the files mirrored to one table —
   no local server, no server of ours reading anything. What is left of
   this item: the store listing (the package is `git archive`), the
   extension id on the site (`NEXT_PUBLIC_MQ_EXTENSION_ID`), the seat's base
   URL on a metered proxy as the paid plan, and a later migration that
   drops the old extension's tables once nobody reads them.

## Milestone 1, for the next agent

You are building a colleague, not a control panel. Read README.md, this
file, skills/README.md, then `agent/strategist.mjs`, `lib/cards.mjs`,
`lib/browse.mjs` and `extension/insert.js` — those four files are what you
extend. The predecessor's browser bridge (Projects/messaging-quest-monitoring,
`extension/sw.js` and `src/bridge.ts`) is prior art for keeping a service
worker alive and for who may open the socket; read it before writing the
extension side.

**What done looks like.** Open the panel on a fresh `.mq/`. The CMO runs
onboarding as a quiz and reads your site in a tab. It then deals one card:
"Search Reddit for people asking about this?" You approve. A tab opens
under a "Messaging Quest" group; you go do something else. Later the panel
says "3 threads worth answering", then the reply card with the draft. You
press insert, then Reddit's button. If the scout hits a wall, the panel shows
the screenshot and the tab, you deal with it, and the scout continues.

**Build in this order. Each step is testable before the next exists.**

1. *The control lane.* The extension learns the toolkit below, on tabs it
   opened in a tab group; the server gets one new lane next to the relay,
   on the same long-poll transport (no WebSocket server: the heart stays
   zero-dependency). Test with a script, no agent: lease a tab, open a
   Reddit search, print what was read, try to click "Comment" — the tab
   opens in your own window and the click is refused by the extension.
2. *Workers.* In `agent/`: the task manager — threads on a SQLite
   checkpointer, the inbox file, leases, the question-list tool backed by
   `interrupt()`, a deadline, cancel. The registry learns `agent.md` beside
   `agent.mjs`. Ship a template agent that asks before its second page so
   the pause can be tested on purpose. Test from the dashboard: start a
   task, watch its tab and its log, answer its card, kill the server
   mid-task, start it again, and see the task continue.
3. *The CMO.* The strategist gains `propose_tasks`, the question-list
   tool, `answer_task`, `cancel_task`, `notify`, inbox delivery when idle,
   AGENTS.md, and the read-only browser tools. Onboarding becomes the CMO
   calling the question-list tool with the cards that already exist. Test
   the whole thing as described under "what done looks like".
4. *The scout.* `skills/reddit/agent.md`: search in the user's own session,
   posts before comments (the lab measured 3.9×), findings judged by the
   engine's judge verb, drafts from the writer, never a click. Then step
   into milestone 2 and live with it.

**The browser toolkit, like Claude's.** Same names, same conventions, so
the model's habits transfer: `tabs_context`, `tabs_create`, `tabs_close`,
`navigate` (url, back, forward), `computer` with actions screenshot,
left_click, right_click, double_click, type, key, scroll, scroll_to, hover,
zoom, wait, `read_page` returning an accessibility tree whose interactive
nodes carry `ref_N`, `find` returning refs for a query, `form_input` by ref,
`get_page_text`, `read_console_messages`, `read_network_requests`, and a
`batch` that runs a list of these in one round trip. Clicks take a ref or a
coordinate from the most recent screenshot. Use the primitives Chrome already
has: `chrome.scripting` for the tree, find, text, forms and scrolling;
`chrome.debugger` for screenshots, mouse and keys, attached only while a task
needs them (Chrome shows a yellow bar while attached — the Reddit scout never
needs it); `tabs` and `tabGroups` for leases. No JavaScript-eval tool in this
milestone. The runtime injects the tab id from the lease; a worker never
chooses a tab. Every action is checked against the agent's `tools:` line in
the runtime and, for clicks, against the label screen in the extension.

**Reuse, do not rebuild.** The deck and its stash (`lib/cards.mjs`) are the
whole HITL surface — add card kinds only if a question genuinely has no
shape there. The control lane's long-poll is the transport. The insert
screen is the click screen. The job runner (`lib/jobs.mjs`) already reports progress to
the panel; the task manager is its sibling for threads. The seats
(`lib/models.mjs`) give every agent its model; do not add a second way. Deep
Agents' own middleware — todos, filesystem, skills, summarization — is the
context management; do not write another. The strategist's `propose` is the
ancestor of `propose_tasks`; extend it.

**The UX bar — better than a general assistant, concretely.** One card at a
time, always. A proposal is a worked answer with the reason on it, never a
question that makes you invent vocabulary. You can watch the tab it opened,
and closing the task closes the tab. Silence means it is working; the log is
one click away. When it needs you, the card carries the screenshot and names
the tab. When it is done you get the count and one next action, not a
report. Every no says why, in the words of the rule that said it. The flow
never dead-ends: no key, no site, a failed read — every state has a card
with a door in it. The CMO reads the deck before advising, so its words and
the card on screen never disagree.

**Do not.** Add a dependency to `lib/`, `bin/` or `skills/`. Add a second
agent framework. Create an `agents/` folder. Grant click or type to any
agent. Put a number on a person or a room. Run a read inside a chat turn.
Interrupt the CMO's thread. Rebuild onboarding — wrap what exists. Write a
memory file other than AGENTS.md from a model.

**Ask the operator when** a decision above would have to bend to make
something work — and say which one.

## What is deliberately not built

No machine submission of any kind — no auto-post mode, no "aged account"
pools, no one-click publish; the extension may type into the composer, and
the click that submits is a human's, on the platform's own button, forever
(the July 2026 crackdown wiped the competitors built the other way, and it
is also simply the position). No invented scores, 0–100 or otherwise. No dependence on the official Reddit Data API. No engagement
metrics, no telemetry, no CORS on the hub, no key requirement for anything
that only reads, and no per-seat pricing of the local tool. No click or type granted to any agent
by default, no worker that a card did not start, no interrupt on the CMO's
thread, no memory file written by a model other than AGENTS.md, no second
way to read a platform (no fetch of a page anywhere: the operator's browser
is the one lane, and the stranger's view is an Incognito tab or a refusal),
no undisclosed mention in any campaign, no template — a campaign is a
direction and the repeat guard runs regardless — no turn drafted by the
specialist (the writer writes it, the operator posts it), and no reply
tracked in a model's memory (the store tracks it; the digest reminds). Each of
these is a decision with a paragraph behind it somewhere in the source; the
source wins.
