/**
 * 对照运行器：fixture × 臂 × 重复，每格独立的存储与会话，跑完整任务，再在分叉会话里问预埋事实，最后算指标。
 *
 * 一格的流程：
 * 1. 新存储（缺省内存）、新 sessionId；有种子历史就换 sessionId 后原样 append
 * 2. runLoop 跑任务：审批由 fixture.approve 代答后带 decisions 续跑；预算暂停按 maxResumes 续；handoff 跟到新会话；
 *    error / host / 客户端工具暂停就停（如实记 status）
 * 3. 探针：对每条预埋事实，从主会话末尾 fork 一条新会话，去掉宿主工具（脑子工具如 fetch_blob 保留），
 *    只问一个问题，取模型正文按 expect / judge 打分。fork 保证探针之间互不污染、也不污染主会话
 * 4. 指标 = 时间线纯函数 + 完成度 + 召回 + 墙钟
 *
 * 循环用的就是 core 的 runLoop，不做第二套；臂只是 LoopConfig 的一部分。
 */
import {
  type ApprovalDecisionInput,
  type CoreEventOf,
  createCoreRegistry,
  type Event,
  type EventSchemaRegistry,
  type Lowering,
  type ModelRef,
  memoryStore,
  type RunResult,
  readTimeline,
  runLoop,
  type SerializedRunState,
  type Stores,
  type Tool,
  uuidv7,
} from "@reins/core"
import { withContextWindow } from "./arms.js"
import {
  addTokens,
  cacheHitRateOf,
  finalTextOf,
  mean,
  measureTimeline,
  sumTokens,
  ZERO_TOKENS,
} from "./metrics.js"
import type {
  ArmSummary,
  EvalArm,
  EvalFixture,
  EvalMetrics,
  EvalOutcome,
  EvalOutcomeDraft,
  EvalReport,
  FactResult,
  Judge,
  PlantedFact,
  TokenTotals,
} from "./types.js"

export interface RunEvalOptions {
  fixtures: readonly EvalFixture[]
  arms: readonly EvalArm[]
  /** 被测模型 */
  lowering: Lowering
  model: ModelRef
  /** 每格重复次数，缺省 1；真模型有随机性，门禁前建议 ≥ 3 */
  repeats?: number
  /** 重复编号从几开始，缺省 1。补跑单格（如第 3 次因网络中断失败）时给 3，结果编号不会盖掉已有的 */
  repeatStart?: number
  /** 每格一套新存储；缺省内存实现 */
  stores?: () => Stores
  /** LLM judge，给没有 expect 的预埋事实打分 */
  judge?: Judge
  registry?: EventSchemaRegistry
  /** 探针问答的轮数上限，缺省 4 */
  probeMaxTurns?: number
  /** 续跑（审批 / 预算 / 交接）的总次数上限，防止无限循环；缺省 200 */
  maxSteps?: number
  signal?: AbortSignal
  /** 每条刚入日志的事件（含探针会话） */
  onEvent?: (event: Event, cell: { fixtureId: string; arm: string; repeat: number; probe?: string }) => void
  /** 每格跑完 */
  onOutcome?: (outcome: EvalOutcome) => void
  /** 测试注入 */
  now?: () => number
  newId?: (at: number) => string
}

const PROBE_NOTE =
  "Answer the following question using only what you already know from this conversation. Do not call tools except to bring back a previously spilled or folded tool result. Answer concisely."

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  assertFixtures(opts)
  const now = opts.now ?? Date.now
  const startedAt = now()
  const repeats = opts.repeats ?? 1
  const outcomes: EvalOutcome[] = []
  for (const fixture of opts.fixtures) {
    for (const arm of opts.arms) {
      const start = opts.repeatStart ?? 1
      for (let repeat = start; repeat < start + repeats; repeat++) {
        opts.signal?.throwIfAborted()
        const outcome = await runCell(opts, fixture, arm, repeat)
        outcomes.push(outcome)
        opts.onOutcome?.(outcome)
      }
    }
  }
  const finishedAt = now()
  return { model: opts.model, startedAt, finishedAt, outcomes, summary: summarize(outcomes) }
}

