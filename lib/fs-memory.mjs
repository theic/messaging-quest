// The memory host for lib/fs.mjs — the engine's disk when there is no disk.
//
// A Chrome service worker has no filesystem and no synchronous storage, and
// the engine reads synchronously (the store re-reads a ledger per call, the
// deck reads the memory files per deal — that is what keeps `cat` the answer
// to "why is this person in my queue"). So the whole data directory lives in
// a Map, loaded once when the worker starts, and every change is reported to
// a hook the extension persists (IndexedDB) and syncs (the account). It is
// small: a project's ledgers are a few hundred kilobytes at the end of a busy
// month, and the 48-hour body rule keeps them so.
//
// The rules are Node's, on purpose, so the tests that run the engine here
// under Node mean what they say: a write into a directory that does not
// exist is ENOENT; mkdir of an existing directory without `recursive` is
// EEXIST; readdir lists names sorted; rename moves a whole subtree. Paths
// are POSIX and absolute — a relative one resolves against "/", so ".mq" and
// "/.mq" are one directory, which is how MQ_DIR's default reads unchanged.

/* ------------------------------------------------------------------- paths */

export function normalize(p) {
  const abs = String(p ?? "").replace(/\\/g, "/");
  const parts = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** Node's path.join, POSIX: relative stays relative, ".." folds. */
export function join(...parts) {
  const ps = parts.filter((x) => x !== undefined && x !== null && String(x) !== "");
  if (!ps.length) return ".";
  const raw = ps.map(String).join("/");
  const lead = raw.startsWith("/");
  const out = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!lead) out.push(".."); continue; }
    out.push(seg);
  }
  const s = out.join("/");
  return lead ? "/" + s : (s || ".");
}

export function basename(p, ext) {
  const s = String(p ?? "").replace(/\/+$/, "");
  const b = s.slice(s.lastIndexOf("/") + 1);
  return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
}

export function dirname(p) {
  const raw = String(p ?? "");
  const s = raw.replace(/\/+$/, "");
  if (!s) return raw.startsWith("/") ? "/" : ".";
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return s.slice(0, i);
}

export const resolve = (...parts) => normalize(join("/", ...parts));

/* ------------------------------------------------------------------ sha256 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of a string (UTF-8), hex — the same digest node:crypto gives, so a
 *  verdict stamped on one host reads as the same rule on the other. */
