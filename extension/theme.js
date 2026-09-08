/* Light or dark, before anything is drawn.
 *
 * The book (tokens.css) follows the system on its own; this is only for the
 * person who wants the panel to disagree with it — a side panel lives beside
 * a page, and a white forum next to a black panel is a real reason to force
 * one. The choice is this browser's, not the account's: it is about the
 * screen in front of you, so it does not sync and does not travel.
 *
 * Not a module, and first in the head: it must run before the body exists,
 * or the panel paints light and then jumps. localStorage is the only store
 * that answers synchronously — chrome.storage is a promise, which is exactly
 * one frame too late. MV3 forbids an inline script, so this is a file.
 */
(() => {
  const KEY = "mq.theme";
  const pick = (v) => (v === "dark" || v === "light" ? v : "");
  let choice = "";
  try { choice = pick(localStorage.getItem(KEY)); } catch { /* storage can be off; the system's choice stands */ }
  if (choice) document.documentElement.dataset.theme = choice;

  globalThis.mqTheme = {
    /** "" means the system decides. */
    get: () => choice,
    set(v) {
      choice = pick(v);
      try { choice ? localStorage.setItem(KEY, choice) : localStorage.removeItem(KEY); } catch { /* nothing to remember it with */ }
      if (choice) document.documentElement.dataset.theme = choice;
      else delete document.documentElement.dataset.theme;
    },
  };
})();
