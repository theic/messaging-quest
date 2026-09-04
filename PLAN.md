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
heart       lib/ — the store, the pacing governor, the probe economics, the
            burst limits, the memory files, the model seats (paid, free or
            local — one file, lib/models.mjs, nothing above it knows), the DECK
            (lib/cards.mjs: state → the one next action, deterministically).
            Knows no platform. Zero dependencies, non-arguable.
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
            from milestone 1 also the control lane — a browser toolkit like
            Claude in Chrome's, on tabs a task leased)
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
the measurement.

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
stays GET-only by construction and unchanged. The extension gains a second
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
(`extension/relay.js`, a GET in the user's session with no tab) is NOT the
agent's path and is the one remaining read that is not a tab — a decision
for the operator now that the scout reads searches in a real tab.

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
9. **Merge into messaging-quest — the final milestone.** The engine as the
   package the app imports; the store over Postgres; the seat's base URL on
   the metered proxy; the extension pairs with the website and points at
   either backend; the local dashboard narrows to runtime plus panel. Done
   when a signed-in user pairs a local runtime, runs the CMO, and reads the
   trace on messaging.quest. Not before 2 has happened.

## Milestone 1, for the next agent

You are building a colleague, not a control panel. Read README.md, this
file, skills/README.md, then `agent/strategist.mjs`, `lib/cards.mjs`,
`lib/relay.mjs` and `extension/insert.js` — those four files are what you
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
shape there. The relay's long-poll is the transport. The insert screen is
the click screen. The job runner (`lib/jobs.mjs`) already reports progress to
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
thread, and no memory file written by a model other than AGENTS.md. Each of
these is a decision with a paragraph behind it somewhere in the source; the
source wins.
