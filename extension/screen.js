// The click screen — the one list of words a control's label may not carry
// for the extension to press it on an agent's behalf.
//
// It starts as the insert screen's list (insert.js, NEVER: the labels that
// could submit or destroy — post, submit, send, save, publish, delete, remove,
// report, share, edit, upvote, downvote) and adds the openers that screen
// deliberately allows a HUMAN-initiated insert to press (comment, reply — the
// controls that open a composer) plus the other verbs that change the
// operator's standing on a platform (join, subscribe, follow, vote, message,
// chat, award, block) and the ones that spend or agree (approve, confirm,
// accept, agree, pay, buy, purchase, checkout). A click on any of these is
// refused in the page, before anything is dispatched, whatever the caller was
// granted. bin/test.mjs pins that this list is a superset of insert.js's.
//
// A string, not a RegExp: the page-side functions are serialized by
// chrome.scripting and cannot close over this module, so the source travels
// as an argument and is compiled where it is used.

export const CLICK_SCREEN =
  "\\b(post|submit|send|save|publish|delete|remove|report|share|edit|upvote|downvote|" +
  "comment|reply|join|subscribe|follow|vote|message|chat|award|block|" +
  "approve|confirm|accept|agree|pay|buy|purchase|checkout)\\b";
