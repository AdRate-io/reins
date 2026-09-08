/**
 * 三组对照跑数（M2 E3）：同一批 fixture、同一个真模型，只换臂。
 *
 *   REINS_PROVIDER=deepseek node examples/eval/run.ts [--arms none,threshold,brain] [--fixtures a,b] [--repeats 3]
 *                                                     [--context-window 64000] [--out examples/eval/out/<run>] [--repeat-start 3]
 *
 * 每格（fixture × 臂 × 重复）跑完立刻落盘：`cells/<fixture>__<arm>__<n>.json`（指标、事实问答、状态）与同名 `.jsonl`（全链时间线，
 * 可用 examples/minimal/replay.ts 回放）。进程可以按臂拆开并行跑，也可以只补跑失败的格；最后用 `report.ts <out>` 汇总成报告与门禁。
 *
 * 臂：
 * - none：不装脑子，连 core 的阈值裁剪也拆掉（窗口装不下就报错，"不管"的真实代价）
 * - threshold：只有 core 缺省的阈值裁剪（PRD §7 门槛 2 的基线）
 * - brain：dogfood 同款全部脑子模块（感知、模型自决整理、pin、外溢 6k、记忆、交接、预算、审批）
 * - brain-lean：精简版（感知、模型自决整理、pin、外溢 16k、预算、审批；无记忆 / 交接）
 *
 * 模型密钥从仓库根 `模型API测试信息.md` 读（已 gitignore），与 examples/adrate/agent.ts 同源；ANTHROPIC_API_KEY 可覆盖。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { Event } from "@reins/core"
import { approval, budget, compact, handoff, memory, perception, pins, spill } from "@reins/brain"
import { type EvalArm, type EvalOutcome, noneArm, runEval, thresholdArm, toEventsJsonl } from "@reins/eval"
import { anthropic } from "@reins/lowering-pi"
import { adratePatrolFixtures, type PatrolWorld } from "./fixtures/adrate-patrol/fixture.ts"

// ---- 参数 ----
const argv = process.argv.slice(2)
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : dflt
}
const armNames = flag("--arms", "none,threshold,brain").split(",")
const fixtureIds = flag("--fixtures", "").split(",").filter(Boolean)
const repeats = Number(flag("--repeats", "1"))
/** 补跑用：重复编号从几开始（如只补第 3 次：--repeats 1 --repeat-start 3） */
const repeatStart = Number(flag("--repeat-start", "1"))
const contextWindow = Number(flag("--context-window", "64000"))
const provider = (process.env.REINS_PROVIDER ?? "deepseek") as "aireiter" | "deepseek"
const modelId = process.env.REINS_MODEL ?? (provider === "deepseek" ? "deepseek-v4-flash" : "claude-opus-5")
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
const out = flag("--out", new URL(`./out/${stamp}-${modelId}`, import.meta.url).pathname)
mkdirSync(`${out}/cells`, { recursive: true })

