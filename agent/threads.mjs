// One checkpointer for every thread this machine holds — the CMO's long-lived
// conversation and each worker's run — on SQLite, in the data directory.
//
// A restart used to forget the strategist's conversation (MemorySaver) and
// lost nothing else, because every fact lives in the store. Workers change
// that arithmetic: a scout halfway through a search, or paused on a question
// nobody has answered yet, is state worth keeping. So the threads live in
// <dir>/threads.sqlite — checkpoints, page bodies the model read, the pending
// interrupt — and never leave the machine (PLAN.md: "checkpoints, page bodies,
// screenshots and drafts never leave the machine").
//
// The dependency is the official LangGraph SQLite saver (agent/ is the one
// directory that carries dependencies). One saver per data directory, shared
// by every agent built in this process.

import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const savers = new Map();

export function threadSaver(dir) {
  const key = String(dir);
  if (!savers.has(key)) savers.set(key, SqliteSaver.fromConnString(join(dir, "threads.sqlite")));
  return savers.get(key);
}
