// What people typically ask their specialist, as buttons under the card — so
// the typical actions are visible rather than guessed at, like the prompts a
// chat assistant offers before the first message. Pure: the panel's state and
// the card on screen in, the chips out, so bin/test.mjs holds it to shape.
//
// A chip is either a question for the specialist (`ask`, sent through the
// same box the operator types in) or a place to go (`view`, one of the
// panel's tabs). Never an action on its own: the buttons that DO things stay
// on the cards and the tabs, where their refusals are.

const MAX_ASKS = 5;

export function suggestionsFor({ state = null, card = null, brain = true } = {}) {
  if (!state) return [];   // no state is no server: the down card says what to do
  const asks = [];
  const goes = [];
  const camps = state?.campaigns ?? [];
  const active = camps.filter((c) => c.status === "active");
  const focus = camps.find((c) => c.id === state?.focus) ?? active[0] ?? camps[0] ?? null;
  const setup = state?.setup ?? null;
  const started = Boolean(setup && setup.done > 0);
  const done = Boolean(setup && setup.total > 0 && setup.done >= setup.total);
  const kind = String(card?.kind ?? card?.id ?? "");
  const rooms = (state?.rooms ?? []).length + (state?.sources ?? []).length;

  if (brain) {
    asks.push({ label: "What should I do next?", ask: "What should I do next? Read the deck first. Answer in a few plain lines, and if a search, a campaign or a rewrite is the right move, put it on my deck as a card." });
    if ((state?.waiting ?? 0) > 0) asks.push({ label: "Who is waiting on me?", ask: "Who is waiting on a reply from me, and which one should I answer first?" });
    if (/^work\.(reply|turn)$/.test(kind)) asks.push({ label: "Why this person?", ask: "The person on my deck right now — why are they a fit, which of the three drafts would you send, and why?" });
    if (focus) asks.push({ label: `How is “${focus.name}” going?`, ask: `How is the campaign “${focus.name}” going? Use its numbers — found, fit, sent, replies, second turns, crowding — and say in a few lines what to keep and what to change.` });
    if (camps.length) asks.push({ label: "What campaign should I try next?", ask: "Given what has been found and what is waiting, what campaign should I try next, aimed at a different kind of person? Propose it as cards." });
    else if (done) asks.push({ label: "Propose my first campaign", ask: "Propose a first campaign for me — a direction aimed at the people my rule fits, with a room and a phrase — as cards on my deck." });
    if (started) asks.push({ label: "What is my brand about?", ask: "In three short lines: what is my brand about, who is it for, and how do I sound when I write?" });
    if (rooms) asks.push({ label: "Which room next?", ask: "Which room should I try next, and with what phrase? Say why in a line and propose it as a card." });
  }

  if (rooms || done) goes.push({ label: "Try a room", view: "rooms" });
  if (!camps.length && done) goes.push({ label: "Start a campaign", view: "campaigns" });
  else if (camps.length) goes.push({ label: "The campaigns", view: "campaigns" });

  return [...asks.slice(0, MAX_ASKS), ...goes.slice(0, 2)];
}
