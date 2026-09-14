# @reinsjs/adapter-tanstack-ai

Run the [reins](../../README.md) brain inside [TanStack AI](https://tanstack.com/ai)'s `chat()` as a middleware. TanStack drives the loop, executes tools and handles interrupts; reins keeps the event log as the single source of truth, projects it into what the model sees on every turn, and runs its brain modules (compaction, pins, spill, memory, approval, budget, perception) on TanStack's hooks.

```bash
pnpm add @reinsjs/adapter-tanstack-ai @tanstack/ai@0.53.0
```

```ts
import { reinsApprovalInterrupt, reinsMiddleware } from "@reinsjs/adapter-tanstack-ai"
import { approval, compact, perception, spill } from "@reinsjs/brain"
import { chat } from "@tanstack/ai"

const stream = chat({
  adapter,
  messages,
  tools,
  systemPrompts: ["You are…"],
  middleware: [
    reinsMiddleware({
      sessionId,
      log: store.log,
      blobs: store.blobs,
      sockets: [perception(), compact(), spill(), approval({ ask: ["deploy"] })],
      capabilities: { contextWindow: 200_000 },   // TanStack does not tell middleware how big the window is
    }),
  ],
  interrupts: [reinsApprovalInterrupt],            // required: dynamic approvals are a generic interrupt
})
```

## What the middleware does

- **`onConfig(init)`** reads the log (fail-closed on unknown events), merges the brain's static tools and prompt fragment, and imports the client's new user messages. Import is idempotent: a network retry that re-sends the same request does not write the message twice (key = message `id` if present, else its position in the client array, plus exact content).
- **`onConfig(beforeModel)`** replaces `providerMessages` with the projection of the log — TanStack's own `messages` array only serves the UI.
- **`onChunk` / `onUsage`** append the model's blocks and a `budget_usage` event.
- **`onInterruptBoundary(beforeTools)`** runs the socket pipeline for every pending call; a `defer` becomes a `reinsApprovalInterrupt` so the run pauses and the client resumes it with `resume`. `onInterruptResolution` records the answer as `approval_decision`.
- **`onAfterToolCall` / `onToolPhaseComplete`** append results, including the ones TanStack handled itself (native `needsApproval`, client-side tools).

## Boundaries you should know

- **Register the interrupt.** If `reinsApprovalInterrupt` is missing from `chat({ interrupts })`, the type layer complains; at run time the middleware also checks the engine's registry, warns once, and treats every call that would need approval as **denied** (an `approval_decision` with `by: "reins"` is left in the log) instead of letting the engine throw mid-run.
- **`defer` pauses the whole tool batch**, not just the call that needs approval — that is where TanStack's boundary sits.
- **No `system` role.** `system_note` events travel as a framed `user` message and are declared lossy; thinking is replayed only with a same-provider signature. The complete table is `TANSTACK_LOSS_MATRIX`.
- **Sub-agent pause bubbling (`asTool`) is not available here.** A tool returning `subagentPause` is reported to the model as an error; the child session stays paused and can be resumed by the host.
- `@tanstack/ai` is pinned to an exact version because the middleware relies on hook contracts read from its source.

## Documentation

`docs/模块盘点/adapter-tanstack-ai.md` and `docs/技术方案.md` §2 / §11 — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
