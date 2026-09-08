# The design book

Three surfaces wear this brand: the **website** (`theic/messaging.quest`, Next.js
on Vercel), the **extension's side panel** (this repo, in the store), and the
**local dashboard** (`mq serve`, this repo). They are three programs in two
repositories, and they have to look like one thing.

They do it with one file and one rule.

## The file

`extension/tokens.css` is the book. It declares the palette, the type stacks
and both themes on `:root`, and nothing else — no selector but `:root`, no
component, no font file, no path.

It is shared **by being the same bytes**. `app/tokens.css` in the website's
repo is a copy of it. There is no package to import: one repo ships to the
Chrome Web Store and the other deploys to Vercel, and a shared dependency
between them would be a third thing to release. So instead each side's test
suite pins the same SHA-256 of the file, and both fail the moment the copies
drift. Changing a colour is therefore one motion: edit both files, put the new
digest in both tests, and the two deploys go out with the same palette.

Who loads it:

| Surface | How |
| --- | --- |
| Website | `app/tokens.css`, imported by `app/globals.css` |
| Side panel | `<link>` in `extension/sidepanel.html` |
| Local dashboard | served at `/tokens.css` by `bin/serve.mjs`, linked by `lib/ui.mjs` |

## The rule

**A rule may not name a colour.** Every colour in `card.css`, in `lib/ui.mjs`
and in the website's `globals.css` is a `var(--token)`. A literal `#1d1c15` in
a rule is a rule that is light-mode-only forever, which is how a "dark theme"
becomes a screenshot rather than a feature. The suites check this: the
dashboard's stylesheet and the panel's carry no colour literal at all.

Two tokens exist purely to make that rule keepable:

- `--on-lime` — what is legible **on** the accent. Ink in *both* themes. It is
  the one token dark mode must not invert: `background:var(--lime);
  color:var(--ink)` reads perfectly on paper and is a near-white label on a
  lime button at night.
- `--ink-rgb` — the ink as three numbers, for a rule that wants ink at its own
  opacity. `rgba(29,28,21,.2)` written by hand is the same bug in another coat.

## The palette

Paper: an off-white ground with a printed grain, ink instead of black, one
loud lime that means *this is the thing to press*, coral for the bad number.
Square corners, a hard offset shadow, no gradients. Dark is the same book on a
screen — every name keeps its job and only its value moves.

| | Light | Dark |
| --- | --- | --- |
| `--paper` ground | `#e9e2cd` | `#0a0a0b` |
| `--card` raised | `#fbf7e8` | `#161618` |
| `--bg` inset field | `#fffdf2` | `#1d1d20` |
| `--ink` text, borders, shadows | `#1d1c15` | `#e8e6da` |
| `--soft` secondary text | `#5c594c` | `#9a9a94` |
| `--lime` the accent | `#c9ff2e` | `#c9ff2e` |
| `--lime-ink` lime as text | `#5d7a00` | `#c9ff2e` |
| `--coral-ink` the bad number | `#b3391f` | `#ff8a6f` |

## The themes

Both surfaces follow the operating system by default (`prefers-color-scheme`),
and the book carries a second copy of the dark values under
`:root[data-theme="dark"]` so a surface can override it.

Only the panel does. It sits *beside* a page all day, and a black panel next
to a white forum is a real reason to disagree with the system — so Settings
has System / Light / Dark. The choice lives in this browser's `localStorage`
(`extension/theme.js`, loaded first in the head so nothing flashes) and does
not sync: it is about the screen in front of you, not about the account.

The website has no toggle. It follows the system, and that is the whole
feature there.

## The type

Three faces, all SIL OFL:

- **Bricolage Grotesque** (`--disp`) — headings, buttons, the wordmark. 800.
- **Atkinson Hyperlegible** (`--sans`) — everything read as prose.
- **Press Start 2P** (`--px`) — the pixel eyebrow, small and rare.
- `--mono` is the system's monospace: numbers, ids, timestamps.

The website loads them through `next/font`; the extension carries them in
`extension/fonts/` (68 KB of latin subsets, the same files) and declares them
in `extension/fonts.css`; the dashboard serves those same files from
`/fonts.css`. **Nothing is fetched from a CDN anywhere.** A store extension
that pulled a font off the network would be making a request per panel open,
from the browser of somebody who was told the tool does not talk to anyone.

Sizes: nothing under 12px, body at 15px in the panel and 16px on the
dashboard. A side panel is read at arm's length beside a page, and the drafts
on it are the thing the operator reads most carefully.

## The mark

One file: a lime **Q** on a near-black rounded tile. `public/brand-mark.png`
on the website (its favicon, its app icons, the wordmark beside the nav) and
`extension/icons/icon-512.png` here — the same 512px image, byte for byte.
The extension's 128/48/32/16 are downscales of it; 32 and 16 are cropped
tighter to the glyph first, because a favicon-sized letter needs the margin
back.

The tile is black in both themes. It is a logo, not a surface: it should look
the same in a light toolbar, a dark toolbar, a store listing and a browser
tab, and a mark that restyles itself per theme is two marks.

## Adding a colour

1. Add it to `extension/tokens.css` — in all three blocks (light, the
   `prefers-color-scheme` dark, the `[data-theme="dark"]` dark).
2. Copy the whole file to `app/tokens.css` in the website's repo.
3. Run both suites, take the two new digests they print, pin them.
4. Ship both.

If that feels like too much ceremony for a colour: that is the point. There
are four of them and they have not changed since the day they were measured.
