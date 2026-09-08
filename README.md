# reins

**Hand the reins to the model.**

reins is an embeddable agent library. Install it, plug in your own model, and you get an agent that knows how to drive a long task: it sees its own context, decides when to tidy it, never loses the constraints you pinned, hands off to a fresh session with a proper summary, remembers what matters, and leaves a timeline you can replay and fork at any point.

The loop is a few hundred lines you can read and copy. Nothing is hidden. Every part is removable. The core runs on any runtime that speaks Web standards: Node, Bun, Deno, Cloudflare Workers, Vercel.

## Two principles

1. **Decisions default to the model.** The model is a capable colleague, not a process to be managed. The library does four things and nothing more: let it *see* (perception), give it *means* (tools), give it *bounds* (budgets, permissions, safety nets), and *record* everything (the timeline). It does not decide on the model's behalf.
2. **The timeline is the single source of truth; roles are a translation.** Everything that happens is one ordered timeline of events with an actor: user, model, tool, system, host. The model reads what actually happened, in order. Interrupting, inserting, changing your mind is just another event. Provider role formats are a lossy lowering at the edge, and every loss is declared.

## Status

Pre-alpha. Under construction. See `docs/` once published.

## Try it

```bash
pnpm install && pnpm build
ANTHROPIC_API_KEY=… node examples/minimal/server.ts   # then open http://localhost:8787
```

`examples/minimal/agent.ts` is the whole five-minute experience: one model, two tools (one needs approval), an in-memory store, and a Web-standard handler you can drop into any route.

## Packages

| package | what |
| --- | --- |
| `@reins/core` | event timeline, store interfaces, projection, loop, run state, socket |
| `@reins/brain` | perception, compact, pins, spill, handoff, memory, approval, budget |
| `@reins/lowering-pi` | provider lowering on top of pi-ai |
| `@reins/server` | Web-standard `(Request) => Response` handler, SSE, replay from `lastSeq`; `./node` adapter |
| `@reins/ui-agui` | timeline events → AG-UI protocol events; minimal demo page |
| `reins` | `createAgent()` plus re-exports of core / server / ui-agui |

## License

MIT
