// Campaigns — a direction, never a template (0.6.0).
//
// The voice measured at onboarding is how the operator sounds. A campaign is
// what they are trying, this month, in this room: a tactical idea, an angle,
// a different disclosure rule for a different platform. It is a markdown file
// the operator owns — `<project>/campaigns/<id>.md` — that a model may
// PROPOSE (the CMO's propose_campaign deals it as cards) and only a person's
// Save writes, the same law as the five memory files.
//
// THE RULE THAT MAKES THIS A CAMPAIGN AND NOT A MAIL MERGE: the file holds
// instructions, not wording. "Say honestly that most replies they see are
// generated, that commenting where buyers ask is itself the answer, that you
// built a tool for exactly that and would like their feedback" is a direction
// the writer applies to one person at a time, in that person's terms, or
// leaves out where it does not fit. A template is what gets noticed — Reddit
// names "the same or similar comments across communities" as reportable
// spam, and the measured corpus this project inherited shared a 26-word run
// while its own duplicate check reported clean. So the writer is handed the
// direction AND the last few drafts written under it, told not to reuse a
// phrase, and `mq draft --save` runs the eight-word repeat guard over the
// result regardless (lib/guards.mjs). The guard is the enforcement; the
// prompt is the intent.
//
// The file:
//
//   ---
//   name: Honest comments under "finding clients"
//   platform: reddit
//   status: active            active | paused
//   mention: disclosed        never | disclosed — see MENTIONS
//   added: 2026-09-04T20:00:00Z
//   ---
//   # The idea
//   <the direction, in prose>
//   ## Who it fits
//   <optional: narrows rule.md for this campaign's findings>
//   ## Never
//   <optional: this campaign's own refusals>
//
// Sources, findings, verdicts and drafts carry `campaign: <id>` so the queue
// can say which idea brought a person in, and the writer knows which
// direction to apply. A finding without one is the project's general fit.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { frontmatter } from "./skills.mjs";

/** Whether a FIRST message may name what the operator built. The house rule
 *  is never (lib/writing.mjs, OPENER_RULES); a campaign may lift it to
 *  "disclosed" and nothing else — named once, plainly, as theirs. There is no
 *  undisclosed setting, and there will not be one. */
export const MENTIONS = {
  never: { label: "Help only — the house rule", note: "Nothing of yours is named, linked or hinted at until they write back." },
  disclosed: { label: "Disclosed, once", note: "Named plainly as yours — “i built X for this” — where it answers what they asked. No link unless they ask." },
};
export const STATUSES = ["active", "paused", "done"];

export const slug = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

const DIR = (dir) => join(dir, "campaigns");
const FILE = (dir, id) => join(DIR(dir), `${id}.md`);

/* ------------------------------------------------------------------ text */

/** The sections, by heading. Anything before the first heading is the idea. */
export function parseCampaign(text, id = "") {
  const fm = frontmatter(text);
  const body = String(text ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const parts = { idea: [], fit: [], never: [], voice: [] };
  let at = "idea";
  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) {
      const t = h[1].toLowerCase();
      at = /^the idea|^idea|^direction/.test(t) ? "idea" : /^who it fits|^who|^fit/.test(t) ? "fit" : /^never|^refus/.test(t) ? "never" : /^voice|^tone|^how it sounds/.test(t) ? "voice" : at;
      continue;
    }
    parts[at].push(line);
  }
  const clean = (ls) => ls.join("\n").replace(/^\s*\n+|\n+\s*$/g, "").trim();
  const c = {
    id: id || slug(fm.name),
    name: String(fm.name ?? id ?? "").trim().slice(0, 80),
    platform: String(fm.platform ?? "").trim().toLowerCase() || null,
    status: STATUSES.includes(String(fm.status ?? "").trim()) ? String(fm.status).trim() : "active",
    mention: MENTIONS[String(fm.mention ?? "").trim()] ? String(fm.mention).trim() : "never",
    added: fm.added ?? null,
    idea: clean(parts.idea), fit: clean(parts.fit), never: clean(parts.never), voice: clean(parts.voice),
  };
  c.hash = campaignHash(c);
  return c;
}

/** A rubric hash for the campaign's judging and writing instructions, so a
 *  verdict or a draft can say which version of the idea it was made under —
 *  the same answer rule.md's hash gives to "the queue changed: my rule or
 *  the model?". */
export const campaignHash = (c) =>
  createHash("sha256").update([c.mention ?? "never", c.idea ?? "", c.fit ?? "", c.never ?? "", c.voice ?? ""].join("\n\x00")).digest("hex").slice(0, 8);

