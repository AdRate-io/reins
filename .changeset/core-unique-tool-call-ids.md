---
"@reinsjs/core": patch
---

`runLoop` now keeps tool call ids unique within a session. When a provider or relay reuses an id from an earlier call (such as `call_0` on every turn) or sends an empty one, the call is logged under a fresh `reins_<id>` and the original goes into `payload.meta.originalToolCallId`. Before, the later call took over the earlier call's approval, denial or "already started" record. In practice it could run without approval, be rejected, or be reported as an unknown outcome without running.

The fresh id is built from `newId` and normalized to `^[A-Za-z0-9_-]{1,64}$`, so a custom `newId` cannot produce an id a provider rejects. Hosts that fill in client-tool results must use the `toolCallId` from the logged `core.tool_call` (or `run_paused.awaiting`). The TanStack adapter writes its own tool calls and does not rewrite ids.
