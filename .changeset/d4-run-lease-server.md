---
"@reinsjs/server": minor
---

`RunRegistry` is now an interface (`get(sessionId)`, `create(sessionId, controller?): Promise<ActiveRun>`); the previous class is renamed `InMemoryRunRegistry` and stays the default. New `leasedRunRegistry(lease, { ttlMs = 30_000, owner, warn })` wraps it with a `RunLease` from the store so a second `POST` on a session that is running on *another* instance answers `409 run_in_progress` instead of wasting a model call: the lease is acquired before the run starts, renewed every `ttlMs / 3`, and released when the run ends; a lost lease aborts the run into `paused(host)`; failed renewals and releases only warn. `GET` still joins runs of this process only. `ActiveRun` gains `onFinish(fn)`; `done` now resolves after those hooks settle so a Worker's `waitUntil` covers the release. Breaking for custom registries and direct callers: `create` is async.
