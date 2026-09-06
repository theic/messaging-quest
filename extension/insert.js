// Where a reply goes: the composer, found but never touched from here.
//
// composerState() is injected into a platform's tab via
// chrome.scripting.executeScript({func}). Chrome SERIALIZES it — it runs in
// the page with no closure over this file — so it is fully self-contained,
// takes the word lists as regex sources and the host selector as a string,
// and READS ONLY: it says where the composer is, or where the control that
// opens one is, and the hands in control.js (insertDraft) do the clicking
// and the pasting through Chrome's own input pipeline. Nothing in this file
// dispatches an event or sets a value.
//
// The platform's words — which labels open a composer, which sit on a reply
// box, which custom elements host one — ride on the reply card
// (lib/platform.mjs composerOf → card.data.insert), so this file carries
// none of Reddit's own. What stays here is the extension's: NEVER, the
// labels that could submit or destroy, screened whatever a platform says.
//
// Ported from the predecessor (messaging-quest, page-scripts.js MQInsert),
// where every clause below was paid for on a real page:
//   - A composer built inside web components is invisible to an ordinary
//     querySelectorAll, so the search walks shadow roots.
//   - The box may not EXIST until an opener is clicked, so a closed composer
//     names its opener — chosen against ANY label that could submit. That
//     click may only ever open a box.
//   - A focused box beats a guessed one; otherwise the biggest editor on the
//     page, never a bare <input> — that is how a reply ends up in a search
//     field.
//
// Pressing the platform's own button stays the human's job. Always. There
// is no code path here that submits, and keeping it that way is the product.

/** Generic openers and reply labels, used when a card names none. */
export const OPENS_DEFAULT = ["add a comment", "add comment", "write a comment", "leave a comment", "join the conversation"];
export const REPLIES_DEFAULT = ["reply", "write a reply", "reply to post", "comment"];
const NEVER = /\b(post|submit|send|save|publish|delete|remove|report|share|edit|upvote|downvote)\b/i;
export { NEVER };

/** A whole-label regex source from a list of labels. */
export const wordsSource = (list, dflt) => {
  const words = (Array.isArray(list) && list.length ? list : dflt).map((w) => String(w).trim().toLowerCase()).filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(${words.join("|")})$`;
};
export const OPENS = new RegExp(wordsSource([], OPENS_DEFAULT), "i");
export const REPLIES = new RegExp(wordsSource([], REPLIES_DEFAULT), "i");

/**
 * In the page: `{ box, opener }`. `box` is the composer if one is open —
 * its rect on the viewport, its kind (editable / textarea / input) and
 * whether it is empty; `opener` is the control that would open one, with
 * its label. Either may be null. The rects carry the viewport and the
 * scroll position, which is what the wheel needs to bring them into view.
 * `hostsSel` is the platform's list of custom elements that host a
 * composer, as a selector list ("shreddit-composer, comment-composer-host")
 * or empty.
 */
export function composerState(opensSrc, repliesSrc, neverSrc, hostsSel) {
  const OPENS = new RegExp(opensSrc, "i"), REPLIES = new RegExp(repliesSrc, "i"), NEVER = new RegExp(neverSrc, "i");
  const roots = () => {
    const found = [document];
    for (let i = 0; i < found.length; i++) {
      for (const el of found[i].querySelectorAll("*")) if (el.shadowRoot) found.push(el.shadowRoot);
    }
    return found;
  };
  const queryAll = (selector) => {
    const out = [];
    for (const root of roots()) for (const el of root.querySelectorAll(selector)) out.push(el);
    return out;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, scrollY: window.scrollY };
  };
  const typable = (el) =>
    !!el && !el.disabled && !el.readOnly &&
    (el.isContentEditable || el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && /^(text|search)$/.test(el.type || "")));

  // Focus wins: a box the user is standing in beats anything we could guess.
  // document.activeElement stops at a shadow host, so walk the rest of the way.
  const focused = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return typable(el) ? el : null;
  };
  const biggest = () => {
    let best = null, bestArea = 0;
    for (const el of queryAll("textarea, [contenteditable]")) {
      if (!typable(el) || el.tagName === "INPUT") continue;
      const r = el.getBoundingClientRect();
      const size = r.width > 120 && r.height > 28 ? r.width * r.height : 0;
      if (size > bestArea) { best = el; bestArea = size; }
    }
    return best;
  };
  const box = focused() || biggest();
  if (box) {
    const kind = box.isContentEditable ? "editable" : box.tagName === "TEXTAREA" ? "textarea" : "input";
    const empty = !(box.isContentEditable ? box.textContent : box.value).trim();
    return { box: { rect: rect(box), kind, empty }, opener: null };
  }

  /** The control that opens a closed composer, thread-level ones first. An
   *  anchor that really navigates would take the thread away with it. */
  let best = null, bestRank = 9;
  const selector = "button, [role='button'], a, summary" + (hostsSel && String(hostsSel).trim() ? ", " + hostsSel : "");
  for (const el of queryAll(selector)) {
    const href = el.getAttribute("href");
    if (el.tagName === "A" && href && !/^(#|javascript:)/i.test(href)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || "").trim();
    if (!label || label.length > 40 || NEVER.test(label)) continue;
    const rank = OPENS.test(label) ? 0 : REPLIES.test(label) ? 1 : 9;
    // Rank first, then document order: the first "Reply" belongs to the post
    // we are answering, not to somebody else's comment underneath it.
    if (rank < bestRank) { best = el; bestRank = rank; }
  }
  return { box: null, opener: best ? { rect: rect(best), label: (best.getAttribute("aria-label") || best.innerText || "").trim().slice(0, 40) } : null };
}