/** 开跑前把配置错误一次挑出来，不要烧完 token 才发现某条事实没法打分 */
function assertFixtures(opts: RunEvalOptions): void {
  if (opts.fixtures.length === 0) throw new Error("没有 fixture")
  if (opts.arms.length === 0) throw new Error("没有臂")
  const names = new Set<string>()
  for (const arm of opts.arms) {
    if (names.has(arm.name)) throw new Error(`臂名重复：${arm.name}`)
    names.add(arm.name)
  }
  for (const f of opts.fixtures) {
    for (const fact of f.facts ?? []) {
      if (fact.expect === undefined && !opts.judge) {
        throw new Error(`fixture ${f.id} 的事实 ${fact.id} 没有 expect，也没有配 judge`)
      }
    }
    if (f.task.seed) {
      f.task.seed.forEach((e, i) => {
        if (e.seq !== i + 1)
          throw new Error(`fixture ${f.id} 的种子历史 seq 必须从 1 起连续，第 ${i + 1} 条 seq 为 ${e.seq}`)
      })
    }
  }
}

interface CellEnv {
  stores: Stores
  lowering: Lowering
  model: ModelRef
  registry: EventSchemaRegistry
  systemPrompt: string | undefined
  now: () => number
  newId: (at: number) => string
}

async function runCell(
  opts: RunEvalOptions,
  fixture: EvalFixture,
  arm: EvalArm,
  repeat: number,
): Promise<EvalOutcome> {
  const now = opts.now ?? Date.now
  const env: CellEnv = {
    stores: (opts.stores ?? memoryStore)(),
    lowering: fixture.contextWindow ? withContextWindow(opts.lowering, fixture.contextWindow) : opts.lowering,
    model: opts.model,
    registry: opts.registry ?? createCoreRegistry(),
    systemPrompt: joinPrompts(fixture.task.systemPrompt, arm.systemPrompt),
    now,
    newId: opts.newId ?? uuidv7,
  }
  const cell = { fixtureId: fixture.id, arm: arm.name, repeat }
  const emit = (probe?: string) => (e: Event) => opts.onEvent?.(e, probe ? { ...cell, probe } : cell)

  // 1. 会话与种子
  let sessionId = env.newId(now())
  if (fixture.task.seed?.length) {
    await env.stores.log.append(fixture.task.seed.map((e) => ({ ...e, sessionId })))
  }

  // 2. 跑任务
  const sessionIds = [sessionId]
  const wallStart = now()
  let result = await drain(
    runLoop(loopConfig(env, fixture, arm, sessionId, { input: fixture.task.input })),
    emit(),
  )
  let resumes = 0
  let steps = 0
  const maxSteps = opts.maxSteps ?? 200
  const draft = (): EvalOutcomeDraft => ({
    ...cell,
    sessionIds,
    timelines: [],
    timeline: [],
    fresh: [],
    result,
    finalText: "",
  })
  while (steps++ < maxSteps) {
    opts.signal?.throwIfAborted()
    if (result.status === "handoff") {
      sessionId = result.toSessionId
      sessionIds.push(sessionId)
      result = await drain(runLoop(loopConfig(env, fixture, arm, sessionId, {})), emit())
      continue
    }
    if (result.status !== "paused") break
    if (result.reason === "approval") {
      const decisions: ApprovalDecisionInput[] = []
      let blocked = false
      for (const i of result.interruptions) {
        if (i.kind === "approval") {
          const approved = fixture.approve ? fixture.approve(i, draft()) : true
          decisions.push({ toolCallId: i.toolCallId, approved, by: "eval" })
        } else blocked = true // 客户端工具等：eval 里没人能回填
      }
      if (blocked) break
      result = await drain(
        runLoop(loopConfig(env, fixture, arm, sessionId, { resume: result.state, decisions })),
        emit(),
      )
      continue
    }
    if (result.reason === "budget" && resumes < (fixture.maxResumes ?? 0)) {
      resumes++
      result = await drain(
        runLoop(loopConfig(env, fixture, arm, sessionId, { resume: result.state })),
        emit(),
      )
      continue
    }
    break
  }
  const wallMs = now() - wallStart

  // 3. 收时间线、算完成度
  const timelines: Event[][] = []
  for (const id of sessionIds)
    timelines.push(await readTimeline(env.stores.log, id, { registry: env.registry }))
  const timeline = timelines.flat()
  // 种子历史是别人（上一次真实运行）的账：token、轮数、动作都不算在这一格头上，只算本次新追加的事件
  const seedLen = fixture.task.seed?.length ?? 0
  const fresh =
    seedLen > 0 ? [...(timelines[0] ?? []).slice(seedLen), ...timelines.slice(1).flat()] : timeline
  const outcomeDraft: EvalOutcomeDraft = {
    ...cell,
    sessionIds,
    timelines,
    timeline,
    fresh,
    result,
    finalText: finalTextOf(fresh),
  }
  const completed = clamp01(await fixture.completion(outcomeDraft))

  // 4. 探针问答
  const facts: FactResult[] = []
  let probeTokens: TokenTotals = { ...ZERO_TOKENS }
  const last = timelines[timelines.length - 1] as Event[]
  const lastSeq = last[last.length - 1]?.seq ?? 0
  for (const fact of fixture.facts ?? []) {
    opts.signal?.throwIfAborted()
    const probe = await runProbe(opts, env, fixture, arm, sessionId, lastSeq, fact, emit(fact.id))
    probeTokens = addTokens(probeTokens, probe.tokens)
    facts.push(probe.fact)
  }

  const base = measureTimeline(fresh, fixture.constraints ?? [])
  const metrics: EvalMetrics = {
    status: result.status,
    completed,
    ...base,
    ...(facts.length > 0 ? { recall: mean(facts.map((f) => f.score)) } : {}),
    wallMs,
    probeTokens,
  }
  return { ...outcomeDraft, metrics, facts }
}

