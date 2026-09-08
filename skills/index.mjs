// The built-in ring, by name and by module — for the one host that can
// neither list a folder nor import() at run time.
//
// Under Node the registry (lib/skills.mjs) reads skills/ off the disk and
// the platform door (lib/platform.mjs) imports each adapter by path. The
// extension's worker has no disk, and a service worker may not import()
// (the HTML specification forbids it — w3c/ServiceWorker#1356), so the
// built-in adapters are imported HERE, statically, and handed to the door
// (extension/engine.js → loadPlatforms(dir, { modules })). This is the list
// the worker walks for the manifests too. bin/test.mjs pins both to what
// the folder actually holds, so a skill added to skills/ without a line
// here fails a test rather than silently missing from the hosted product.

import * as reddit from "./reddit/adapter.mjs";

export const BUILTIN_SKILLS = ["reddit"];
export const BUILTIN_ADAPTERS = { reddit };
