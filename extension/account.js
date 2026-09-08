// The account — one Supabase user, one session in this browser, and the
// data directory mirrored to one table under it.
//
// This is the hosted product's only server-side piece: Supabase's auth and
// one table, `mq_files` (path, content, updated_at), under row-level
// security so a signed-in browser reads and writes its own rows and nothing
// else. No API of ours in between — the extension talks to Supabase's own
// REST directly with the user's token, so the site has nothing to run for
// the sync and nothing to leak. Two doors into the session:
//
//   the 6-digit code   the panel asks for an email, Supabase mails a code,
//                      the person types it into the panel. Same as the
//                      website's own sign-in; never a link to click.
//   connect            messaging.quest/link, signed in there, hands this
//                      extension a one-time token hash (externally
//                      connectable) — "Connect this browser", one click.
//
// The sync is plain last-writer-wins per file: every change to the data
// directory is pushed (debounced, in order); the account is pulled at start
// and once a minute for what another browser wrote. The key never goes:
// `openrouter.key` stays in this browser, so a database is never a file of
// keys. Nor do the job log and the task screenshots — a machine's, not the
// account's. Everything else — the memory files, the campaigns, the rooms,
// the ledgers, the stash, the inbox — is the account's.
//
// Written as a factory over an injected storage and fetch so the same code
// runs under Node against a mock (bin/test.mjs) and in the worker against
// the real thing.

export const SUPABASE_URL = "https://buofxdsuxnklkdbzjlyj.supabase.co";
export const SUPABASE_KEY = "sb_publishable_VEIDv-YZ0Ut8w-MBy77sWw_ywDRCaHe";
export const SITE = "https://messaging.quest";

/** Files that are this browser's, never the account's. */
export const LOCAL_ONLY = /(^|\/)(openrouter\.key|jobs\.jsonl|feed-tokens\.json|threads\.sqlite[^/]*)$|\/tasks\//;

const PUSH_AFTER_MS = 1500;

