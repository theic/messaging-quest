// The worker's disk — IndexedDB, one store, one row per file.
//
// The engine runs on a memory filesystem (lib/fs-memory.mjs) and reads
// synchronously; this is where the memory comes from when the worker starts
// and where every change goes the moment it is made. Writes are queued in
// order — a ledger appended twice in one tick lands twice, in that order —
// and never awaited by the engine: a write that fails is logged, and the
// memory stays the truth until the worker dies. The account sync
// (extension/account.js) reads the same rows; this file knows nothing of it.

const DB = "mq";
const STORE = "files";

export function disk() {
  let dbp = null;
  const db = () => (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };

  // One queue for the writes, so two changes to one file cannot race and
  // land out of order.
  let chain = Promise.resolve();
  const queue = (fn) => { chain = chain.then(fn, fn).catch((e) => console.error("disk:", e?.message ?? e)); return chain; };

  return {
    /** Every file, as [path, content] pairs. */
    all: () => tx("readonly", (st) => {
      const rows = [];
      const req = st.openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { rows.push([c.key, c.value]); c.continue(); } };
      return { get result() { return rows; } };
    }),
    /** A change from the memory host: the whole file, or null when gone. */
    write: (path, content) => queue(() => tx("readwrite", (st) => (content === null ? st.delete(path) : st.put(content, path)))),
    /** Wait for every queued write — before a sync, before a hand-over. */
    settle: () => chain,
    /** Everything gone — signing out of an account, or a test. */
    clear: () => queue(() => tx("readwrite", (st) => st.clear())),
  };
}
