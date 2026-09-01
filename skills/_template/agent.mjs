// The agent seat: a colleague the strategist can hand a task to, seated as a
// Deep Agents subagent when the brain (npm run brain) is installed. Delete
// this file if your skill contributes no colleague.
//
// This module is BARE NODE on purpose — skills carry no dependencies. The
// adaptation to the LangChain runtime happens in agent/strategist.mjs, the
// one place that owns it. Tools take plain JSON Schema and return a string;
// run() receives ({ ...args }, { dir }).
//
// Everything a subagent does inherits the house law: it drafts, it proposes,
// it never submits — there is no code in this repo that posts anything, so
// there is nothing for a tool to reach.

export default {
  name: "example-colleague",
  description: "When the strategist should delegate to this agent, in one sentence it will read.",
  prompt: `You are a specialist colleague. State your working rules here the
way persona.md states the strategist's: plain sentences, concrete numbers,
quote a refusal rather than apologising for it.`,
  tools: [
    {
      name: "example_lookup",
      description: "What this tool answers, for the model deciding to call it.",
      schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: async ({ query }, { dir }) => `You asked about ${query} (data dir: ${dir}).`,
    },
  ],
};
