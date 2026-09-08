// What this browser already knows about your accounts.
//
// The tool used to ask you to type your own username, on a platform you were
// already signed into in the tab behind it. It has the browser; it can look.
//
// Two ways to look, and NEITHER of them reads a page or sends a request:
//
//   here (this file)   the cookies Chrome is already holding. A platform
//                      declares the names it sets when you are signed in
//                      (skills/<id>/adapter.mjs, `account.cookies`) and this
//                      asks Chrome whether one is there. Presence only: no
//                      value is used for anything but "there is one", nothing
//                      is stored, and nothing leaves the browser. That answers
//                      "signed in here", which is all a cookie can honestly
//                      say — a session cookie does not carry your handle.
//
//   the handle         the platform's own address for your profile redirects
//                      to it while you are signed in, so the name arrives in
//                      the URL bar of a tab you can watch. That happens in the
//                      engine, through the same lane every other read goes
//                      through, at a person's pace (lib/verbs.mjs whoAmI).
//
// The permission for the first is asked for ONCE, on a press, and only for
// the sites of the skills that are actually active. It is not in the install:
// a new extension that asks to read your cookies before you have pressed
// anything has told you what it is.

const originOf = (url) => {
  try { const u = new URL(String(url)); return `${u.protocol}//${u.hostname}/*`; } catch { return null; }
};

const origins = (list) => [...new Set(list.map((p) => originOf(p?.cookies?.url)).filter(Boolean))];

/** Has this browser let the extension look, for all of these? */
export async function granted(list) {
  const o = origins(list);
  if (!o.length || !globalThis.chrome?.permissions) return false;
  return chrome.permissions.contains({ permissions: ["cookies"], origins: o }).catch(() => false);
}

/** Ask — from a click, which is the only place Chrome will show the prompt. */
export async function ask(list) {
  const o = origins(list);
  if (!o.length || !globalThis.chrome?.permissions) return false;
  return chrome.permissions.request({ permissions: ["cookies"], origins: o }).catch(() => false);
}

/**
 * id → "in" | "out" | "unknown".
 *
 * "unknown" is not a failure: it is this browser not having been asked yet,
 * or a platform that declares no cookies to look for. Both are said in those
 * words on the panel rather than guessed at.
 */
export async function detect(list) {
  const out = {};
  for (const p of list ?? []) {
    out[p.id] = "unknown";
    const c = p?.cookies;
    const origin = originOf(c?.url);
    if (!origin || !c.names?.length || !globalThis.chrome?.cookies) continue;
    const may = await chrome.permissions.contains({ permissions: ["cookies"], origins: [origin] }).catch(() => false);
    if (!may) continue;
    let signedIn = false;
    for (const name of c.names) {
      // The object comes back with a value on it; nothing here looks at it.
      const got = await chrome.cookies.get({ url: c.url, name: String(name) }).catch(() => null);
      if (got) { signedIn = true; break; }
    }
    out[p.id] = signedIn ? "in" : "out";
  }
  return out;
}
