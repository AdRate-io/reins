---
"@reinsjs/core": patch
---

When a resumed run settles a pending call whose tool is no longer in the base tool table (for example a tool that a `beforeModel` patch added only for that turn), the model now gets `Tool not available on resume: <name> …` instead of `Unknown tool: <name>`. The call is still not executed. Tools that need approval or client execution should come from a Socket's static `tools`.
