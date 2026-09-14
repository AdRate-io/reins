# @reins/eval

The eval harness [reins](../../README.md) uses to decide its own defaults with numbers instead of taste. Real sessions become fixtures; recorded tools replay deterministically so every arm faces the same world; arms (a baseline, a threshold-only fallback, or a full brain configuration) run side by side on real models; metrics come straight from the timelines; a gate says pass or fail.

```bash
pnpm add -D @reins/eval
```

```ts
import { compact, perception } from "@reins/brain"
import { checkGate, noneArm, renderReport, runEval, thresholdArm, withContextWindow } from "@reins/eval"
import { anthropic } from "@reins/lowering-pi"

const bound = anthropic("claude-sonnet-5", { apiKey: process.env.ANTHROPIC_API_KEY ?? "" })

const report = await runEval({
  fixtures,                                 // EvalFixture[]: seed log + task + graders (+ `maxResumes`, default 0: a budget pause counts as "did not finish"); see `recording.ts` for turning a real JSONL into one
  arms: [noneArm(), thresholdArm(), { name: "compact", sockets: [compact(), perception()] }],
  lowering: withContextWindow(bound.lowering, 32_000),   // shrink what the mechanisms *believe* the window is
  model: bound.model,
  repeats: 3,
})
console.log(renderReport(report))
const gate = checkGate(report, { candidate: "compact", reference: "threshold" })
```

The reference CLI is `examples/eval/run.ts` in the repository; copy from it rather than from memory.

## Pieces

| module | what |
| --- | --- |
| `jsonl` | read/write event JSONL; reading goes through the schema registry (unknown or unupgradable events fail loudly) |
| `recording` | turn a real recording into fixture material: re-attach spilled blobs, redact deterministically |
| `recorded-tools` | tools that answer from the recording so arms compare like with like |
| `metrics` | pure functions over a timeline: tokens and cache hits, turns / tool calls / duplicate calls, compaction count and streaks, governance decay windows |
| `arms` | `noneArm`, `thresholdArm`, `withCapabilities` / `withContextWindow` lowering wrappers; brain-driven arms are assembled by the caller from `@reins/brain` |
| `runner` | fixture × arm × repeat runner with approval auto-answering, budget resumes, handoff following and a forked probe question at the end |
| `gate` | the four hard rules from the PRD (§7 threshold 2 / P8): recall, token cost, governance, no regressions |
| `report` | Markdown tables |

Zero `node:*`: file I/O and the CLI live in the caller (`examples/eval` in the repository is the reference CLI and holds the fixtures reins itself is measured on).

## Read the numbers correctly

- `withContextWindow` changes only what the mechanisms are told; the real window is untouched. It measures *how the mechanism behaves in a narrow window*, not *what overflow does*.
- The probe question keeps brain tools (an arm with `compact` can `recall`, one with `spill` can `fetch_blob`) and drops host tools — so the recall cell is intentionally not the same exam for a baseline arm.
- The governance rule compares the candidate against itself before and after its first compaction; two of the four gate rules can pass on "no information".
- Behavioural defects only show on real models. Scripted lowerings prove mechanics, not that a model will use them.

## Documentation

`docs/技术方案.md` §13, `docs/模块盘点/eval.md`, the E1–E4 reports under `docs/归档/` — in Chinese.

MIT © 2026 NewRate Limited.
