// Where a reply goes: the composer, found but never touched from here.
//
// composerState() is injected into a platform's tab via
// chrome.scripting.executeScript({func}). Chrome SERIALIZES it — it runs in
// the page with no closure over this file — so it is fully self-contained,
// takes the word lists as regex sources and the selectors as strings, and
// READS ONLY: it says where the composer is, or where the control that
// opens one is, and the hands in control.js (insertDraft) do the clicking
// and the pasting through Chrome's own input pipeline. Nothing in this file
// dispatches an event or sets a value.
//
// The platform's words — which labels open a composer, which sit on a reply
// box, which custom elements host one, which hold a comment — ride on the
// reply card (lib/platform.mjs composerOf → card.data.insert), so this file
// carries none of Reddit's own. What stays here is the extension's: NEVER,
// the labels that could submit or destroy, screened whatever a platform
// says; and SEARCH, the field a reply must never land in.
//
// Ported from the predecessor (messaging-quest, page-scripts.js MQInsert),
// where every clause below was paid for on a real page, and measured again
// on Reddit's thread page on 2026-09-07:
//   - A composer built inside web components is invisible to an ordinary
//     querySelectorAll, so the search walks shadow roots.
//   - The box may not EXIST until an opener is clicked, so a closed composer
//     names its opener — chosen against ANY label that could submit. That
//     click may only ever open a box. On Reddit the thread's own opener is
//     not a button at all: a twenty-pixel textarea whose placeholder reads
//     "Join the conversation", swapped for the real editor on a click. So a
//     typable thing whose placeholder is an opener's label IS an opener.
//   - The reply belongs somewhere. A comment on the post goes into the
//     thread's box, never into the first comment's Reply — which is what an
//     opener search by label alone picked, because every comment carries
//     one. A reply to a person's comment goes under THEIR comment. The card
//     says which (target), the platform says what holds a comment.
//   - A focused box beats a guessed one; otherwise the biggest editor on the
//     page, never a bare <input> and never the search field — that is how a
//     reply ends up in a search box.
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

/** A selector list from a platform's element names — custom-element names
 *  only, so a platform's word can never become a selector that does more. */
export const selectorList = (list) =>
  (Array.isArray(list) ? list : []).map((h) => String(h).trim()).filter((h) => /^[a-z][a-z0-9-]*$/i.test(h)).join(", ");

/**
 * In the page: `{ box, opener }`. `box` is the composer if one is open —
 * its rect on the viewport, its kind (editable / textarea / input), whether
 * it is empty and how many characters it holds; `opener` is the control
 * that would open one, with its label. Either may be null. The rects carry
 * the viewport and the scroll position, which is what the wheel needs to
 * bring them into view.
 *
 * `hostsSel` is the platform's list of custom elements that host a
 * composer, `commentsSel` its list of elements that hold one comment (both
 * as selector lists, or empty), and `target` is where the reply belongs:
 * "post" — the thread's own box, outside every comment — or "comment" —
 * inside the first comment on the page, which on a comment's own page is
 * the one being answered.
 */
export function composerState(opensSrc, repliesSrc, neverSrc, hostsSel, commentsSel, target) {
  const OPENS = new RegExp(opensSrc, "i"), REPLIES = new RegExp(repliesSrc, "i"), NEVER = new RegExp(neverSrc, "i");
  const SEARCH = /\b(search|find|filter)\b/i;
  const toPost = target !== "comment";
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
  const label = (el) =>
    (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.innerText || "").trim();
  const typable = (el) =>
    !!el && !el.disabled && !el.readOnly &&
    (el.isContentEditable || el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && /^(text|search)$/.test(el.type || "")));
  const matches = (el, sel) => {
    if (!sel || !el || el.nodeType !== 1) return false;
    try { return el.matches(sel); } catch { return false; }
  };
  // Whether it sits inside an element of that kind — climbing out through
  // shadow hosts, which is where a platform's custom elements keep their
  // insides.
  const within = (el, sel) => {
    if (!sel) return false;
    for (let n = el; n; n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode) if (matches(n, sel)) return true;
    return false;
  };
  // Where the reply belongs: a comment on the post is written OUTSIDE every
  // comment; a reply to a person's comment INSIDE theirs.
  const placed = (el) => (toPost ? !within(el, commentsSel) : within(el, commentsSel));

  // Focus wins: a box the user is standing in beats anything we could guess
  // — as long as it is where this reply belongs; a caret left in the
  // thread's box does not turn a reply to a person into a comment on the
  // post. document.activeElement stops at a shadow host, so walk the rest
  // of the way.
  const focused = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return typable(el) && !SEARCH.test(label(el)) && placed(el) ? el : null;
  };
  const biggest = () => {
    let best = null, bestScore = 0;
    for (const el of queryAll("textarea, [contenteditable]")) {
      if (!typable(el) || el.tagName === "INPUT") continue;
      const l = label(el);
      // The search field; and a collapsed composer wearing an opener's
      // words, which is an opener (below), not a box to write into.
      if (SEARCH.test(l) || OPENS.test(l)) continue;
      if (!placed(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 120 || r.height <= 24) continue;
      // A box inside the platform's own composer element outranks a bigger
      // editable elsewhere on the page.
      const score = r.width * r.height * (within(el, hostsSel) ? 4 : 1);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  };
  const box = focused() || biggest();
  if (box) {
    const kind = box.isContentEditable ? "editable" : box.tagName === "TEXTAREA" ? "textarea" : "input";
    const held = String(box.isContentEditable ? box.textContent : box.value).trim();
    return { box: { rect: rect(box), kind, empty: !held, chars: held.length }, opener: null };
  }

  /** The control that opens a closed composer. Openers' labels first, then
   *  reply labels, then document order — and only where the reply belongs.
   *  An anchor that really navigates would take the thread away with it;
   *  the composer's own controls (its Cancel, its Comment) are never it. */
  let best = null, bestRank = 9;
  for (const el of queryAll("button, [role='button'], a, summary, textarea, input, [contenteditable]")) {
    const href = el.getAttribute("href");
    if (el.tagName === "A" && href && !/^(#|javascript:)/i.test(href)) continue;
    if (!typable(el) && ((el.getAttribute("type") || "").toLowerCase() === "submit" || within(el, hostsSel))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const l = label(el);
    if (!l || l.length > 40 || NEVER.test(l) || SEARCH.test(l)) continue;
    if (!placed(el)) continue;
    const rank = OPENS.test(l) ? 0 : REPLIES.test(l) ? 1 : 9;
    if (rank < bestRank) { best = el; bestRank = rank; }
  }
  return { box: null, opener: best ? { rect: rect(best), label: label(best).slice(0, 40) } : null };
}