export function account({ storage, fetch = globalThis.fetch, url = SUPABASE_URL, key = SUPABASE_KEY, root = "/mq", now = () => new Date() } = {}) {
  const headers = (token = null) => ({ apikey: key, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const parse = async (res) => { try { return await res.json(); } catch { return null; } };
  const said = (body, fallback) => body?.msg ?? body?.error_description ?? body?.message ?? body?.error ?? fallback;

  /* --------------------------------------------------------------- session */

  const session = async () => (await storage.get("account"))?.account ?? null;
  const remember = async (s) => {
    const next = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Number(s.expires_at ?? (Math.floor(now().getTime() / 1000) + Number(s.expires_in ?? 3600))), user: { id: s.user?.id ?? null, email: s.user?.email ?? null } } : null;
    await storage.set({ account: next });
    return next;
  };

  /** A token good for the next minute, refreshed when it is not. Null when
   *  signed out — or when the refresh failed, which signs out. */
  const token = async () => {
    const s = await session();
    if (!s) return null;
    if (s.expires_at - Math.floor(now().getTime() / 1000) > 60) return s.access_token;
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: headers(), body: JSON.stringify({ refresh_token: s.refresh_token }) });
    const body = await parse(res);
    if (!res.ok || !body?.access_token) { await remember(null); return null; }
    return (await remember(body)).access_token;
  };

  const api = {
    /** Who is signed in, and how the sync stands. */
    status: async () => {
      const s = await session();
      const st = (await storage.get("sync"))?.sync ?? {};
      return { signedIn: Boolean(s), email: s?.user?.email ?? null, userId: s?.user?.id ?? null, since: st.since ?? null, lastSync: st.at ?? null, dirty: (st.dirty ?? []).length, error: st.error ?? null };
    },

    /** Step one of the code sign-in: Supabase mails a 6-digit code. */
    signInStart: async (email) => {
      const e = String(email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: "that is not an email address" };
      const res = await fetch(`${url}/auth/v1/otp`, { method: "POST", headers: headers(), body: JSON.stringify({ email: e, create_user: true }) });
      if (!res.ok) return { error: said(await parse(res), `Supabase said ${res.status}`) };
      return { ok: true, email: e };
    },

    /** Step two: the code from the inbox, typed into the panel. */
    signInVerify: async (email, code) => {
      const e = String(email ?? "").trim().toLowerCase();
      const t = String(code ?? "").replace(/\s+/g, "");
      if (!/^\d{4,10}$/.test(t)) return { error: "the code is the digits from the email" };
      const res = await fetch(`${url}/auth/v1/verify`, { method: "POST", headers: headers(), body: JSON.stringify({ type: "email", email: e, token: t }) });
      const body = await parse(res);
      if (!res.ok || !body?.access_token) return { error: said(body, `Supabase said ${res.status}`) };
      await remember(body);
      await storage.set({ sync: { since: null, dirty: [], at: null } });
      return { ok: true, email: body.user?.email ?? e };
    },

    /** The website's door: a one-time token hash it minted for its signed-in
     *  user (Supabase generateLink), verified here into a session of this
     *  browser's own. */
    connect: async (tokenHash) => {
      const th = String(tokenHash ?? "").trim();
      if (!th) return { error: "no token" };
      const res = await fetch(`${url}/auth/v1/verify`, { method: "POST", headers: headers(), body: JSON.stringify({ type: "magiclink", token_hash: th }) });
      const body = await parse(res);
      if (!res.ok || !body?.access_token) return { error: said(body, `Supabase said ${res.status}`) };
      await remember(body);
      await storage.set({ sync: { since: null, dirty: [], at: null } });
      return { ok: true, email: body.user?.email ?? null };
    },

    /** Signed out here; the account's files stay in the account, this
     *  browser's stay in this browser. */
    signOut: async () => {
      const s = await session();
      if (s) { try { await fetch(`${url}/auth/v1/logout`, { method: "POST", headers: headers(s.access_token) }); } catch { /* the token dies with the session anyway */ } }
      await remember(null);
      await storage.set({ sync: { since: null, dirty: [], at: null } });
      return { ok: true };
    },

    token,
    session,
  };

  /* ------------------------------------------------------------------ sync */

  const syncable = (path) => path.startsWith(root + "/") && !LOCAL_ONLY.test(path);
  let dirty = new Set();
  let timer = null;
  let running = null;
  let host = null;
  let quiet = false;   // applying the account's rows: not a change of ours

  const saveState = async (patch) => {
    const st = (await storage.get("sync"))?.sync ?? {};
    await storage.set({ sync: { ...st, ...patch, dirty: [...dirty] } });
  };

  const rest = async (path, init = {}) => {
    const t = await token();
    if (!t) throw new Error("not signed in");
    const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers(t), ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(said(await parse(res), `Supabase said ${res.status}`));
    return res.status === 204 ? null : parse(res);
  };

  /** What the account holds that this browser has not seen: rows since the
   *  last pull, applied last-writer-wins. On a first pull the account wins
   *  over a local file of the same name — the account is the truth a second
   *  browser joins. */
  const pull = async () => {
    const st = (await storage.get("sync"))?.sync ?? {};
    const since = st.since ?? null;
    const q = `mq_files?select=path,content,updated_at&order=updated_at.asc${since ? `&updated_at=gt.${encodeURIComponent(since)}` : ""}`;
    const rows = (await rest(q)) ?? [];
    let applied = 0, latest = since;
    const seen = new Set();
    quiet = true;
    try {
      for (const r of rows) {
        if (!syncable(r.path)) continue;
        seen.add(r.path);
        const have = host.existsSync(r.path) ? host.readFileSync(r.path, "utf8") : null;
        if (have !== r.content) { host.load([[r.path, r.content]]); applied++; }
        if (!latest || r.updated_at > latest) latest = r.updated_at;
      }
    } finally { quiet = false; }
    return { rows: rows.length, applied, since: latest, seen };
  };

  /** This browser's changes, upserted in one request. A file gone since it
   *  was marked is simply not sent — there are no tombstones in this version. */
  const push = async () => {
    const paths = [...dirty];
    if (!paths.length) return { sent: 0 };
    const at = now().toISOString();
    const rows = paths.filter((p) => host.existsSync(p)).map((p) => ({ path: p, content: host.readFileSync(p, "utf8"), updated_at: at }));
    if (rows.length) {
      const s = await session();
      await rest("mq_files", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.map((r) => ({ ...r, user_id: s.user.id }))) });
    }
    for (const p of paths) dirty.delete(p);
    return { sent: rows.length, at };
  };

  /** Everything the account has that is not here, then everything here the
   *  account lacks — the first sync of a browser, and every later one. */
  const syncNow = async () => {
    if (!host) return { error: "no host" };
    if (!(await session())) return { skipped: "signed out" };
    if (running) return running;
    running = (async () => {
      try {
        const st = (await storage.get("sync"))?.sync ?? {};
        const first = !st.since;
        const pulled = await pull();
        // What this browser had before the account, and the account did not:
        // the first sync sends it up. What the account had came down just now.
        if (first) for (const [p] of host.snapshot()) if (syncable(p) && !pulled.seen.has(p)) dirty.add(p);
        const pushed = await push();
        // Our own rows come back on the next pull with a later stamp; that
        // pull re-applies identical content and moves `since` — harmless.
        await saveState({ since: pushed.at ?? pulled.since ?? st.since ?? null, at: now().toISOString(), error: null });
        return { ok: true, pulled: pulled.applied, pushed: pushed.sent };
      } catch (e) {
        await saveState({ at: now().toISOString(), error: String(e?.message ?? e) });
        return { error: String(e?.message ?? e) };
      } finally { running = null; }
    })();
    return running;
  };

  /** A change under the data root (the memory host's hook): remembered, and
   *  pushed a moment later with whatever else changed. */
  const changed = (path) => {
    if (quiet || !syncable(path)) return;
    dirty.add(path);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; syncNow().catch(() => {}); }, PUSH_AFTER_MS);
  };

  /** Bind the sync to a memory host. Restores the dirty set a previous
   *  worker life left behind. */
  const attach = async (h) => {
    host = h;
    const st = (await storage.get("sync"))?.sync ?? {};
    dirty = new Set(Array.isArray(st.dirty) ? st.dirty : []);
    return { changed, syncNow };
  };

  return { ...api, attach, syncNow, changed, syncable };
}
