# The Chrome Web Store listing

Everything the developer dashboard asks for, written down so the answers are
the same every time and so a change here is a change with a diff. Copy the
fields; the images are beside this file (`README.md` says where each goes and
how they were made).

**Nothing here may say more than the product does.** A store listing is the
one piece of writing a reviewer checks against the code, and the two claims
this product lives on — *it never posts for you* and *it does not talk to
anyone but the model you chose* — are the two a listing is most tempted to
round off. They are not rounded off below.

---

## Name

```
Messaging Quest
```

## Summary (132 characters max)

```
Finds the public threads where you can honestly help, and has the reply drafted in your voice. You press Post. It never does.
```

*(123 characters.)*

## Category

**Workflow & Planning.** Not "Social & Communication": it does not communicate.
It reads, judges and drafts, and a person does the communicating.

## Language

English (United Kingdom).

---

## Detailed description

```
Messaging Quest is a marketing colleague that lives in your browser.

You tell it once what you sell. It watches the forums where people ask for
exactly that, throws away almost everything, and hands you the few threads
worth answering — each with a reply already written in your own voice, three
ways. You read it, change what you want, and press the site's own button.

IT NEVER POSTS. Not as a setting, not as a "pro" mode, not by accident. The
extension can put a draft into the site's comment box for you; the click that
publishes is yours, on the site's own button, always. There is no code in it
that submits anything.

── HOW IT WORKS ──────────────────────────────────────────

1. TELL IT WHAT YOU SELL. Paste your site's address. It reads the page in a
   tab of your own browser and proposes three short files — what you sell, who
   it is for, and the rule that decides who is worth answering. You correct
   them; nothing saves itself.

2. IT LEARNS HOW YOU WRITE. Nine one-tap questions and a look at things you
   have already written. Lower case or capitals, long or short, do you use
   em dashes. The drafts come back sounding like you rather than like a
   chatbot being helpful.

3. IT READS THE ROOMS. In tabs of your own browser, at a person's pace, on
   pages you can watch it open. Nothing is fetched behind your back and no
   page is ever modified.

4. TWO GATES THROW MOST OF IT AWAY. A judge scores every thread against your
   rule and the room's own rules. What survives is a handful a day, not a
   feed.

5. THE REPLY IS ALREADY WRITTEN. Three drafts: the straight answer, the
   deeper one, and one that asks a question back. Guards check them before
   you see them — no invented links, no claim your own notes do not support,
   no phrase reused from something you posted elsewhere.

6. YOU PRESS POST. It opens the thread, puts the draft in the box, and stops.

── WHAT IT COSTS ─────────────────────────────────────────

Free to run. The models are free ones on OpenRouter — get a key at
openrouter.ai/keys, no card. Nothing in the extension is charged, metered or
upsold, and the whole engine runs inside the extension: there is no server of
ours to pay for and none to be down.

An optional free account at messaging.quest syncs your files — what you sell,
your voice, your campaigns — to another browser. The extension works fully
without one.

── WHERE IT LOOKS ────────────────────────────────────────

Reddit today. Where it looks is a plug-in "skill": a folder describing one
site's pages, its rooms and its comment box. Nothing in the engine or the
panel knows a site by name, so the next ones — Hacker News, LinkedIn, a niche
forum — are a skill each, not a rewrite. The extension is open source; the
contract for writing one is in the repository.

── WHAT IT DOES NOT DO ───────────────────────────────────

• It does not post, submit, send, upvote, follow or message anyone.
• It does not modify the pages it reads. It reads them the way you would.
• It does not use a site's API, a scraper, a proxy or a server farm — only
  the browser you are sitting in front of, at a pace a person could keep.
• It has no telemetry. We cannot see your rooms, your drafts or your replies.
• It does not sell anything to anyone, ever, in any form.

── WHAT LEAVES YOUR BROWSER ──────────────────────────────

Two things, both because you asked for them:

• The text of a thread and your own notes go to the model provider you chose
  (OpenRouter by default, or a model running on your own machine, which sends
  nothing anywhere) so the judge can score it and the writer can draft. Your
  key, your account, your choice of model.
• If you sign in, your own files sync to your own account at messaging.quest.
  Your OpenRouter key never does — it stays in the browser you typed it into.

Nothing else. No analytics, no crash reports, no "anonymous usage data".

── OPEN SOURCE ───────────────────────────────────────────

github.com/theic/messaging-quest — the whole engine, the skill contract, and
the reasoning behind every refusal above.
```

---

## Privacy tab

### Single purpose

```
Messaging Quest helps one person find public forum threads where they can
usefully reply, and drafts that reply in their own writing style for them to
review and post themselves. Everything it does serves that: reading the pages
the user chooses in the user's own tabs, scoring them against the user's own
rule, drafting, and placing a draft in the site's comment box for the user to
edit and submit.
```

