// The engine's verbs as LangChain tools — the hands every agent in agent/
// shares. Extracted from the strategist so a worker (agent/tasks.mjs) picks
// the same tools by name that the CMO holds, and there is one implementation
// of each.
//
// Every action goes through the CLI (bin/mq.mjs): one implementation of every
// verb, shared with the dashboard's buttons and the MCP tools. The refusals,
// the governor and the rubric hash all live down there, which is exactly why.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readOne } from "../lib/memory.mjs";
import { store } from "../lib/store.mjs";
import { readCampaign, readCampaigns, judgeLine } from "../lib/campaigns.mjs";
import { labelsOf, platformFor } from "../lib/platform.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ES = join(ROOT, "bin", "mq.mjs");

/** Run one verb and hand back what it printed. Never rejects: to a model, a
 *  failed verb is a sentence to read, not an exception to lose the turn to. */
export const es = (dir, args, stdin = null) =>
  new Promise((resolvePromise) => {
    const child = execFile(process.execPath, [ES, ...args],
      { env: { ...process.env, MQ_DIR: dir }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolvePromise(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || (err ? String(err.message) : "done")));
    if (stdin !== null) child.stdin.end(stdin);
  });

/** The verbs, by name. `engineTools(dir)` seats all of them; a worker takes
 *  the subset its agent.md names. */
export const VERBS = {
  status: (dir) => tool(async () => es(dir, ["status"]), {
    name: "status",
    description: "What became of the operator's own comments, read as a logged-out stranger sees them: visible, filtered, removed, what changed.",
    schema: z.object({}),
  }),
  queue: (dir) => tool(async () => es(dir, ["queue", "--json"]), {
    name: "queue",
    description: "The people waiting for an answer — already judged fit, not yet handled. JSON rows with id, place, author, title, body, url.",
    schema: z.object({}),
  }),
  pending: (dir) => tool(async () => es(dir, ["pending"]), {
    name: "pending",
    description: "Items that still need a fit verdict, numbered, as JSON. You may judge them yourself against rule.md (read it with read_memory first), then call judge.",
    schema: z.object({}),
  }),
  judge: (dir) => tool(async ({ verdicts }) => es(dir, ["judge"], JSON.stringify(verdicts)), {
    name: "judge",
    description: "Record fit verdicts for pending items. Judge against the operator's rule.md and NOTHING else; when you cannot tell, the rule says answer yes.",
    schema: z.object({
      verdicts: z.array(z.object({
        n: z.number().describe("Item number from pending"),
        fit: z.boolean(),
        why: z.string().describe("One sentence, quoting their words where you can"),
      })),
    }),
  }),
  draft_material: (dir) => tool(async ({ id }) => es(dir, ["draft", id]), {
    name: "draft_material",
    description: "Everything needed to answer one person: what they said, the operator's measured voice rules, the room's risks, what they can honestly claim. Write the reply FROM this — never invent a first-person claim it does not contain — then call save_draft.",
    schema: z.object({ id: z.string().describe("Item id from queue, e.g. t3_abc123") }),
  }),
  save_draft: (dir) => tool(async ({ id, text }) => es(dir, ["draft", id, "--save"], text), {
    name: "save_draft",
    description: "Save a reply draft for an item. The engine runs its refusals over it (repeated phrasing, unsupported claims, invented links) and reports any flags — surface those to the operator rather than hiding them. The draft lands on their card; THEY post it.",
    schema: z.object({ id: z.string(), text: z.string() }),
  }),
  mark: (dir) => tool(async ({ id, mark }) => es(dir, ["mark", id, mark]), {
    name: "mark",
    description: "Record what the operator did with a queue item: sent (they posted it themselves) or skip. Only mark sent when the operator SAYS they posted — the CLI's gate still fires and may refuse; relay its reason. Undoing lives on the dashboard's Prospects page.",
    schema: z.object({ id: z.string(), mark: z.enum(["sent", "skip"]) }),
  }),
  rooms: (dir) => tool(async () => es(dir, ["rooms"]), {
    name: "rooms",
    description: "Every room known so far: probed, watched, its recorded rules answer, and standing where there is any.",
    schema: z.object({}),
  }),
  campaigns: (dir) => tool(async () => {
    const all = readCampaigns(dir);
    if (!all.length) return "no campaigns yet — the operator's general fit rule applies to everything found";
    return JSON.stringify(all.map((c) => ({ id: c.id, name: c.name, status: c.status, mention: c.mention, platform: c.platform, idea: c.idea, fit: c.fit, never: c.never })));
  }, {
    name: "campaigns",
    description: "This project's campaigns (lib/campaigns.mjs): each a direction the writer applies — an idea, who it fits, what it never does, whether a first message may name what the operator built (disclosed only). Findings, drafts and sources carry the campaign they came in under.",
    schema: z.object({}),
  }),
  read_memory: (dir) => tool(async ({ file }) => {
    const m = readOne(dir, file);
    return m ? m.body : `not a memory file: ${file}`;
  }, {
    name: "read_memory",
    description: "Read one of the memory files verbatim: rule.md, project.md, icp.md, me.md, persona.md. You may not write them — propose text and tell the operator where it goes.",
    schema: z.object({ file: z.enum(["rule.md", "project.md", "icp.md", "me.md", "persona.md"]) }),
  }),

  /* ---- the scout's verbs (skills/reddit/agent.md). Findings go through
     `mq found`; judging and drafting use the engine's OWN seats — the judge
     against rule.md, the writer from the same material `mq draft` assembles —
     and land through the CLI, which stamps the rubric hash and runs the
     refusals. The colleague orchestrates; it does not judge or write itself. */
  record_findings: (dir) => tool(async ({ place, q, url, items, campaign }) => es(dir, ["found"], JSON.stringify({ place, q: q ?? null, url, items, campaign: campaign ?? null })), {
    name: "record_findings",
    description: "Record the posts you read on a search or listing page in the operator's browser — one call per page. Each item: url (the post's own permalink), title, author (the name if shown), body (the visible text, up to 1200 characters), posted_at only if the page shows a real date. Pass the campaign id your brief names, so the judge and the writer apply its direction. The store drops duplicates and refuses parody rooms and rooms whose rules forbid promotion — the answer says which. New posts wait for the judge.",
    schema: z.object({
      place: z.string().describe("The room, without the platform's prefix (saas, not r/saas)"),
      q: z.string().nullable().optional().describe("The search phrase, or null for a plain listing"),
      url: z.string().optional().describe("The page these came off"),
      campaign: z.string().nullable().optional().describe("The campaign id from your brief, if any"),
      items: z.array(z.object({
        url: z.string(),
        title: z.string().optional(),
        author: z.string().nullable().optional(),
        body: z.string().optional(),
        posted_at: z.string().nullable().optional(),
      })).min(1).max(100),
    }),
  }),
  judge_pending: (dir) => tool(async () => {
    const S = store(dir);
    const pend = S.pending();
    if (!pend.length) return "nothing pending — record findings first";
    const all = S.found();
    const L = labelsOf(platformFor(pend.map((x) => all.get(x.id)?.url).find(Boolean)) ?? undefined);
    const items = pend.map((x) => {
      const it = all.get(x.id) ?? {};
      const c = it.campaign ? readCampaign(dir, it.campaign) : null;
      return { n: x.n, place: it.place, room: L.room(it.place), author: it.author, title: it.title, body: it.body, campaign: c ? judgeLine(c) : "" };
    });
    const { judgeItems } = await import("../lib/agents.mjs");
    const rule = readFileSync(join(dir, "rule.md"), "utf8");
    const verdicts = await judgeItems(dir, items, rule, {});
    if (!verdicts.length) return `no verdicts came back — ${verdicts.failed?.[0] ?? "the judge wrote nothing"}. The items stay pending.`;
    const out = await es(dir, ["judge"], JSON.stringify(verdicts));
    return `${verdicts.length} judged by the judge seat, ${verdicts.filter((v) => v.fit).length} fit.\n${out}`;
  }, {
    name: "judge_pending",
    description: "Have the engine's JUDGE seat judge everything pending against rule.md — and a campaign's own fit clause where the finding came in under one — five at a time, and record the verdicts through the CLI (rubric hash stamped, pending cleared, the room's fit rate settled). Returns the counts. You do not judge these yourself.",
    schema: z.object({}),
  }),
  waiting: (dir) => tool(async () => es(dir, ["waiting"]), {
    name: "waiting",
    description: "Who wrote back and is waiting on the operator: the conversations this machine tracks (opened on 'I posted it', bound to their own comment by a profile read, updated by the return pass), oldest first, with what they said and what the operator said. The deck already deals these before any new person — you do not draft the turn; write_draft on the person's id does, at the conversation stage.",
    schema: z.object({}),
  }),
  write_draft: (dir) => tool(async ({ id }) => {
    const prompt = await es(dir, ["draft", id]);
    if (!/voice|reply|draft/i.test(prompt) || /^no such|not in the queue|usage:/im.test(prompt)) return prompt;
    const { draftReply } = await import("../lib/agents.mjs");
    const { drafts, no_fit } = await draftReply(dir, prompt, {});
    if (!drafts.length) return no_fit ? `the writer declined: ${no_fit}` : "nothing came back from the writer";
    const saved = await es(dir, ["draft", id, "--save"], JSON.stringify({ drafts }));
    return `saved ${drafts.length} draft${drafts.length === 1 ? "" : "s"} (${drafts.map((d) => d.style).join(", ")}) for ${id} — they are the tabs on the operator's card now; they pick one and post it.\n\n${drafts.map((d) => `--- ${d.style} ---\n${d.text}`).join("\n\n")}\n\n— the refusals said: ${saved}`;
  }, {
    name: "write_draft",
    description: "Have the engine's WRITER seat draft the reply to one queued person (an id from queue), from the same material `mq draft` assembles — their words, the operator's measured voice, the room's risks, what me.md supports, and the campaign's direction with what was already said under it — then save it through the CLI, which runs the refusals (the eight-word repeat guard included). The draft lands on the operator's card; THEY post it. You never write the reply yourself.",
    schema: z.object({ id: z.string().describe("Item id from queue, e.g. t3_abc123") }),
  }),
};

export const engineTools = (dir, names = Object.keys(VERBS)) =>
  names.filter((n) => VERBS[n]).map((n) => VERBS[n](dir));
