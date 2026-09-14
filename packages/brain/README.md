# @reinsjs/brain

Pre-packaged driving experience for [reins](../../README.md) agents: nine `Socket` modules that make a model good at long tasks — seeing its own context, tidying it, keeping constraints, spilling large results, handing off, remembering, asking before dangerous actions, stopping at a budget, and reading the host's skills when a task calls for them. Each module is optional, individually configurable, and only depends on the contracts in `@reinsjs/core`. None of them decides *for* the model; they let it see, give it means, set bounds, and leave a record.

```bash
pnpm add @reinsjs/brain
```

```ts
import { approval, budget, compact, memory, perception, pins, skills, spill } from "@reinsjs/brain"
import { fsSkillSource } from "@reinsjs/brain/node"
import { createAgent } from "@reinsjs/agent"

const agent = createAgent({
  model,
  store,
  tools,
  sockets: [
    perception(),                       // "you have used 61% of your context" — as a note, not an action
    compact(),                          // a `compact` tool the model calls when it decides to tidy
    pins({ host: ["Never touch prod without approval"] }),
    spill(),                            // big tool results go to the BlobStore; the model gets a preview + fetch_blob
    memory({ namespace: () => "/roles/analyst" }),
    // a menu of SKILL.md names in the prompt; the model reads one with skill_read.
    // fsSkillSource resolves relative paths against process.cwd(): pass an absolute path
    skills({ source: fsSkillSource(new URL("./skills", import.meta.url).pathname) }),
    budget({ limits: { turns: 30, totalTokens: 400_000 } }),
    approval({ ask: ["deploy", "delete_*"] }),   // keep approval last: it judges the input other sockets may have rewritten
  ],
})
```

## The modules

