---
"@reinsjs/tools-mcp": patch
---

README: a recipe for large flat tool tables (TikTok's 377-tool endpoint) — `override` keeps only `readOnlyHint` tools and marks them `lazy: true` for `@reinsjs/brain`'s `lazyTools()`, plus a `withBusinessErrors` wrapper that turns `{"code": <non-zero>}` envelopes returned as successful results into `isError` results. Executable version in `src/readonly-lazy.recipe.test.ts`. No code changes.
