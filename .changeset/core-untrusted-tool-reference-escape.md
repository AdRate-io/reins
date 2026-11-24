---
"@reinsjs/core": patch
---

`markUntrusted` now escapes `tool_reference` parts too. An untrusted tool result's reference is expanded into text inside the `<untrusted>` wrapper, but its name, description and input schema were passed through as is, so a description containing `</untrusted>` closed the wrapper early and the rest read as trusted text. Every string in the reference (schema keys included) now gets the same `<\/untrusted` escape as text parts, and the result reports `escaped`, so the lowering layers record the landing as lossy. References that need no escaping are returned unchanged.