// ---- 模型 ----
function readKey(section: "aireiter" | "deepseek"): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
  const keys = [...info.matchAll(/密钥[^`]*`(sk-[^`]+)`/g)].map((m) => m[1] as string)
  const key = section === "aireiter" ? keys[0] : keys[1]
  if (!key) throw new Error(`没在 模型API测试信息.md 里找到 ${section} 的密钥；或设 ANTHROPIC_API_KEY`)
  return key
}
const bound = anthropic(modelId, {
  apiKey: readKey(provider),
  baseUrl: provider === "deepseek" ? "https://api.deepseek.com/anthropic" : "https://aireiter.com/api",
  requestOptions: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
  ...(provider === "deepseek" ? { midConversationSystem: true } : {}),
})

// ---- 臂 ----
/** dogfood（examples/adrate/agent.ts）同款配置；pin 的文本按脱敏后的广告主 id */
function brainArm(world: PatrolWorld): EvalArm {
  const limits = { toolCalls: 120, wallMs: 40 * 60_000 }
  return {
    name: "brain",
    sockets: [
      perception({ limits }),
      compact(),
      pins({ pins: [{ name: "advertiser", text: `本任务只操作测试广告主 ${world.advertiserId}（可随意写，不会投出去）。` }] }),
      spill({ maxResultTokens: 6000, previewLines: 12 }),
      memory(),
      handoff(),
      budget({ limits: { ...limits, totalTokens: 4_000_000 } }),
      approval({ unmatched: "byRisk" }),
    ],
  }
}

/**
 * 精简配置：E3 第一轮发现 spill 阈值 6k 把模型必须整读的 10k token 列表外溢出去、再用 fetch_blob 分两三次取回，
 * 平白多两三轮；memory 每次运行额外写 1~4 次文件。这一臂把外溢阈值提到 16k、去掉 memory / handoff，看差别。
 */
function brainLeanArm(world: PatrolWorld): EvalArm {
  const limits = { toolCalls: 120, wallMs: 40 * 60_000 }
  return {
    name: "brain-lean",
    sockets: [
      perception({ limits }),
      compact(),
      pins({ pins: [{ name: "advertiser", text: `本任务只操作测试广告主 ${world.advertiserId}（可随意写，不会投出去）。` }] }),
      spill({ maxResultTokens: 16_000, previewLines: 12 }),
      budget({ limits: { ...limits, totalTokens: 4_000_000 } }),
      approval({ unmatched: "byRisk" }),
    ],
  }
}

const suite = adratePatrolFixtures({ contextWindow })
const fixtures = fixtureIds.length ? suite.fixtures.filter((f) => fixtureIds.includes(f.id)) : suite.fixtures
if (fixtures.length === 0) throw new Error(`没有匹配的 fixture：${fixtureIds.join(",")}`)
const armsByName: Record<string, EvalArm> = {
  none: noneArm(),
  threshold: thresholdArm(),
  brain: brainArm(suite.world),
  "brain-lean": brainLeanArm(suite.world),
}
const arms = armNames.map((n) => {
  const a = armsByName[n]
  if (!a) throw new Error(`未知的臂：${n}`)
  return a
})

// ---- 进度 ----
const cellKey = (c: { fixtureId: string; arm: string; repeat: number }) => `${c.fixtureId}__${c.arm}__${c.repeat}`
const timelines = new Map<string, Event[]>()
/** 探针会话的事件（按格），落成 cells/<key>.probes.jsonl 便于排查探针为什么没答上 */
const probes = new Map<string, Event[]>()
let current = ""
let turn = 0
const oneLine = (s: string, max = 90) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)

console.log(`模型 ${bound.model.provider}/${bound.model.id}（${provider}）  窗口 ${contextWindow}  臂 ${armNames.join(",")}  fixture ${fixtures.map((f) => f.id).join(",")}  重复 ${repeats}`)
console.log(`输出 ${out}\n`)

const report = await runEval({
  fixtures,
  arms,
  lowering: bound.lowering,
  model: bound.model,
  repeats,
  repeatStart,
  onEvent(e, cell) {
    const key = cellKey(cell)
    if (cell.probe) {
      const list = probes.get(key) ?? []
      list.push(e)
      probes.set(key, list)
      if (e.type === "core.model_text") log(`    探针 ${cell.probe}: ${oneLine((e.payload as { text: string }).text, 70)}`)
      else if (e.type === "core.tool_call" || e.type === "core.run_error" || e.type === "core.run_paused")
        log(`    探针 ${cell.probe} ${e.type.replace("core.", "")}: ${oneLine(JSON.stringify(e.payload), 160)}`)
      return
    }
    if (key !== current) {
      current = key
      turn = 0
      log(`▶ ${key}`)
    }
    const list = timelines.get(key) ?? []
    list.push(e)
    timelines.set(key, list)
    const p = e.payload as Record<string, unknown>
    switch (e.type) {
      case "core.tool_call":
        log(`    → ${p.name} ${oneLine(JSON.stringify(p.args), 60)}`)
        break
      case "core.tool_result":
        if (p.isError) log(`    ✗ ${p.name}: ${oneLine(JSON.stringify(p.content), 80)}`)
        break
      case "core.model_text":
        log(`    💬 ${oneLine(String(p.text))}`)
        break
      case "core.compaction":
        log(`    ⟲ 整理 by ${String((p as { decidedBy?: string }).decidedBy ?? "?")}`)
        break
      case "core.budget_usage": {
        turn++
        const t = p.tokens as { input: number; output: number; cacheRead?: number }
        log(`    轮 ${turn}  in ${t.input} + cache ${t.cacheRead ?? 0} / out ${t.output}`)
        break
      }
      case "core.run_paused":
        log(`    ⏸ ${String(p.reason)}`)
        break
      case "core.run_error":
        log(`    ❌ ${oneLine(JSON.stringify(p), 200)}`)
        break
      case "core.handoff":
        log("    ↪ 交接到新会话")
        break
    }
  },
  onOutcome(o: EvalOutcome) {
    const key = cellKey(o)
    const m = o.metrics
    log(
      `■ ${key}  ${m.status}  完成 ${m.completed.toFixed(2)}  召回 ${m.recall?.toFixed(2) ?? "—"}  token ${m.tokens.total}（cache ${((m.cacheHitRate ?? 0) * 100).toFixed(0)}%）  轮 ${m.turns}  工具 ${m.toolCalls}（错 ${m.toolErrors}，重复 ${m.repeatedToolCalls}）  整理 ${m.compactions.model}/${m.compactions.threshold}  违规 ${m.violations.before.violations}/${m.violations.after.violations}  ${(m.wallMs / 1000).toFixed(0)}s\n`,
    )
    const { timelines: _t, timeline: _tl, fresh: _f, ...slim } = o
    writeFileSync(`${out}/cells/${key}.json`, JSON.stringify({ ...slim, model: bound.model, contextWindow }, null, 2))
    writeFileSync(`${out}/cells/${key}.jsonl`, toEventsJsonl(o.timeline))
    writeFileSync(`${out}/cells/${key}.probes.jsonl`, toEventsJsonl(probes.get(key) ?? []))
  },
})

writeFileSync(`${out}/run-${armNames.join("-")}.json`, JSON.stringify({ ...report, outcomes: report.outcomes.map(({ timelines: _t, timeline: _tl, fresh: _f, ...o }) => o) }, null, 2))
console.log(`\n完成 ${report.outcomes.length} 格 → ${out}；汇总：node examples/eval/report.ts ${out}`)
