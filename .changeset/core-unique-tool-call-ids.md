---
"@reinsjs/core": patch
---

`runLoop` now keeps tool call ids unique within a session. When a provider or relay reuses an id from an earlier call (such as `call_0` on every turn) or sends an empty one, the call is logged under a fresh `reins_<id>` and the original goes into `payload.meta.originalToolCallId`. Before, the later call took over the earlier call's approval, denial or "already started" record. In practice it could run without approval, be rejected, or be reported as an unknown outcome without running.
