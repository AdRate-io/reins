---
"@reinsjs/server": minor
---

An array `input` in a `POST` body must now be a non-empty list of `text` / `image` parts, checked on every request (also those without `resume` / `decisions`). Requests that are now refused with `400`: empty arrays, arrays containing `tool_reference` parts, malformed parts, and arrays of event drafts. Content parts — in arrays and inside `user_message` / `tool_result` drafts — are rebuilt from their known fields, so extra fields never reach the loop.
