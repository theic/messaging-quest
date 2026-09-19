// A correction to a customer's offer, applied. One function, two callers: the
// engine, when it has understood an instruction in a customer's message
// (interpretInstruction, lib/agents.mjs), and Quest's `revise_offer` tool, when
// the model chose to call it. Whichever way it arrives the effect is the same,
// and it is an effect on what the JUDGE reads (rule.md), on the campaign the
// writer reads and on the rooms the look takes — never only on a note.
//
// Why it exists: measured 2026-09-19, told "leave out anyone selling services
// or running an agency", a free model wrote that into its notebook (which only
// Quest reads), changed nothing the judge reads, and answered that it was "not
// marking" two cards as matches — something it cannot do. Who gets found is
// too important to leave to a model remembering to call a tool.

import { readStash, patchStash } from "./cards.mjs";
import { writeMemory } from "./memory.mjs";
import { writeCampaign } from "./campaigns.mjs";
import { say, setCard } from "./chat.mjs";
import { revise, ruleOf, campaignOf, offerCard, lookRooms, uniqCI } from "./quest.mjs";

const bare = (p) => String(p ?? "").trim().replace(/^\/?r\//i, "").replace(/[^\w-]/g, "").slice(0, 40);

/**
 * Apply `patch` (see revise() in lib/quest.mjs) to the customer's offer.
 * Returns { ok, said, leftOut, added }: `said` is what a model is told back,
 * `leftOut` the kinds of people now left out because of THIS patch, `added`
 * the communities that joined the look. Before they confirm, the card is
 * replaced by a corrected one; after, the judge's rule, the campaign and the
 * look change at once.
 */
export function applyRevision(dir, patch = {}, { room = (p) => p } = {}) {
  const s = readStash(dir);
  if (!s.offer) return { ok: false, said: "there is no card yet — their site is still being read; say it is on its way", leftOut: [], added: [] };
  const next = revise(s.offer, patch);
  const leftOut = (next.leave_out ?? []).filter((x) => !(s.offer.leave_out ?? []).includes(x));

  if (s.offer.state === "confirmed") {
    writeMemory(dir, "rule.md", ruleOf(next));
    writeCampaign(dir, campaignOf(next));
    // A community they NAMED joins the look: the engine reads its rules, then
    // it, by itself, with the phrases as they stand now. The proposal's other
    // places stay unread, as before — three is enough to find out.
    const have = new Set((s.look?.rooms ?? []).map((r) => r.place.toLowerCase()));
    const named = [...(patch.places ?? []), ...(patch.add_places ?? [])].map(bare).filter(Boolean);
    const added = uniqCI(named).filter((p) => !have.has(p.toLowerCase()));
    patchStash(dir, {
      offer: { ...next, state: "confirmed" },
      ...(added.length ? { look: { ...(s.look ?? {}), said: false, retried: false, phrases: next.searches ?? s.look?.phrases ?? [], rooms: [...(s.look?.rooms ?? []), ...lookRooms(added)] } } : {}),
    });
    const bits = [
      leftOut.length ? `leaving out ${leftOut.join(", ")} from now on` : "",
      added.length ? `adding ${added.map(room).join(", ")} — it is read by itself, next` : "",
    ].filter(Boolean);
    return { ok: true, said: `done — ${bits.join("; ") || "the changes are on file"}. Tell them what changed in one line.`, leftOut, added };
  }

  setCard(dir, s.offer.card, { state: "replaced" });
  const msg = say(dir, offerCard(next, { room }));
  patchStash(dir, { offer: { ...next, state: "open", card: msg.id, at: new Date().toISOString() } });
  return { ok: true, said: "done — the corrected card is in the chat now, with its buttons. Do not repeat it in words; at most say you changed it.", leftOut, added: [], card: msg.id };
}
