/**
 * 三组对照跑数（M2 E3）：同一批 fixture、同一个真模型，只换臂。
 *
 *   REINS_PROVIDER=deepseek node examples/eval/run.ts [--arms none,threshold,brain] [--fixtures a,b] [--repeats 3]
 *                                                     [--context-window 64000] [--out examples/eval/out/<run>] [--repeat-start 3]
 *
 * 每格（fixture × 臂 × 重复）跑完立刻落盘：`cells/<fixture>__<arm>__<n>.json`（指标、事实问答、状态）与同名 `.jsonl`（全链时间线，
 * 可用 examples/minimal/replay.ts 回放）。进程可以按臂拆开并行跑，也可以只补跑失败的格；最后用 `report.ts <out>` 汇总成报告与门禁。
 *
 * 套件（--suite）：
 * - adrate-patrol（缺省）：巡检降本三个 fixture，臂 none / threshold / brain / brain-lean / compact-only（下）
 * - tool-discovery（D1）：200 件工具找靶六个短任务，臂 eager（200 件全给）/ lazy（装 lazyTools：菜单 + tool_find）
 *
 * 臂：
 * - none：不装脑子，连 core 的阈值裁剪也拆掉（窗口装不下就报错，"不管"的真实代价）
 * - threshold：只有 core 缺省的阈值裁剪（PRD §7 门槛 2 的基线）
 * - brain：dogfood 同款全部脑子模块（感知、模型自决整理、pin、外溢 6k、记忆、交接、预算、审批）
 * - brain-lean：精简版（感知、模型自决整理、pin、外溢 16k、预算、审批；无记忆 / 交接）
 *
 * 模型密钥从仓库根 `模型API测试信息.md` 读（已 gitignore），与 examples/adrate/agent.ts 同源；ANTHROPIC_API_KEY 可覆盖。
 * REINS_PROVIDER：deepseek（缺省，官方 Chat Completions 直连）| deepseek-anthropic（DeepSeek 的 Anthropic 端口 + thinking 2048，0.1 门禁的配置，作对照）
 *               | deepseek-pi（同上配置但用 pi 版降级层，把降级层实现从对照里剥出来）| cloudflare（Cloudflare AI Gateway 透传官方 Anthropic，F0 体检 43/43，见 spikes/README.md 末节）
 *               | relay（Boss 的 Claude 中转，忠实直通官方 API，见 spikes/relay-check）| aireiter（会丢中途 system，只作参考）。
 * REINS_MODEL 覆盖模型 id（cloudflare / relay 缺省 claude-sonnet-5，可用 claude-opus-5）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { BoundModel, Event } from "@reinsjs/core"
import { approval, budget, compact, handoff, lazyTools, memory, perception, pins, spill } from "@reinsjs/brain"
import { type EvalArm, type EvalOutcome, noneArm, runEval, thresholdArm, toEventsJsonl } from "@reinsjs/eval"
import { anthropic, anthropicMessages, deepseek } from "@reinsjs/lowering-fetch"
import { adratePatrolFixtures, type PatrolWorld } from "./fixtures/adrate-patrol/fixture.ts"
import { toolDiscoveryFixtures } from "./fixtures/tool-discovery/fixture.ts"

// ---- 参数 ----
const argv = process.argv.slice(2)
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : dflt
}
type Suite = "adrate-patrol" | "tool-discovery"
const suiteName = flag("--suite", "adrate-patrol") as Suite
if (suiteName !== "adrate-patrol" && suiteName !== "tool-discovery") throw new Error(`未知的套件：${suiteName}`)
const armNames = flag("--arms", suiteName === "tool-discovery" ? "eager,lazy" : "none,threshold,brain").split(",")
const fixtureIds = flag("--fixtures", "").split(",").filter(Boolean)
const repeats = Number(flag("--repeats", "1"))
/** 补跑用：重复编号从几开始（如只补第 3 次：--repeats 1 --repeat-start 3） */
const repeatStart = Number(flag("--repeat-start", "1"))
const contextWindow = Number(flag("--context-window", "64000"))
type Provider = "aireiter" | "deepseek" | "deepseek-anthropic" | "deepseek-pi" | "relay" | "cloudflare"
const provider = (process.env.REINS_PROVIDER ?? "deepseek") as Provider
const DEFAULT_MODEL: Record<Provider, string> = {
  deepseek: "deepseek-v4-flash",
  "deepseek-anthropic": "deepseek-v4-flash",
  "deepseek-pi": "deepseek-v4-flash",
  aireiter: "claude-opus-5",
  relay: "claude-sonnet-5",
  cloudflare: "claude-sonnet-5",
}
const modelId = process.env.REINS_MODEL ?? DEFAULT_MODEL[provider]
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
const out = flag("--out", new URL(`./out/${stamp}-${modelId}`, import.meta.url).pathname)
mkdirSync(`${out}/cells`, { recursive: true })