export function campaignFile(c) {
  return [
    "---",
    `name: ${String(c.name ?? "").replace(/\r?\n/g, " ").trim()}`,
    `platform: ${c.platform ?? ""}`,
    `status: ${STATUSES.includes(c.status) ? c.status : "active"}`,
    `mention: ${MENTIONS[c.mention] ? c.mention : "never"}`,
    `added: ${c.added ?? new Date().toISOString()}`,
    "---",
    "",
    "# The idea",
    "",
    String(c.idea ?? "").trim(),
    "",
    "## Who it fits",
    "",
    String(c.fit ?? "").trim(),
    "",
    "## Never",
    "",
    String(c.never ?? "").trim(),
    "",
    ...(String(c.voice ?? "").trim() ? ["## Voice", "", String(c.voice).trim(), ""] : []),
  ].join("\n");
}

/* ----------------------------------------------------------------- files */

export function readCampaigns(dir) {
  if (!existsSync(DIR(dir))) return [];
  const out = [];
  for (const f of readdirSync(DIR(dir))) {
    if (!f.endsWith(".md")) continue;
    const id = basename(f, ".md");
    if (slug(id) !== id) continue;
    try { out.push({ ...parseCampaign(readFileSync(join(DIR(dir), f), "utf8"), id), path: join(DIR(dir), f) }); } catch { /* an unreadable file is not a campaign */ }
  }
  return out.sort((a, b) => String(a.added ?? "").localeCompare(String(b.added ?? "")));
}

export const readCampaign = (dir, id) => {
  const key = slug(id);
  return key && existsSync(FILE(dir, key)) ? { ...parseCampaign(readFileSync(FILE(dir, key), "utf8"), key), path: FILE(dir, key) } : null;
};

export const activeCampaigns = (dir) => readCampaigns(dir).filter((c) => c.status === "active");

/** Write one — from a person's Save, never from a model. Returns the record
 *  as read back, or {error}. */
export function writeCampaign(dir, c) {
  const id = slug(c.id || c.name);
  if (!id) return { error: "a campaign needs a name" };
  if (!String(c.idea ?? "").trim()) return { error: "a campaign needs an idea — the direction the writer applies" };
  const prior = readCampaign(dir, id);
  mkdirSync(DIR(dir), { recursive: true });
  writeFileSync(FILE(dir, id), campaignFile({ ...c, id, added: c.added ?? prior?.added ?? new Date().toISOString() }).replace(/\r\n/g, "\n"));
  return readCampaign(dir, id);
}

export function setCampaignStatus(dir, id, status) {
  const c = readCampaign(dir, id);
  if (!c) return { error: `no campaign "${id}"` };
  if (!STATUSES.includes(status)) return { error: `not a status: ${status}` };
  return writeCampaign(dir, { ...c, status });
}

/* --------------------------------------------------------------- prompts */

/** What the WRITER is handed for a person found under a campaign: the
 *  direction, the refusals, and the last few drafts written under it — so
 *  "in your own words" is checkable, not hoped for. */
export function writerBlock(c, { said = [] } = {}) {
  if (!c) return "";
  const lines = [
    `THE CAMPAIGN — “${c.name}”. This is a DIRECTION, never a script: apply it to THIS person, in their terms and your own words, only where it answers what they wrote, and leave it out where it does not. It changes what you say, not how you sound — the voice rules above still hold, and so does every refusal.`,
    "",
    c.idea,
  ];
  if (c.never) lines.push("", `What this campaign never does:`, c.never);
  if (c.voice) lines.push("", `How it sounds under this campaign — a tone laid over the measured voice, which still wins on anything it names:`, c.voice);
  const priors = said.filter((s) => String(s ?? "").trim()).slice(-3);
  if (priors.length) {
    lines.push("", `Already said under this campaign, to other people. Do NOT reuse a phrase, an opening or a structure from these — a run of eight identical words is flagged when the draft is saved, and Reddit names the same comment across threads as reportable spam:`);
    priors.forEach((s, i) => lines.push(`--- earlier ${i + 1} ---`, String(s).trim().slice(0, 700)));
  }
  return lines.join("\n");
}

/** What the JUDGE is told, per item, when the finding came in under a
 *  campaign with its own fit clause. One line; rule.md still decides. */
export const judgeLine = (c) => (c?.fit ? `Campaign “${c.name}” — this post reached the queue through it, and the campaign narrows the fit: ${c.fit.replace(/\s+/g, " ").trim()}` : "");

/** A proposal's shape on the deck: what the CMO (or the dashboard's form)
 *  may put in the stash for the cards to walk through. Lengths capped here so
 *  a model cannot flood a card. */
export function campaignDraft(input = {}) {
  const s = (v, n) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, n);
  const name = s(input.name, 80);
  return {
    name,
    id: slug(name),
    platform: s(input.platform, 20).toLowerCase() || null,
    idea: s(input.idea, 3000),
    fit: s(input.fit, 1200),
    never: s(input.never, 1200),
    voice: s(input.voice, 600),
    mention: MENTIONS[input.mention] ? input.mention : "never",
    place: s(input.place, 60).replace(/^\/?r\//i, "").replace(/[^\w-]/g, ""),
    q: s(input.q, 120),
    why: s(input.why, 400),
    at: new Date().toISOString(),
  };
}
