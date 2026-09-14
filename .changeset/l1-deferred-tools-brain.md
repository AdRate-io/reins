---
"@reinsjs/brain": minor
---

`lazyTools()` no longer costs a cache rewrite on lowerings that support deferred tools. When `capabilities.deferredTools` is true (`@reinsjs/lowering-fetch` on official Anthropic models) the socket sends the whole tool table on every request and marks the menu tools as deferred, so the tool list never changes; the `tool_find` result now carries one `tool_reference` content part per loaded tool (plus a one-line note and the not-listed names as text) which the provider expands in place. A tool whose loading turn has been compacted out of the current view is sent un-deferred so the model keeps seeing it. On other lowerings the behaviour is unchanged (the tool appears in the next request's list); `renderLoadedTool` now renders the reference through core's `renderToolReference`. Calling a listed-but-unloaded tool is still blocked, on both paths. Public interface of `lazyTools()` unchanged.
