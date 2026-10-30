---
"@reinsjs/core": minor
"@reinsjs/brain": patch
---

core: the projection's threshold fallback now compares the calibrated context size — the estimate plus the fixed overhead the estimate cannot see (system prompt, tool definitions, thinking), measured from the last `budget_usage` — against `contextLimit - reserveTokens`. Before, it compared the raw estimate, so perception could report "≥85%, the harness auto-folds at 85%" while no fold happened, and a system prompt plus tool table larger than the reserve could overflow the window before the fallback ever fired. `contextOverheadOf` moves to core (brain still re-exports it); `ProjectionStats.overheadTokens` is new; `project({ budget: { overheadTokens: 0 } })` restores the old comparison. The fallback now fires earlier by that overhead, and `reserveTokens` is effectively the output reserve.
