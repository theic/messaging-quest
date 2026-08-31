// The commit decision: is a source worth a minute a read?
//
// This is engine policy rather than platform mechanics, which is why it stays
// in lib/ when the shapes moved into skills/reddit/. Any platform's probe ends
// at the same question — "of what came back, how much was somebody worth
// answering?" — and the floor is the line every one of them has to clear.

/** Below this, a source is not worth a minute a read. Set from the measured
 *  spread on Reddit: site-wide search sat at 10% and was the shape that wasted
 *  most of the corpus, so 10% is the line between "narrow" and "a firehose
 *  with a phrase on it". A platform whose economics genuinely differ can carry
 *  its own floor on its adapter; none does yet, so none has one. */
export const FLOOR = 0.10;

/** What a probe concluded. Deliberately a decision and a number, not a score:
 *  a competitor's 0–100 relevance score produced eleven distinct values over
 *  981 rows with a floor that never once fired. */
export function verdictOf({ read, fit }) {
  if (!read) return { commit: false, why: "nothing came back to judge" };
  const rate = fit / read;
  return {
    commit: rate >= FLOOR,
    rate,
    why: rate >= FLOOR
      ? `${fit} of ${read} fit (${pct(rate)}) — clears the ${pct(FLOOR)} floor`
      : `${fit} of ${read} fit (${pct(rate)}) — under the ${pct(FLOOR)} floor, so no source is written`,
  };
}

export const pct = (r) => `${Math.round(r * 100)}%`;
