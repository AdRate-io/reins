---
"@reinsjs/adapter-tanstack-ai": patch
---

`TANSTACK_LOSS_MATRIX` now declares every landing `toModelMessages` can report: host extension events under the wildcard key `"ext.*"` (dropped, same convention as `@reinsjs/lowering-pi`), and `core.tools_bound` (dropped as an operational event; it reaches the translator only when a `beforeModel` patch replaces the projected events). Before, both were reported to `onLandings` as dropped but had no entry in the table, so a host checking landings against it saw an undeclared type.
