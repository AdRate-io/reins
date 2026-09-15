---
"@reinsjs/tools-mcp": minor
---

`httpTransport({ auth })` for credentials that expire. `headers` is fixed when the transport is built, but the connection is created lazily, reused across runs and rebuilt from the same recipe after a drop — so an expiring token cannot live there. `auth.token()` is called before every request and `auth.onUnauthorized()` on a 401, after which the request is retried once. Passing both `auth` and an `Authorization` header throws at construction time instead of letting one silently win.

`McpAuth` is two methods and references no MCP SDK type. It is deliberately not the SDK's `OAuthClientProvider`: that interface's core value is driving a browser authorization prompt, which a server-side agent cannot do. Obtain the tokens in your application and hand them over; call the SDK's `refreshAuthorization` from inside `onUnauthorized` if you want it.

README additions: "Expiring credentials", and "Gateway-style servers" — a warning that servers routing hundreds of operations through a single dispatching tool (TikTok for Business's `tool_execute` is the current example) silently defeat approval policies written against tool names, with the recipe for deciding on the operation name inside the arguments instead. The executable version is `packages/brain/src/gateway-tool.recipe.test.ts`, whose first case proves a name-based `deny` rule lets a delete through.
