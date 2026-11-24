---
"@reinsjs/brain": patch
---

`compact({ recall: false })`: the default rules, the `compact` tool description and the manifest headings no longer tell the model to use `recall({ seq })`, which it does not have; the manifest is still listed, headed "still in the session log, by seq". New exports `compactToolDescription(recall)`, `COMPACT_RECALL_RULE`, `COMPACT_NO_RECALL_RULE`, `MANIFEST_HEADING_NO_RECALL` and `MEDIA_MANIFEST_HEADING_NO_RECALL`; `renderCompactionSummary` and `planCompaction` take an optional `recall` flag (default `true`, output unchanged).