function loopConfig(
  env: CellEnv,
  fixture: EvalFixture,
  arm: EvalArm,
  sessionId: string,
  extra: {
    input?: EvalFixture["task"]["input"]
    resume?: SerializedRunState
    decisions?: readonly ApprovalDecisionInput[]
    tools?: readonly Tool[]
    systemPrompt?: string | undefined
    maxTurns?: number
  },
) {
  const tools = extra.tools ?? fixture.tools
  const systemPrompt = extra.systemPrompt ?? env.systemPrompt
  return {
    sessionId,
    log: env.stores.log,
    ...(env.stores.blobs ? { blobs: env.stores.blobs } : {}),
    ...(env.stores.memory ? { memory: env.stores.memory } : {}),
    lowering: env.lowering,
    model: env.model,
    tools,
    sockets: arm.sockets ?? [],
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(arm.projection ? { projection: arm.projection } : {}),
    registry: env.registry,
    maxTurns: extra.maxTurns ?? fixture.maxTurns ?? 100,
    now: env.now,
    newId: env.newId,
    ...(extra.input !== undefined ? { input: extra.input } : {}),
    ...(extra.resume ? { resume: extra.resume } : {}),
    ...(extra.decisions ? { decisions: extra.decisions } : {}),
  }
}

async function runProbe(
  opts: RunEvalOptions,
  env: CellEnv,
  fixture: EvalFixture,
  arm: EvalArm,
  fromSessionId: string,
  atSeq: number,
  fact: PlantedFact,
  onEvent: (e: Event) => void,
): Promise<{ fact: FactResult; tokens: TokenTotals }> {
  const probeSessionId = env.newId(env.now())
  await env.stores.log.fork(fromSessionId, atSeq, probeSessionId)
  const probeEvents: Event[] = []
  await drain(
    runLoop(
      loopConfig(env, fixture, arm, probeSessionId, {
        input: fact.question,
        tools: [],
        systemPrompt: joinPrompts(env.systemPrompt, PROBE_NOTE),
        maxTurns: opts.probeMaxTurns ?? 4,
      }),
    ),
    (e) => {
      probeEvents.push(e)
      onEvent(e)
    },
  )
  const { answer, answerFrom } = probeAnswerOf(probeEvents)
  const graded = await grade(opts, fixture, fact, answer)
  return {
    fact: { id: fact.id, question: fact.question, answer, answerFrom, ...graded },
    tokens: sumTokens(probeEvents),
  }
}

