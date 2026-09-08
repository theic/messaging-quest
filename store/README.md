# The store kit

Everything the Chrome Web Store listing needs, in one folder. `listing.md`
holds the copy and every answer on the privacy tab; the images are here.

None of it ships in the extension: `.gitattributes` marks this folder
`export-ignore`, so `npm run pack` (`git archive`) leaves it out of the zip.

| File | Slot | Size |
| --- | --- | --- |
| `icon-128.png` | Store icon | 128 × 128 |
| `screenshots/1-next.png` | Screenshot | 1280 × 800 |
| `screenshots/2-drafts.png` | Screenshot | 1280 × 800 |
| `screenshots/3-rooms.png` | Screenshot | 1280 × 800 |
| `screenshots/4-accounts.png` | Screenshot | 1280 × 800 |
| `screenshots/5-never.png` | Screenshot | 1280 × 800 |
| `tile-440x280.png` | Small promo tile | 440 × 280 |
| `marquee-1400x560.png` | Marquee promo tile | 1400 × 560 |

## Where the pixels came from

**The mark** is `extension/icons/icon-512.png`, which is the website's
`public/brand-mark.png` — the same file, so the store icon, the toolbar icon
and the site's favicon are one image. `icon-128.png` here is a copy of the
extension's own 128.

**The panels in the screenshots are real.** Each one is a screenshot of the
actual side panel, drawn by the actual code from an actual data directory, at
420 × 900 on a 2× display, and then placed on a page in the design book
(`docs/design.md`) with a sentence beside it. Nothing in them is a mock-up of
an interface: what a reviewer sees is what the product draws.

**The content in them is a sample.** A made-up product (a small invoicing app)
in a made-up room, with a thread nobody wrote and a handle nobody owns —
because a screenshot of a real thread would publish somebody's post and a real
account's name to the store, which is not ours to do. The words are an example;
the interface around them is not.

## Remaking them

You need a Chrome for Testing binary (`npx @puppeteer/browsers install
chrome@stable --path <a short dir>` — a long path breaks its side-by-side
manifests on Windows) and a data directory with sample content in it.

1. Seed a scratch `.mq` — a project's four memory files, a measured voice, one
   campaign, two watched rooms, three found posts with verdicts, one of them
   with three drafts, and a few of your own comments checked visible so the
   room reads as *ready*. `bin/test.mjs` builds the same shapes around line
   1880 if you need the field names.
2. `MQ_DIR=<that dir> node bin/serve.mjs --port 8792`, and screenshot
   `http://127.0.0.1:8792/panel/` at 420 × 900, `deviceScaleFactor: 2`, with
   `Emulation.setEmulatedMedia` fixing `prefers-color-scheme` (the shots here
   are light; the panel is equally at home dark). Click a tab first for the
   ones that are not the deck.
3. Compose 1280 × 800 at `deviceScaleFactor: 1` — the store wants those exact
   pixels — over `extension/tokens.css` with the faces from
   `extension/fonts/`, panel image on the right at 352 × 668, `object-fit:
   cover` from the top.

The point of writing that down rather than committing a script: it runs about
once a release, it needs a browser this repo does not carry, and a script that
is run twice a year is a script that is broken when you need it.

## Then

Publishing is a person's job, not a pipeline's:

1. `npm test`
2. `npm run pack` → `messaging-quest-extension.zip`
3. Upload it, paste `listing.md`, attach these images.
4. Once it is live, set `NEXT_PUBLIC_MQ_STORE_URL` and
   `NEXT_PUBLIC_MQ_EXTENSION_ID` on the website's Vercel project and redeploy:
   the first turns the landing into an install page, the second is what lets
   **Connect this browser** on `/link` find the extension.
