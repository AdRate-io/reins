---
"@reinsjs/core": minor
---

Deferred tool loading, the provider-native path for `lazyTools()`:

- `ContentPart` gains a `tool_reference` member — `{ type: "tool_reference", name, description, inputSchema }`, a tool definition carried as content (with a full snapshot, so the log stays self-contained). `renderToolReference(part)` is the one way to render it as text; `normalizeToolOutput` accepts it in tool results.
- `ToolSpec.deferLoading?: boolean` — a tool that is declared to the provider but not loaded into the model's context until a `tool_reference` to it appears in the history.
- `LoweringCapabilities.deferredTools: boolean` (required; every lowering must declare it) — whether the wire protocol has a native place for both of the above.
- `BeforeModelPatch.deferredTools?: string[]` — a socket names which tools of this turn's table are deferred; `runLoop` translates it through the new `deferredToolSpecOf(tool, deferred)`. `toolSpecOf` keeps its single parameter on purpose (it is commonly passed to `map`).

Projection estimates count a reference as its rendered text. Hosts implementing their own `Lowering` must add `deferredTools: false` to their capabilities.
