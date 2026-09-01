// The one function injected into a Reddit tab, via
// chrome.scripting.executeScript({func}). Chrome SERIALIZES it — it runs in
// the page with no closure over this file — so it must be fully
// self-contained. It is loaded into the panel as a classic script, before the
// panel's modules, purely so sidepanel.js can pass it by name.
//
// Ported from the predecessor (messaging-quest, page-scripts.js MQInsert),
// where every clause below was paid for on a real page:
//   - Reddit builds its composer inside web components; a shadow root is
//     invisible to an ordinary querySelectorAll, so the search walks them.
//   - The box does not EXIST until "Add a comment" is clicked, so a closed
//     composer gets opened — by a click screened against ANY label that could
//     submit. This click may only ever open a box.
//   - Coming from the deck we open the thread ourselves and an SPA is still
//     rendering when "load" fires, so it keeps looking for a few seconds.
//   - Controlled React inputs ignore plain `el.value = …`; text fields go
//     through the native value setter + an `input` event, contenteditable gets
//     execCommand("insertText"). Appends — never wipes what is there.
//
// Pressing Reddit's own Comment button stays the human's job. Always. There is
// no code path here that submits, and keeping it that way is the product.

async function ESInsert(message) {
  const OPENS = /^(add a comment|add comment|write a comment|leave a comment|join the conversation)$/i;
  const REPLIES = /^(reply|write a reply|reply to post|comment)$/i;
  const NEVER = /\b(post|submit|send|save|publish|delete|remove|report|share|edit|upvote|downvote)\b/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const box = (el) => el.getBoundingClientRect();
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
  // Otherwise the biggest editor on the page, never a bare <input> — that is
  // how a reply ends up in a search field.
  const biggest = () => {
    let best = null, bestArea = 0;
    for (const el of queryAll("textarea, [contenteditable]")) {
      if (!typable(el) || el.tagName === "INPUT") continue;
      const r = box(el);
      const size = r.width > 120 && r.height > 28 ? r.width * r.height : 0;
      if (size > bestArea) { best = el; bestArea = size; }
    }
    return best;
  };
  const findBox = () => focused() || biggest();

  /** The control that opens a closed composer, thread-level ones first. An
   *  anchor that really navigates would take the thread away with it. */
  const findOpener = () => {
    let best = null, bestRank = 9;
    for (const el of queryAll("button, [role='button'], a, summary, shreddit-composer, comment-composer-host")) {
      const href = el.getAttribute("href");
      if (el.tagName === "A" && href && !/^(#|javascript:)/i.test(href)) continue;
      const r = box(el);
      if (r.width < 8 || r.height < 8) continue;
      const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || "").trim();
      if (!label || label.length > 40 || NEVER.test(label)) continue;
      const rank = OPENS.test(label) ? 0 : REPLIES.test(label) ? 1 : 9;
      // Rank first, then document order: the first "Reply" belongs to the post
      // we are answering, not to somebody else's comment underneath it.
      if (rank < bestRank) { best = el; bestRank = rank; }
    }
    return best;
  };

  let el = findBox();
  let opened = false;
  const deadline = Date.now() + 4000;
  while (!el && Date.now() < deadline) {
    if (!opened) {
      const opener = findOpener();
      if (opener) { opener.click(); opened = true; }
    }
    await sleep(150);
    el = findBox();
  }
  if (!el) return { ok: false, reason: "no_composer" };

  el.focus();
  if (el.isContentEditable) {
    // Caret to the end, so a composer with something in it gets the draft
    // appended rather than spliced into the middle of the user's words.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, el.textContent.trim() ? `\n\n${message}` : message);
  } else {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, el.value ? `${el.value}\n\n${message}` : message);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  return { ok: true };
}
