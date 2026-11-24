---
"@reinsjs/brain": minor
---

`memory()`: the value returned by `namespace(ctx)` is now validated before every call. It must be `""` or a canonical path (leading `/`, no trailing `/`, no empty, `.`, `..` or `memories` segments); otherwise the call fails with `isError`, touches no keys, and `warn` reports the value once. Previously any string was used as-is, so prefixes such as `/a` and `/a/memories/x` could nest and let one principal read and write the other's memories.