### Permission justifications

| Permission | Why |
| --- | --- |
| `sidePanel` | The whole interface is the side panel: the card, the drafts, the settings. There is no other UI. |
| `storage` | Remembers which engine the panel talks to, the sign-in session, and the panel's own settings. |
| `alarms` | One alarm a minute asks the engine how many cards are waiting so the toolbar badge can say so, and keeps the extension's own loop alive after the browser has idled it. |
| `scripting` | Reads the page the user opened — the post, its comments, and whether the site's comment box is on screen. Reading only; the page is never modified. |
| `tabs` | Opens the tab a read happens in, knows when it has finished loading, and brings it to the front so the user can watch. |
| `tabGroups` | Puts those tabs in one visibly named group, so a tab this extension opened is never mistaken for one the user opened. |
| `clipboardWrite` | Copies a draft to the clipboard, so the user can paste it themselves when a site's editor will not take an insert — and so the draft is never lost. |
| `debugger` | **Input has to be real.** Every click, scroll and keystroke this extension makes is dispatched through the DevTools protocol, which is the only way an extension can produce input the browser marks as trusted — the same thing a person's mouse produces. Synthetic events would be both a lie to the site and exactly the fingerprint automated abuse leaves. The debugger is attached only to a tab this extension itself opened for a read the user asked for, only while that read is running, and it is detached after. It is never used to submit anything. |
| `cookies` (optional) | Asked for on a press, never at install. Used to tell the user which of the sites they watch this browser is signed into, by asking Chrome whether a session cookie exists. Presence only — no cookie's value is read, stored or sent, and nothing is requested from the network. |
| `host_permissions: http://127.0.0.1/*` | Optional local mode: the same panel talking to an engine the user runs on their own machine instead of the one inside the extension. Localhost only. |
| `optional_host_permissions: https://*/*` | The sites the user chooses to watch, granted one site at a time, on a prompt, when a read first needs it. Nothing is granted at install. |
| `incognito: spanning` | Reading the user's *own* public profile the way a logged-out stranger sees it — which is the only way to find out that a post was quietly removed — requires a signed-out window. The user has to allow Incognito for the extension themselves; until they do, that read is refused rather than answered from the wrong seat. |

### Remote code

**No.** All code is in the package. Nothing is `eval`'d, no script is loaded
from a remote host, no font or stylesheet is fetched. The extension makes
network requests for *data* only: to the model provider the user configured
(OpenRouter by default) and, when the user signs in, to messaging.quest.

### Data usage

Collected and transferred, both only as the feature requires:

- **Personally identifiable information — email address.** Only if the user
  chooses to create an account, and only to messaging.quest, to sync their own
  files between their own browsers.
- **User-generated content and website content.** The text of a thread the
  user asked to be read, plus the user's own notes and drafts, are sent to the
  model provider the user configured, so that the judge can score the thread
  and the writer can draft a reply. A user who points the extension at a model
  on their own machine sends nothing anywhere.
- **Authentication information.** The user's API key and their account session
  are stored in the browser. The API key is deliberately excluded from account
  sync: it never leaves the browser it was typed into.

Certifications:

- ☑ Not being sold to third parties, outside of approved use cases.
- ☑ Not being used or transferred for purposes unrelated to the item's single
  purpose.
- ☑ Not being used or transferred to determine creditworthiness or for lending
  purposes.

### Privacy policy URL

```
https://messaging.quest/privacy
```

---

## Images

| Slot | File | Size |
| --- | --- | --- |
| Store icon | `icon-128.png` | 128 × 128 |
| Screenshot 1 | `screenshots/1-next.png` | 1280 × 800 |
| Screenshot 2 | `screenshots/2-drafts.png` | 1280 × 800 |
| Screenshot 3 | `screenshots/3-rooms.png` | 1280 × 800 |
| Screenshot 4 | `screenshots/4-accounts.png` | 1280 × 800 |
| Screenshot 5 | `screenshots/5-never.png` | 1280 × 800 |
| Small promo tile | `tile-440x280.png` | 440 × 280 |
| Marquee promo tile | `marquee-1400x560.png` | 1400 × 560 |

## Before you submit

1. `npm test` — the suite includes the manifest and the design book.
2. `npm run pack` — writes `messaging-quest-extension.zip` from the committed
   tree (`git archive`), so what is uploaded is what is tagged.
3. Upload the zip, paste the fields above, attach the images.
4. After it is published, set on Vercel and redeploy:
   `NEXT_PUBLIC_MQ_STORE_URL` (turns the landing into the install page) and
   `NEXT_PUBLIC_MQ_EXTENSION_ID` (what lets **Connect this browser** on
   /link find the extension).
