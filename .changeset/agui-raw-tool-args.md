---
"@reinsjs/ui-agui": patch
---

`TOOL_CALL_ARGS` now carries a tool call's arguments as the model wrote them when the timeline stores them as a string (arguments that did not parse, kept as the raw wire text). Before, the string was JSON-encoded once more, so the client saw a quoted string literal such as `"{\"a\":1"` instead of `{"a":1`. Object arguments are unchanged.
