---
"@reinsjs/server": patch
---

`nodeListener` (`@reinsjs/server/node`) now catches errors the handler passes up to the host, such as the run lease store being unreachable. Before, such an error was an unhandled rejection, and Node's default is to exit the process, cutting every running run and SSE stream. A thrown `Response` is written back as is; any other error gets `500 { "error": "internal_error" }` (details go to `console.error`, not to the client); a response body that fails mid-stream destroys the connection so the client reconnects and replays. A client that disconnects while still uploading the request body is not reported as an error: the handler is not called and nothing is logged.
