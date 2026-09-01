# Contributing

The common directory is `skills/`. A contribution is a folder there — a
platform, a dashboard screen, a colleague for the strategist, or plain
knowledge — and the whole mechanism is described in
[skills/README.md](skills/README.md). Two implementations of the same purpose
are welcome to coexist: declare the same `provides:` slot and the person
running the tool picks which one runs. You are not competing for a single
blessed spot.

## The five-minute path

1. Copy `skills/_template/` into your data dir as `.mq/skills/<your-id>/`
   (no leading underscore), delete the seat files you don't need.
2. Edit. Reload the dashboard — your skill is live on the **Skills** screen,
   your page is in the nav, `mq skills` lists it.
3. When it works, move the folder into the repo's `skills/` and open a pull
   request.

Nothing else to set up: the engine runs on bare Node 18 and `npm install`
installs nothing. Run the tests the same way CI does:

```bash
node bin/test.mjs
node --test bin/voice-test.mjs
```

## What a review checks

This repo's position is that the foundation must be non-arguable, so the bar
is about honesty more than style:

- **Skills carry no dependencies.** A skill is bare Node and may import from
  `lib/`. The one dependency-carrying directory is `agent/`, and skills don't
  live there. (An agent seat is still bare Node — the strategist adapts it.)
- **Measured claims carry dates.** A pace, a rate, a limit — say when and how
  it was measured. A number without a date is a guess wearing a suit.
- **A skill ships its refusals or it ships nothing.** Name what your skill
  will not do and why, in SKILL.md, and enforce it in code where the engine
  lets you. A platform folder with no stated refusals and no measured pace is
  a spam cannon with a manifest.
- **Nothing submits.** There is no code in this repo that posts, votes,
  messages, or writes to any platform, and no contribution adds the first.
  Drafts are typed into real composers by the extension at most — the click
  is always the operator's.
- **Escape what strangers wrote.** Anything platform-sourced that your page
  renders goes through `esc()` — the dashboard has a test that feeds it an
  `<img onerror>` payload, and your screen is part of that promise.
- **Tests for what would break quietly.** Loud breaks announce themselves;
  add checks for the failure that would keep working and start lying.

## Core changes

If your skill needs the engine to change, that is a contract gap — open it as
an issue or a separate PR against `lib/`, don't reach around the seam from
inside a skill. The contract grows by extraction from working skills, and a
second real platform is exactly the kind of PR that gets to reshape it.

## The other rings

You can ship a skill without touching this repo at all: any folder in
`.mq/skills/` loads locally, and on an id collision yours replaces the
built-in. The repo's `skills/` directory is for the version everybody gets.
