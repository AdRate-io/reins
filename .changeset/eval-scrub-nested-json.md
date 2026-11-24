---
"@reinsjs/eval": minor
---

`scrubEvents` now also replaces values that sit inside a JSON string in a tool result's text (an envelope tool returning its whole response as text), where quotes and backslashes are escaped twice. A name such as `Shop "A"` used to be replaced in model text but left verbatim in the tool result. New export `scrubForms(value)` lists every form a value can take in an event's JSON text, so a "nothing left" self-check can look for all of them; checking for the raw value alone can never find a value that contains a quote or backslash.