| module | what the model gets | what it costs you |
| --- | --- | --- |
| `perception()` | A `system_note` at the end of the timeline with context usage, history length and budget headroom, in coarse tiers so it does not change every turn (cache-friendly). Calibrated against the last real `budget_usage`. | nothing |
| `compact()` | A `compact` tool: the model summarizes a range of old turns itself; the summary carries a manifest of the folded tool results and a `recall({ seq })` tool fetches any of them back verbatim. A threshold fallback folds the oldest turns when the projection would overflow. **Recommended on** since 2026-09-10: measured on DeepSeek and Claude, recall stayed at 100% while tokens went down. | a `BlobStore` is not required |
| `pins()` | Host-declared constraints (static text or extracted from the conversation) plus a `pin` tool. Pinned notes survive compaction and are re-injected when they scroll out. | nothing |
| `spill()` | Tool results above a size limit are stored whole in the `BlobStore`; the model sees head + tail + a blob id and pages through with `fetch_blob`. Without a `BlobStore` the module warns once and passes results through unchanged (no silent truncation). | a `BlobStore` |
| `handoff()` | A `handoff` tool: the model writes a summary and next steps and moves to a fresh session; visible pins travel along. The mechanics (new session, opening note) are in the core loop. **Off by default** — turn it on when tasks routinely outlive one context window. | host must rebind the UI to the new session (`onHandoff`) |
| `memory()` | A `memory` tool shaped like Anthropic's `memory_20250818` (view / create / str_replace / insert / delete / rename under `/memories`). Every operation leaves a `memory_op` event. Isolation is by `namespace`, invisible to the model. **Off by default.** | a `MemoryStore` |
| `approval()` | A deny → ask → allow policy pipeline in `beforeTool`. `deny` leaves an `approval_decision` and blocks; `ask` pauses the run for a human; `allow` leaves no event. Default policy `byRisk`: tools without a declared `risk` are treated as medium and **ask** — mark read-only tools `risk: "low"`. Policy evaluation errors deny (fail-closed). | nothing |
| `budget()` | Five limits — `contextTokens`, `totalTokens`, `turns`, `toolCalls`, `wallMs` — checked in `onTurnEnd`. Hitting one while the model wants to continue pauses the run with `reason: "budget"`; resuming starts a fresh run budget. `totalTokens` includes what sub-agents spent through `asTool`. | nothing |
| `skills()` | [Agent Skills](https://agentskills.io) with progressive disclosure: the system prompt carries only a menu (each `SKILL.md`'s `name` + `description`); the model reads a skill, or one of its supporting files, with `skill_read({ name, path?, range? })`, and the text lands in the timeline as a `tool_result` — so compaction, `recall` and spill apply to it unchanged. Skills are host-authored, so `skill_read` results are trusted like the system prompt (no `<untrusted>` marker). Skills that fail the spec (bad `name`, missing `description`) are skipped with one warning; no `source`, no valid skill, or a host tool already named `skill_read` means nothing is registered (one warning). **Opt-in**: give it a `source`. | a `SkillSource` — the read-only half of any `MemoryStore` (see below), `fsSkillSource(dir)` from `@reinsjs/brain/node` for a folder of `<name>/SKILL.md`, or `inlineSkills({ "code-review": "---\nname: code-review\ndescription: How we review PRs.\n---\n\n1. …" })` for bundled strings (Workers) — the object key must equal the frontmatter `name` |

### Skills from a database

Any `MemoryStore` (in-memory, `@reinsjs/store-sqlite`, `@reinsjs/store-pg`) is also a `SkillSource`: write `/skills/<name>/SKILL.md` (frontmatter with `name` equal to `<name>` and a `description`) and, optionally, `/skills/<name>/<file>` for supporting files, then pass the same store as `source`. The model's `memory` tool only reaches `/memories`, so one table holds writable private notes and read-only shared skills at once; `memory({ namespace })` prefixes apply to memories only, skills are shared by every principal. `skills()` refuses a `root` that overlaps `/memories` — a skill the model could write itself must never be trusted like the system prompt.

## Things that are deliberate

- **Sockets run in order, and order matters.** `approval()` belongs last so it judges the arguments after any `rewrite`; `perception()` appends its note at the end of the visible events so the model reads it last.
- **Nothing is hidden from the log.** A note the model sees, a summary it wrote, a memory it changed — each is an event you can replay.
- **Defaults come from measurements, not taste.** `compact` is recommended-on and `memory` / `handoff` are off because `examples/eval` says so. If you change a default, rerun the eval.
- **Skills are read, not executed.** A skill's `scripts/` are not run by the library — a child process would break the zero-Node-builtins rule of `@reinsjs/brain` — expose what a skill needs as ordinary tools. Only `@reinsjs/brain/node` touches the file system.
- **The skill menu is part of the run's config hash.** The menu is read once when a run starts and stays fixed for that run. Adding, removing or renaming a skill (or editing its `description`) while a run is paused makes the resume fail as config drift — editing a skill's *body* does not. Deploy skill changes between runs, or pass `allowConfigDrift`. With `rules: false` the menu is not contributed at all, so this protection is gone unless your own system prompt carries the menu.
- **Skills are trusted because you wrote them.** `skill_read` results carry `trust: "system"` and skip the `<untrusted>` marker, so whatever fills the source (a folder you deploy, a database row, a CLI's `skills read` output) is trusted like your system prompt. Do not give the model a tool that can write into the skill source. A skill body brought back later by `recall` or `fetch_blob` is `untrusted` again — deliberate, conservative.
- **Exports beyond this table** (`loadSkillMenu`, `parseSkillMarkdown`, `parseMemoryCommand`, `previewOf`, …) exist for hosts that replace a module's prompt or tool. They follow semver but are documented only in the type declarations.
- **Compaction never makes information unreachable.** Early runs showed models refusing to answer once they saw "this was summarized", even when the detail was still visible. Attaching the manifest and giving them `recall` fixed it; removing the manifest requires rewriting the rules text too, or the prompt lies.

## Documentation

`docs/技术方案.md` §9 (module specs and measurements), `docs/模块盘点/brain.md` (file map), `docs/踩坑记录.md` (pitfalls) — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
