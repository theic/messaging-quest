// The Node host for lib/fs.mjs — import this FIRST in every Node entry point.
//
//   import "../lib/node.mjs";
//   import { store } from "../lib/store.mjs";
//
// Static imports evaluate in the order they are written, depth first, so this
// module has installed the real filesystem before lib/store.mjs (or anything
// under it) evaluates. Nothing else in lib/ imports node:fs, node:path,
// node:crypto or node:url — the extension loads the same files on a memory
// host (lib/fs-memory.mjs), and a static node: import anywhere in lib/ would
// refuse to link there. bin/test.mjs pins that.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as url from "node:url";
import * as child_process from "node:child_process";
import { install, nodeHost } from "./fs.mjs";

install(nodeHost({ fs, path, crypto, url, child_process }));