export function sha256(text) {
  const bytes = new TextEncoder().encode(String(text));
  const len = bytes.length;
  const withPad = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(withPad);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = len * 8;
  view.setUint32(withPad - 8, Math.floor(bits / 0x100000000));
  view.setUint32(withPad - 4, bits >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}

export function randomHex(n) {
  const b = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ----------------------------------------------------------------- the fs */

const err = (code, syscall, p) => { const e = new Error(`${code}: ${syscall} '${p}'`); e.code = code; e.syscall = syscall; e.path = p; return e; };

/**
 * The files, in memory. `onChange(path, content)` fires after every write —
 * `content` is the whole file (small, always), or null when it is gone.
 * `load(entries)` fills the map without firing; `snapshot()` reads it out.
 */
export function memoryFs({ onChange = null } = {}) {
  const files = new Map();   // "/a/b" → string
  const dirs = new Set(["/"]);
  const changed = (p, content) => { if (onChange) onChange(p, content); };
  const hasDir = (p) => dirs.has(p);
  const isFile = (p) => files.has(p);
  const parentOk = (p, syscall) => { const d = dirname(p); if (!hasDir(d)) throw err("ENOENT", syscall, p); };
  const mkdirs = (p) => { const parts = normalize(p).split("/").filter(Boolean); let cur = ""; for (const s of parts) { cur += "/" + s; if (isFile(cur)) throw err("ENOTDIR", "mkdir", p); dirs.add(cur); } };
  const childrenOf = (d) => {
    const pre = d === "/" ? "/" : d + "/";
    const names = new Set();
    for (const f of files.keys()) if (f.startsWith(pre)) names.add(f.slice(pre.length).split("/")[0]);
    for (const x of dirs) if (x !== d && x.startsWith(pre)) names.add(x.slice(pre.length).split("/")[0]);
    return [...names].sort();
  };

  const api = {
    existsSync: (p) => { const n = normalize(p); return isFile(n) || hasDir(n); },
    readFileSync: (p) => { const n = normalize(p); if (isFile(n)) return files.get(n); throw err(hasDir(n) ? "EISDIR" : "ENOENT", "open", p); },
    writeFileSync: (p, data) => { const n = normalize(p); if (hasDir(n)) throw err("EISDIR", "open", p); parentOk(n, "open"); files.set(n, String(data)); changed(n, files.get(n)); },
    appendFileSync: (p, data) => { const n = normalize(p); if (hasDir(n)) throw err("EISDIR", "open", p); parentOk(n, "open"); files.set(n, (files.get(n) ?? "") + String(data)); changed(n, files.get(n)); },
    mkdirSync: (p, { recursive = false } = {}) => {
      const n = normalize(p);
      if (recursive) { mkdirs(n); return; }
      if (hasDir(n) || isFile(n)) throw err("EEXIST", "mkdir", p);
      parentOk(n, "mkdir");
      dirs.add(n);
    },
    readdirSync: (p, { withFileTypes = false } = {}) => {
      const n = normalize(p);
      if (!hasDir(n)) throw err(isFile(n) ? "ENOTDIR" : "ENOENT", "scandir", p);
      const names = childrenOf(n);
      if (!withFileTypes) return names;
      return names.map((name) => { const full = n === "/" ? "/" + name : `${n}/${name}`; const dir = hasDir(full); return { name, isDirectory: () => dir, isFile: () => !dir }; });
    },
    renameSync: (a, b) => {
      const from = normalize(a), to = normalize(b);
      if (isFile(from)) { parentOk(to, "rename"); const body = files.get(from); files.delete(from); files.set(to, body); changed(from, null); changed(to, body); return; }
      if (!hasDir(from)) throw err("ENOENT", "rename", a);
      parentOk(to, "rename");
      const pre = from + "/";
      for (const f of [...files.keys()]) if (f.startsWith(pre)) { const body = files.get(f); files.delete(f); const nf = to + f.slice(from.length); files.set(nf, body); changed(f, null); changed(nf, body); }
      for (const d of [...dirs]) if (d === from || d.startsWith(pre)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
    },
    unlinkSync: (p) => { const n = normalize(p); if (!isFile(n)) throw err(hasDir(n) ? "EISDIR" : "ENOENT", "unlink", p); files.delete(n); changed(n, null); },
    copyFileSync: (a, b) => { const from = normalize(a), to = normalize(b); if (!isFile(from)) throw err("ENOENT", "copyfile", a); parentOk(to, "copyfile"); files.set(to, files.get(from)); changed(to, files.get(to)); },
    /* the memory host's own */
    load: (entries) => { for (const [p, body] of entries) { const n = normalize(p); mkdirs(dirname(n)); files.set(n, String(body)); } },
    snapshot: () => [...files.entries()],
    hasDir,
    mkdirs,
  };
  return api;
}

/**
 * A whole host for lib/fs.mjs on the memory fs. `moduleUrl` is the one thing
 * the environment must say: how a seat file under builtinDir is imported.
 * The extension answers with chrome.runtime.getURL; a Node test with the
 * file URL of the real skills/ folder.
 */
export function memoryHost({ onChange = null, moduleUrl = null, builtin = "/skills", env = {} } = {}) {
  const fs = memoryFs({ onChange });
  fs.mkdirs(builtin);
  return {
    ...fs,
    join, basename, dirname, resolve,
    sha256, randomHex,
    moduleUrl: moduleUrl ?? ((p) => { throw new Error(`no way to import ${p} on this host`); }),
    builtinDir: () => builtin,
    env: (name) => env[name],
    cwd: () => "/",
    spawn: null,
    kind: "memory",
  };
}
