// The filesystem, behind one door — so the same engine runs on a disk under
// Node and on a memory under a Chrome service worker (the hosted product,
// 0.10.0: no local server; the extension IS the engine).
//
// Every module in lib/ that used to import node:fs, node:path, node:crypto or
// node:url imports these names from here instead. The names and the call
// shapes are Node's, unchanged — `readFileSync(p, "utf8")`, `mkdirSync(p,
// { recursive: true })`, `readdirSync(p, { withFileTypes: true })` — so the
// store, the memory files, the projects and the skills read exactly as they
// did. What changed is who answers: a HOST, installed once at the start of a
// process, before any of them runs.
//
//   lib/node.mjs        the Node host — the real modules. Every Node entry
//                       point (bin/*.mjs, agent/test.mjs) imports it FIRST;
//                       static imports evaluate in order, so it is installed
//                       before lib/store.mjs asks for a file. Node 22 can also
//                       find the modules by itself (process.getBuiltinModule),
//                       so a forgotten import fails only on 18 and 20 — loudly.
//   lib/fs-memory.mjs   the memory host — files in a Map, POSIX paths, a
//                       change hook the extension persists and syncs from.
//
// Beyond files, the host answers the five other questions lib/ used to ask
// Node directly: a SHA-256 of a string (the rule's hash on every verdict, the
// campaign's hash), random bytes (the hub's tokens), how to import a skill's
// seat by path (a file URL under Node, the extension's own URL in Chrome),
// where the built-in skills/ are, and what the environment says (MQ_DIR,
// OPENROUTER_API_KEY — nothing, in a browser). `spawn` is a Node-only
// extra the job runner uses for the CLI's children; the memory host has none,
// and jobs run in-process there.
//
// Why a facade and not two copies of lib/: two copies drift, and the one that
// drifts is the one somebody trusts. Why not a build step: the tool's promise
// is that `Load unpacked` on the checkout is the extension, and `git archive`
// is the package the store gets.

let H = null;

/** Install a host. Called by lib/node.mjs (Node) or by the extension's
 *  worker (the memory host). Installing twice replaces — a test may swap. */
export function install(host) {
  H = host;
  return host;
}

export const installed = () => H !== null;

/** The host, or the reason there is none. Node 22+ self-installs. */
function need() {
  if (H) return H;
  const get = globalThis.process?.getBuiltinModule;
  if (typeof get === "function") {
    try {
      return install(nodeHost({ fs: get("node:fs"), path: get("node:path"), crypto: get("node:crypto"), url: get("node:url"), child_process: get("node:child_process") }));
    } catch { /* fall through to the message */ }
  }
  throw new Error("lib/fs.mjs: no filesystem host is installed — a Node entry point imports ../lib/node.mjs before anything in lib/; the extension installs the memory host");
}

/** The raw host, for the few callers that need an extra (jobs.mjs: spawn). */
export const host = () => need();

/* ------------------------------------------------------------------- files */

export const existsSync = (p) => need().existsSync(p);
export const readFileSync = (p, enc = "utf8") => need().readFileSync(p, enc);
export const writeFileSync = (p, data) => need().writeFileSync(p, data);
export const appendFileSync = (p, data) => need().appendFileSync(p, data);
export const mkdirSync = (p, opts) => need().mkdirSync(p, opts);
export const readdirSync = (p, opts) => need().readdirSync(p, opts);
export const renameSync = (a, b) => need().renameSync(a, b);
export const unlinkSync = (p) => need().unlinkSync(p);
export const copyFileSync = (a, b) => need().copyFileSync(a, b);

/* ------------------------------------------------------------------- paths */

export const join = (...parts) => need().join(...parts);
export const basename = (p, ext) => need().basename(p, ext);
export const dirname = (p) => need().dirname(p);
export const resolve = (...parts) => need().resolve(...parts);

/* ------------------------------------------------------------------ extras */

/** SHA-256 of a string, hex. */
export const sha256 = (text) => need().sha256(String(text));
/** `n` random bytes as hex. */
export const randomHex = (n) => need().randomHex(n);
/** What to hand `import()` for a seat file at `path`. */
export const moduleUrl = (path) => need().moduleUrl(path);
/** Where the built-in skills/ ring is. */
export const builtinDir = () => need().builtinDir();
/** The environment's answer for `name`, or undefined. */
export const env = (name) => need().env(name);
/** The working directory (Node) or "/" (the memory host). */
export const cwd = () => need().cwd();

/* -------------------------------------------------------------- the hosts */

/** The Node host, from the real modules. lib/node.mjs imports them
 *  statically and calls this; Node 22's self-install above does the same. */
export function nodeHost({ fs, path, crypto, url, child_process }) {
  const here = url.fileURLToPath(import.meta.url);
  return {
    existsSync: fs.existsSync,
    readFileSync: (p, enc = "utf8") => fs.readFileSync(p, enc),
    writeFileSync: fs.writeFileSync,
    appendFileSync: fs.appendFileSync,
    mkdirSync: fs.mkdirSync,
    readdirSync: fs.readdirSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    copyFileSync: fs.copyFileSync,
    join: path.join,
    basename: path.basename,
    dirname: path.dirname,
    resolve: path.resolve,
    sha256: (text) => crypto.createHash("sha256").update(String(text)).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
    moduleUrl: (p) => url.pathToFileURL(p).href,
    builtinDir: () => path.join(path.dirname(here), "..", "skills"),
    env: (name) => process.env[name],
    cwd: () => process.cwd(),
    spawn: child_process.spawn,
    kind: "node",
  };
}