/**
 * 探针的回答：优先取模型正文；一句正文都没有时退回最后一段 thinking。
 * 实测（E3，DeepSeek v4 flash 经 Anthropic 端口）短答案（"14"）有 9% 的概率整个落在 thinking 块里、正文为空、输出 1 个 token ——
 * 那是模型唯一的输出，不该判成"不记得"。
 */
export function probeAnswerOf(events: readonly Event[]): {
  answer: string
  answerFrom: FactResult["answerFrom"]
} {
  const text = finalTextOf(events)
  if (text !== "") return { answer: text, answerFrom: "text" }
  const thinking = [...events]
    .reverse()
    .filter((e): e is CoreEventOf<"core.model_thinking"> => e.type === "core.model_thinking")
    .find((e) => e.payload.text !== "")
  return thinking
    ? { answer: thinking.payload.text, answerFrom: "thinking" }
    : { answer: "", answerFrom: "none" }
}

async function grade(
  opts: RunEvalOptions,
  fixture: EvalFixture,
  fact: PlantedFact,
  answer: string,
): Promise<Pick<FactResult, "score" | "gradedBy">> {
  const expect = fact.expect
  if (expect === undefined) {
    if (!opts.judge) throw new Error(`事实 ${fact.id} 没有 expect 也没有 judge`) // assertFixtures 已拦，此处兜底
    return { score: clamp01(await opts.judge({ fixtureId: fixture.id, fact, answer })), gradedBy: "judge" }
  }
  return { score: gradeExpect(expect, answer), gradedBy: "expect" }
}

/** 确定性判分：字符串不分大小写包含、正则、或函数（0~1 / 布尔） */
export function gradeExpect(expect: NonNullable<PlantedFact["expect"]>, answer: string): number {
  if (typeof expect === "string") return answer.toLowerCase().includes(expect.toLowerCase()) ? 1 : 0
  if (expect instanceof RegExp) return expect.test(answer) ? 1 : 0
  return clamp01(expect(answer))
}

async function drain(gen: AsyncGenerator<Event, RunResult>, onEvent: (e: Event) => void): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
    onEvent(step.value)
  }
}

function joinPrompts(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => p !== undefined && p !== "")
  return kept.length === 0 ? undefined : kept.join("\n\n")
}

function clamp01(v: boolean | number): number {
  if (typeof v === "boolean") return v ? 1 : 0
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/** 按臂聚合均值 */
export function summarize(outcomes: readonly EvalOutcome[]): Record<string, ArmSummary> {
  const byArm = new Map<string, EvalOutcome[]>()
  for (const o of outcomes) byArm.set(o.arm, [...(byArm.get(o.arm) ?? []), o])
  const summary: Record<string, ArmSummary> = {}
  for (const [arm, list] of byArm) {
    const ms = list.map((o) => o.metrics)
    const tokens: TokenTotals = {
      input: mean(ms.map((m) => m.tokens.input)),
      output: mean(ms.map((m) => m.tokens.output)),
      cacheRead: mean(ms.map((m) => m.tokens.cacheRead)),
      cacheWrite: mean(ms.map((m) => m.tokens.cacheWrite)),
      total: mean(ms.map((m) => m.tokens.total)),
    }
    const recalls = ms.map((m) => m.recall).filter((r): r is number => r !== undefined)
    const cacheHitRate = cacheHitRateOf(tokens)
    summary[arm] = {
      arm,
      runs: list.length,
      finishedRate: mean(ms.map((m) => (m.status === "done" ? 1 : 0))),
      completion: mean(ms.map((m) => m.completed)),
      tokens,
      ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
      ...(recalls.length > 0 ? { recall: mean(recalls) } : {}),
      violations: {
        before: mean(ms.map((m) => m.violations.before.rate)),
        after: mean(ms.map((m) => m.violations.after.rate)),
      },
      compactions: {
        model: mean(ms.map((m) => m.compactions.model)),
        threshold: mean(ms.map((m) => m.compactions.threshold)),
        maxConsecutive: mean(ms.map((m) => m.compactions.maxConsecutive)),
      },
      turns: mean(ms.map((m) => m.turns)),
      toolCalls: mean(ms.map((m) => m.toolCalls)),
      repeatedToolCalls: mean(ms.map((m) => m.repeatedToolCalls)),
      wallMs: mean(ms.map((m) => m.wallMs)),
    }
  }
  return summary
}
