# The plan

earshot wants to be the open engine under SaaS marketing — the way OpenClaw
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
local, all refusable, and a human sends everything. Milestone 1 is still,
deliberately, a Reddit reply tool done properly: onboarding, reading, and
posting without shadowbans.

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
            burst limits, the memory files, the model seats, and the DECK
            (lib/cards.mjs: state → the one next action, deterministically).
            Knows no platform. Zero dependencies, non-arguable.
skills      skills/<id>/ — a platform is a SKILL.md + adapter.mjs. Reddit is
            the first and deliberately the only one. Local skills load from
            .earshot/skills/ without forking. Contract: skills/README.md.
brain       agent/ — the strategist, on Deep Agents. The ONE directory that
            carries dependencies, behind one lazy import; everything else
            runs without it being installed (`npm run brain` turns it on).
            Its tools are the CLI's verbs; its skills are skills/<id>/SKILL.md.
surfaces    the Chrome extension (primary: the deck in a side panel, and the
            only surface that can type a draft into Reddit's real composer)
            the dashboard (the back office: stats, prospects, memory, models —
            and /panel/, the same deck served as a page)
            the CLI (scripts, cron, OpenClaw — one implementation of every verb)
            the MCP server (Claude/ChatGPT/any MCP host — bin/mcp.mjs)
            the hub feed (other machines — bin/hub.mjs, the only outward port)
memory      four markdown files the human owns. The model proposes; a person
            presses Save. rule.md's hash rides on every verdict.
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
the correct relationship is that an OpenClaw agent drives earshot, which
`integrations/openclaw/SKILL.md` and the MCP server both provide. What earshot
takes from OpenClaw is the *pattern* that made it a standard: local-first, one
job owned completely, markdown memory, skills as folders, nothing to install.

**Not built on Hermes.** A model family plus a harness tuned for it. earshot
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
demonstrable: refusal receipts and `es ready` are product surface, built to
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

## Done

- 0.1–0.2: listener, waiting-for-you, find, drafts, the gate; dashboard;
  models on OpenRouter with measured defaults; hub + pull federation.
- 0.3.0: zero-dep model layer; platforms-as-skills with local override dir;
  `es platforms`; MCP server (7 tools, 4 memory resources); OpenClaw skill;
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

## Next, in order

1. **Live with it, through the panel.** Load the unpacked extension, run the
   card onboarding end to end on a real project, a week of ticks, three
   replies that landed via insert → Reddit's button → "I posted it".
   Everything below gates on this testimony.
2. **The browser read lane — BUILT 2026-09-01, one measurement left.** The
   relay landed as engine plumbing rather than an adapter declaration (a
   simpler shape than the "transport: browser" flag this item first
   imagined): `lib/relay.mjs` brokers GET-only jobs in the dashboard server,
   the extension claims and answers them in the user's session (panel
   long-polls, service-worker alarm catches up), and `fetchAnon` falls back
   to the lane — for tick and probe only, a count a test pins — when the
   anonymous read comes back 403/429/blocked. Same pace, same three-outcome
   parsing, `via: "browser"` in the ledger. Still to do from this item:
   measure Reddit's account-bound private feed token as a finding fallback.
3. **The specialist grows up — persona and deck-sight landed 2026-09-01.**
   `persona.md` is the fifth memory file (optional: usable unedited, listed
   in the editor, out of the setup count, and reaching ONLY the strategist's
   seat — a judge with a personality is rubric drift, and a test pins the
   boundary). The strategist gained a `deck` tool: it reads the same cards
   the panel shows before advising, so its advice and the card on screen
   cannot disagree. Verified live: asked "what is on my panel?", it named
   the actual card, explained why answering it unblocks drafting, and
   flagged two fit-passing queue items it would skip on etiquette grounds.
   Proposals-as-cards landed the same day: a `propose` tool whose verbs come
   from an allowlist parsed in the zero-dep heart (`proposable()` — judge,
   tick, sync, draft <id>, probe <room> [phrase]; mark and watch are
   deliberately NOT on it), rendered as a card that rides second on the deck
   — behind the system's own top action, visible during onboarding too — and
   re-parsed by the server from its own stash at act time, so the card can
   never do more than its label says. This also resolves the "no reading
   verbs from chat" tension cleanly: the agent cannot run a probe, but it
   can deal a card offering one; the click stays the operator's and the
   server runs it on its own clock. Verified live: asked for a suggestion,
   it proposed drafting the freshest fit, and the card appeared at deck
   position 1 in its own words. Still open: named parallel research tasks.
4. **Publish.** Public repo, npm name claimed, CI badge on the tests, the
   Web Store listing (the predecessor's submission kit is written), and the
   open OpenClaw/ClawHub skill aimed at the occupied slot.
5. **Telegram relay.** The same cards over a bot: HITL from a phone, deep
   links back into the dashboard. The card JSON was shaped for this.
6. **Receipts + usability.** Refusal receipts designed to share; an
   `add <permalink>` card; hub per-token scoping when multi-client is real.
7. **Platform #2** — feed-friendly (HN via hnrss), so the contract extraction
   is about the contract.
8. **GEO skill** — the checks ledger described above.
9. **Hosted twin** — last, priced $19–49, after the local tool is the thing
   people recommend to each other.

## What is deliberately not built

No machine submission of any kind — no auto-post mode, no "aged account"
pools, no one-click publish; the extension may type into the composer, and
the click that submits is a human's, on the platform's own button, forever
(the July 2026 crackdown wiped the competitors built the other way, and it
is also simply the position). No invented scores, 0–100 or otherwise. No dependence on the official Reddit Data API. No engagement
metrics, no telemetry, no CORS on the hub, no key requirement for anything
that only reads, and no per-seat pricing of the local tool. Each of these is
a decision with a paragraph behind it somewhere in the source; the source
wins.
