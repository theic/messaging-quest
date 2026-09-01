---
name: your-skill-id
description: One honest sentence. Every agent reads this line to decide whether your skill is relevant to the task in front of it.
provides: page:example
---

<!-- The folder name and `name:` should match. Delete the `provides:` line if
     this skill is pure knowledge; keep it when the skill fills a slot that a
     competing implementation might also fill (platform:<id>, page:<name>,
     agent:<name> are the conventions in use).

     To develop: copy this folder into <data-dir>/skills/ (default
     .mq/skills/), remove the leading underscore, edit, reload the dashboard.
     Folders starting with "_" are skipped by discovery, which is why this
     template can ship inside the repo without running.

     To ship it to everybody: a pull request that adds your folder to
     skills/. CONTRIBUTING.md is the checklist the review will use. -->

# What this is

Write for two readers at once: the person deciding whether to trust your
skill, and the agent that will act on what you say. Same file, same bytes.

## The facts that shape everything

Measured claims, each with its date. A number without a date is a guess
wearing a suit. If your skill reads a platform, the pace you claim here is
the pace your adapter enforces.

## What this skill refuses, and why

A skill ships its refusals or it ships nothing. Name the shapes of work this
skill will not do, with the measurement or the platform's own sentence that
says why. These are the product's position, not a compliance garnish.
