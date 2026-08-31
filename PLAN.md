# The plan

earshot wants to be the open engine under SaaS marketing — the way OpenClaw
became the standard for local assistants — and this file records what that
means in decisions, so the next contributor argues with reasons rather than
with archaeology. The market picture behind the newest decisions is measured,
dated and sourced in [research/market-2026-08-31.md](research/market-2026-08-31.md).

## North star

The go-to marketing tool for solo and vibecoded SaaS founders: it holds the
brand's memory, listens where their buyers talk, drafts in the founder's own
voice, checks what search and AI engines say about them — all local, all
refusable, and a human sends everything. Milestone 1 is still, deliberately,
a Reddit reply tool done properly.

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

## The shape (as of 0.3.0)

```
core        lib/ — the store, the pacing governor, the probe economics, the
            burst limits, the memory files, the model seats. Knows no platform.
skills      skills/<id>/ — a platform is a SKILL.md + adapter.mjs. Reddit is
            the first and deliberately the only one. Local skills load from
            .earshot/skills/ without forking. Contract: skills/README.md.
surfaces    the dashboard (humans, port 8787, localhost only)
            the CLI (scripts, cron, OpenClaw — one implementation of every verb)
            the MCP server (Claude/ChatGPT/any MCP host — bin/mcp.mjs)
            the hub feed (other machines — bin/hub.mjs, the only outward port)
memory      four markdown files the human owns. The model proposes; a person
            presses Save. rule.md's hash rides on every verdict.
```

**Zero runtime dependencies.** The model layer is `lib/llm.mjs` — fetch, a
JSON-schema check, a tool loop. `npm install` installs nothing. This is a
feature with a name on the box: the whole tool is auditable in one sitting,
and there is no supply chain between a user and their own prospect list.

## Decisions of record

**Not built on OpenClaw.** OpenClaw is an assistant *host*, not a library —
the correct relationship is that an OpenClaw agent drives earshot, which
`integrations/openclaw/SKILL.md` and the MCP server both provide. What earshot
takes from OpenClaw is the *pattern* that made it a standard: local-first, one
job owned completely, markdown memory, skills as folders, nothing to install.

**Not built on Hermes.** A model family plus a harness tuned for it. earshot
is model-agnostic through OpenRouter on principle — any model can occupy a
seat by id, including a Hermes model. The chassis must not belong to a vendor.

**Deep Agents removed (was: 0.2.0's model layer).** We used one tool-loop and
three structured calls from three frameworks. The md-file memory it is famous
for was always ours — the files, the seeds, the human-presses-Save rule.
`lib/llm.mjs` header records what was kept (forced-tool-call structured
output, model fallbacks, timeout + one retry) and what it costs to add a
framework back. Re-adopt it the day a seat needs unbounded steps, hours of
held state, or subagents; no seat does.

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

## Next, in order

1. **Live with it.** Real username, watched sources, a week of ticks, three
   replies that landed. Everything below gates on this testimony.
2. **Platform-risk work.** Measure the private feed token; add the two MCP
   record tools (`record_room_rules`, `record_prospect`) so an assistant's
   own browser is the first supervised browser lane; keep the RSS-ceiling
   facts current in skills/reddit.
3. **Publish.** Public repo, npm name claimed, CI badge on the 137 tests,
   and the open OpenClaw/ClawHub skill aimed at the occupied slot.
4. **Receipts + usability.** Refusal receipts designed to share; toasts; an
   `add <permalink>` form.
5. **Hub scoping** — per-token source lists, once multi-client use is real.
6. **Platform #2** — feed-friendly (HN via hnrss), so the contract extraction
   is about the contract.
7. **GEO skill** — the checks ledger described above.
8. **Hosted twin** — last, priced $19–49, after the local tool is the thing
   people recommend to each other.

## What is deliberately not built

No posting of any kind — no auto-post mode, no "aged account" pools, no
one-click publish (the July 2026 crackdown wiped the competitors built that
way, and it is also simply the position). No invented scores, 0–100 or
otherwise. No dependence on the official Reddit Data API. No engagement
metrics, no telemetry, no CORS on the hub, no key requirement for anything
that only reads, and no per-seat pricing of the local tool. Each of these is
a decision with a paragraph behind it somewhere in the source; the source
wins.
