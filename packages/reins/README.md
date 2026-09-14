# reins

**Hand the reins to the model.** `reins` is the umbrella package: `createAgent()` plus everything from `@reinsjs/core`, `@reinsjs/server` and `@reinsjs/ui-agui` re-exported, so one install gives you an agent with a Web-standard handler and an AG-UI stream. Bring a lowering layer (`@reinsjs/lowering-pi`) and, optionally, the brain (`@reinsjs/brain`) and a store (`@reinsjs/store-sqlite`, `@reinsjs/store-pg`).

```bash
pnpm add reins @reinsjs/lowering-pi @reinsjs/brain
```

```ts
import { anthropic } from "@reinsjs/lowering-pi"
import { approval, compact, perception } from "@reinsjs/brain"
import { createAgent, defineTool, memoryStore } from "reins"

const deploy = defineTool<{ env: "staging" | "prod" }>({
  name: "deploy",
  description: "Ship the current build",
  inputSchema: { type: "object", properties: { env: { type: "string", enum: ["staging", "prod"] } }, required: ["env"] },
  needsApproval: true,
  execute: ({ env }) => `deployed to ${env}`,
})

export const agent = createAgent({
  model: anthropic("claude-opus-5", { apiKey: process.env.ANTHROPIC_API_KEY! }),
  tools: [deploy],
  store: memoryStore(),                 // sqliteStores(...) / pgStores(...) for anything real
  sockets: [perception(), compact(), approval()],
  systemPrompt: "Be brief and direct.",
  secret: process.env.REINS_SECRET,     // signs the pause state so it can round-trip through a client
})

export const POST = agent.handler        // (Request) => Promise<Response>, AG-UI over SSE
```

Without HTTP:

```ts
for await (const event of agent.run({ input: "Ship staging" })) console.log(event.type)
```

`run()` yields every event as it is appended and returns `done | paused | handoff | error`. A `paused` result carries a small signed `state`; resume from any process with `agent.run({ sessionId, resume: state, decisions: [{ toolCallId, approved: true, by: "alice" }] })`.

## Agents as tools

```ts
import { asTool } from "reins"

const lead = createAgent({
  model, store,
  tools: [
    asTool(analyst, { name: "ask_analyst", description: "Ask the inventory analyst. Give a self-contained question." }),
    asTool(writer,  { name: "ask_writer",  description: "Ask the copywriter for customer-facing copy.", abort: "detached" }),
  ],
  sockets: [approval(), budget({ limits: { totalTokens: 500_000 } })],
})
```

Whether to call an expert, what to ask, and whether to trust the answer are the parent model's decisions; there is no orchestrator. `asTool` handles what a hand-rolled wrapper gets wrong: when the child pauses for approval the **parent pauses too** (`Interruption { kind: "subagent" }` carries the child's interruptions), the host answers with `decisions: [{ toolCallId, sessionId: childSessionId, approved, by }]`, and the child's tokens count against the parent's budget. `examples/team` in the repository is a complete three-role setup on Postgres.

## What you get for free

- An append-only timeline you can replay, fork and audit — the model reads what actually happened, in order.
- A loop of a few hundred lines you can read and copy, with pause/resume as a return value.
- Brain modules that let the model tidy its own context, keep constraints, spill big results, remember, ask before dangerous actions, and stop at a budget — each optional, each measured before it became a default.
- Fail-closed defaults: unknown events are rejected, forged approval decisions cannot enter through the input, sessions are `404` to anyone not explicitly authorized.

## Documentation

The design documents are in Chinese under `docs/` at the repository root: `docs/系统全景图.md` (overview), `docs/技术方案.md` (spec), `docs/DECISIONS.md` (why). Package READMEs are in English.

MIT © 2026 NewRate Limited.