// ---- 模型 ----
const INFO = new URL("../../模型API测试信息.md", import.meta.url)
function readKey(section: Exclude<Provider, "cloudflare" | "deepseek-anthropic" | "deepseek-pi">): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const info = readFileSync(INFO, "utf8")
  if (section === "relay") {
    // "Claude中转"段：key：sk-…  baseurl:http://…
    const block = info.slice(info.lastIndexOf("Claude中转"))
    const key = block.match(/key[：:]\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
    if (!key) throw new Error("没在 模型API测试信息.md 的 Claude中转 段找到 key")
    return key
  }
  const keys = [...info.matchAll(/密钥[^`]*`(sk-[^`]+)`/g)].map((m) => m[1] as string)
  const key = section === "aireiter" ? keys[0] : keys[1]
  if (!key) throw new Error(`没在 模型API测试信息.md 里找到 ${section} 的密钥；或设 ANTHROPIC_API_KEY`)
  return key
}
/** Cloudflare AI Gateway 透传路径：凭证在 cf-aig-authorization 头（auth: "none"），与 spikes/l1-deferred-tools/live.mjs 同一套读法 */
function cloudflareGateway(): { baseUrl: string; headers: Record<string, string> } {
  const info = readFileSync(INFO, "utf8")
  const token = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
  const account = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
  const gateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
  if (!token || !account) throw new Error("没在 模型API测试信息.md 里找到 Cloudflare AI Gateway 的令牌 / account id")
  return {
    baseUrl: `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/anthropic/v1`,
    headers: { "cf-aig-authorization": `Bearer ${token}` },
  }
}
/**
 * Cloudflare AI Gateway 的账户级限流（429 `Wholesale Rate limited`，CF 信封不是厂商错误体）恢复要几十秒，循环缺省的瞬断重试
 * （3 次、最长 8 s）等不到窗口；这里在 fetch 层多等一会再打，只对 429 生效、最多 6 次，等待 10 s × 次数。POST 无副作用，重发安全
 */
const patientFetch: typeof globalThis.fetch = async (input, init) => {
  for (let attempt = 1; ; attempt++) {
    const res = await globalThis.fetch(input, init)
    if (res.status !== 429 || attempt >= 6 || init?.signal?.aborted) return res
    await res.text().catch(() => "")
    console.log(`    429 from the gateway, waiting ${10 * attempt}s before retrying (${attempt}/6)`)
    await new Promise((r) => setTimeout(r, 10_000 * attempt))
  }
}
function relayBase(): string {
  const block = readFileSync(INFO, "utf8").slice(readFileSync(INFO, "utf8").lastIndexOf("Claude中转"))
  const base = block.match(/baseurl[：:]\s*(\S+)/)?.[1]?.replace(/\/+$/, "")
  if (!base) throw new Error("没在 模型API测试信息.md 的 Claude中转 段找到 baseurl")
  return base
}
/**
 * 降级层用 fetch 版（0.2 起示例统一）。DeepSeek 走官方 Chat Completions 直连（内置表有 deepseek-v4-flash，reasoning_content 方言缺省开、
 * 中途 system 任意位置）；relay / aireiter 走 Anthropic Messages 线：表外模型，baseUrl 给到协议根（其后接 /messages）、能力位手动声明。
 * cloudflare 是官方 Anthropic 的透传（内置表有型号，价目与能力位齐；凭证在头里、auth: "none"）；relay 忠实直通官方 API、接受紧跟 user 之后的
 * 中途 system（spikes/relay-check），感知 / pin 说明走 exact 落点；aireiter 会丢中途 system（spikes/aireiter-gateway-check），留 user 文本落点。
 * thinking 不在这里设：Sonnet 5 / Opus 5 厂商缺省 adaptive，DeepSeek 缺省就是 thinking 模式。
 */
const bound = await (async (): Promise<BoundModel> => {
  switch (provider) {
    case "deepseek-pi": {
      // 对照臂：0.1 门禁原样的降级层（pi 版）与配置，用来把"降级层实现"从 token 差里剥出来；只在要用时才加载 pi-ai
      const { anthropic: piAnthropic } = await import("@reinsjs/lowering-pi")
      return piAnthropic(modelId, {
        apiKey: readKey("deepseek"),
        baseUrl: "https://api.deepseek.com/anthropic",
        requestOptions: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
        midConversationSystem: true,
      })
    }
    case "deepseek":
      return deepseek(modelId, { apiKey: readKey("deepseek") })
    case "deepseek-anthropic":
      // 对照臂：与 0.1 门禁同一端口、同一 thinking 预算，只差降级层实现（fetch 版 Anthropic 线 vs pi 版）
      return anthropicMessages(modelId, {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: readKey("deepseek"),
        reasoning: true,
        images: true,
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        midConversationSystem: true,
        requestOptions: { thinking: { type: "enabled", budget_tokens: 2048 } },
      })
    case "cloudflare": {
      const cf = cloudflareGateway()
      return anthropic(modelId, { apiKey: "", auth: "none", baseUrl: cf.baseUrl, headers: cf.headers, fetch: patientFetch })
    }
    default:
      return anthropicMessages(modelId, {
        provider,
        baseUrl: provider === "relay" ? `${relayBase()}/v1` : "https://aireiter.com/api/v1",
        apiKey: readKey(provider),
        reasoning: true,
        images: true,
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        midConversationSystem: provider === "relay",
        // relay 是多账号池子，某个号额度满时回 429，换号靠重试；aireiter 不需要
        ...(provider === "relay" ? { fetch: patientFetch } : {}),
      })
  }
})()

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

/**
 * 只加整理与取回（E3c）：threshold 的 core 缺省链 + perception（整理规则引用它的读数）+ compact（含 recall）。
 * 用来把"整理 + 取回"的成本单独从 brain-lean 里剥出来看 —— brain-lean 的 token 差主要来自 approval 的分批暂停多出的轮次。
 */
function compactOnlyArm(): EvalArm {
  const limits = { toolCalls: 120, wallMs: 40 * 60_000 }
  return { name: "compact-only", sockets: [perception({ limits }), compact()] }
}

/** 工具发现两臂：同一批 200 件全标 lazy 的工具，只差装不装 lazyTools */
const discoveryArms: Record<string, EvalArm> = {
  eager: { name: "eager", sockets: [] },
  lazy: { name: "lazy", sockets: [lazyTools()] },
}
const { allFixtures, armsByName } = ((): { allFixtures: readonly import("@reinsjs/eval").EvalFixture[]; armsByName: Record<string, EvalArm> } => {
  if (suiteName === "tool-discovery") return { allFixtures: toolDiscoveryFixtures().fixtures, armsByName: discoveryArms }
  const suite = adratePatrolFixtures({ contextWindow })
  return {
    allFixtures: suite.fixtures,
    armsByName: {
      none: noneArm(),
      threshold: thresholdArm(),
      brain: brainArm(suite.world),
      "brain-lean": brainLeanArm(suite.world),
      "compact-only": compactOnlyArm(),
    },
  }
})()
const fixtures = fixtureIds.length ? allFixtures.filter((f) => fixtureIds.includes(f.id)) : allFixtures
if (fixtures.length === 0) throw new Error(`没有匹配的 fixture：${fixtureIds.join(",")}`)
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
