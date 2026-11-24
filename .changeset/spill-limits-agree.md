---
"@reinsjs/brain": patch
---

`spill()`: the first-slice `end` suggested in a spill notice is now what one `fetch_blob` call can return (the smaller of the tool's `resultPolicy.maxTokens` and `maxResultTokens`), so following it is never clipped; and the default `previewChars` is derived from the tool's effective limit instead of the module-wide one, so a tool with a small limit no longer gets a preview larger than that limit.
