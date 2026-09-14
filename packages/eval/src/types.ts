/**
 * eval 的数据形状（技术方案 §13）。
 *
 * fixture = 一段事件日志（种子历史 + 录下的工具结果）+ 任务目标 + 评分器。
 * 三组对照（无脑子 / 纯阈值 / 模型自决）是三个"臂"（arm）：同一个 fixture、同一个模型，只换循环配置。
 * 指标全部从跑完的时间线算出来（纯函数），judge 与执行分离：模型下的题由另一个模型或确定性规则来判。
 */
import type {
  ContentPart,
  CoreEventOf,
  Event,
  Interruption,
  LoopConfig,
  ModelRef,
  RunResult,
  Socket,
  Tool,
} from "@reinsjs/core"

// ---- fixture ----

export interface EvalTask {
  /** 任务陈述：作为主会话的第一条 user_message */
  input: string | ContentPart[]
  /** 宿主系统提示（角色、契约）；臂可以在它后面追加 */
  systemPrompt?: string
  /**
   * 任务开始前已有的历史（如脱敏录像的前缀），seq 必须从 1 起连续。
   * runner 只换 sessionId 后原样 append，事件 id 保留（parentId / pinsKept 等会话内引用不断）。
   */
  seed?: readonly Event[]
}

/**
 * 预埋事实：任务里出现过（在种子历史、工具结果或用户消息里）的一个具体信息。
 * 跑完后在**分叉出的会话**里向模型提问，看它在整理之后还记得多少 —— 这就是"关键信息召回"。
 */
export interface PlantedFact {
  id: string
  question: string
  /**
   * 确定性判定：字符串（不分大小写的包含）、正则、或函数（返回 0~1 的分数或布尔）。
   * 缺省则交给 runner 的 judge（LLM judge）；两者都没有即报错，不静默给 0 分。
   */
  expect?: string | RegExp | ((answer: string) => boolean | number)
}

/** 模型的一个"动作"：一次工具调用或一段正文，治理衰减按动作数算违规率 */
export type ModelAction = CoreEventOf<"core.tool_call"> | CoreEventOf<"core.model_text">

/**
 * 预埋约束：任务或 pin 里写明的一条规矩（"只操作测试广告主 X"、"不要调 deploy"）。
 * violates 对每个模型动作判一次；违规率按"第一次整理之前 / 之后"分开算（§9.3 治理衰减）。
 */
export interface PlantedConstraint {
  id: string
  /** 约束原文，只进报告 */
  text?: string
  violates(action: ModelAction, ctx: { timeline: readonly Event[] }): boolean
}

export type ApprovalInterruption = Extract<Interruption, { kind: "approval" }>

export interface EvalFixture {
  id: string
  description?: string
  task: EvalTask
  /** 任务可用的工具；长任务通常用 recordedTools() 从录像回放，保证各臂看到同样的世界 */
  tools: readonly Tool[]
  facts?: readonly PlantedFact[]
  constraints?: readonly PlantedConstraint[]
  /**
   * 完成判定：看整条时间线（最后一段正文、调过哪些工具、工具结果里的状态……）给 0~1 或布尔。
   * 这是确定性评分器；要 LLM judge 判完成度就自己在这里调 judge。
   */
  completion(outcome: EvalOutcomeDraft): boolean | number | Promise<boolean | number>
  /** 审批由 runner 代人回答；缺省全批。返回 false 即拒绝（模型会看到被拒的 tool_result） */
  approve?(interruption: ApprovalInterruption, outcome: EvalOutcomeDraft): boolean
  /**
   * 覆盖模型的上下文窗口（token）。把窗口缩小，中等长度的任务也会触发整理 ——
   * 比真的烧到 200k 便宜得多，而且三个臂在同样的窄窗口下比较才公平。
   */
  contextWindow?: number
  /** 单次 run 的轮数上限（LoopConfig.maxTurns），缺省 100 */
  maxTurns?: number
  /** 预算暂停（budget 模块 / compact 连续上限 / maxTurns）后最多续跑几次；缺省 0：暂停即视为没跑完 */
  maxResumes?: number
}

// ---- 臂 ----

/**
 * 对照组的一臂：只描述"循环怎么配"，与 fixture、模型无关。
 * 内置 noneArm（无脑子、无阈值兜底）与 thresholdArm（只有 core 的阈值裁剪）；
 * "模型自决"臂由调用方用 @reinsjs/brain 组（本包只依赖 core）。
 */
export interface EvalArm {
  name: string
  sockets?: readonly Socket[]
  projection?: LoopConfig["projection"]
  /** 给这一臂追加的系统提示片段（如给基线一段与脑子等价的文字说明），排在 fixture 的系统提示之后 */
  systemPrompt?: string
}

// ---- judge ----

/** LLM judge：与被测模型分离，只回答"这个答案算不算对"，返回 0~1 */
export type Judge = (input: {
  fixtureId: string
  fact: PlantedFact
  answer: string
}) => Promise<number | boolean> | number | boolean

// ---- 结果 ----

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** input + output + cacheRead + cacheWrite */
  total: number
}

export interface CompactionCounts {
  model: number
  threshold: number
  /** 最长的一段"连续含整理的模型轮"里的整理次数（§9.2 连续上限看的就是它） */
  maxConsecutive: number
}

export interface ViolationWindow {
  /** 该窗口内的模型动作数（tool_call + model_text） */
  actions: number
  violations: number
  /** violations / actions；没有动作时为 0 */
  rate: number
}

export interface EvalMetrics {
  /** 最终状态：done 才算跑完；paused / error / handoff 都如实记 */
  status: RunResult["status"]
  /** 完成度 0~1（fixture.completion 的结果） */
  completed: number
  tokens: TokenTotals
  /** cacheRead / (input + cacheRead + cacheWrite)；一次请求都没记用量时为 undefined */
  cacheHitRate?: number
  /** 模型请求次数（从日志按轮切） */
  turns: number
  toolCalls: number
  /** isError 的工具结果数 */
  toolErrors: number
  /** 同名同参的工具调用重复出现的次数（死循环计数：第二次起每次记 1） */
  repeatedToolCalls: number
  compactions: CompactionCounts
  /** 治理衰减：第一次整理（任何 decidedBy）之前 / 之后的违规率。没整理过则 after 全零 */
  violations: { before: ViolationWindow; after: ViolationWindow }
  /** 关键信息召回：各预埋事实得分的均值；没有预埋事实时为 undefined */
  recall?: number
  /** runner 量的墙钟（含审批续跑之间的开销，不含探针问答） */
  wallMs: number
  /** 探针问答自己花的 token，不计入 tokens */
  probeTokens: TokenTotals
}

export interface FactResult {
  id: string
  question: string
  /** 模型在分叉会话里的回答（正文拼接；没有正文时退回最后一段 thinking） */
  answer: string
  /** 回答取自哪里：text 正文、thinking（正文为空）、none（什么都没输出） */
  answerFrom: "text" | "thinking" | "none"
  /** 0~1 */
  score: number
  /** 判定来源 */
  gradedBy: "expect" | "judge"
}

/** completion / approve 回调看到的中间态：跑完了但还没算指标 */
export interface EvalOutcomeDraft {
  fixtureId: string
  arm: string
  repeat: number
  /** 主会话链：handoff 会接到新会话，按先后排列 */
  sessionIds: string[]
  /** 各会话的完整时间线，与 sessionIds 一一对应 */
  timelines: Event[][]
  /** 全链拼起来的时间线（按会话先后再按 seq），评分器最常用它 */
  timeline: Event[]
  /** 本次真正跑出来的事件：去掉种子历史后的 timeline。指标（token、轮、动作、违规）只看它 */
  fresh: Event[]
  /** 最后一次 run 的返回 */
  result: RunResult
  /** 最后一段模型正文（通常是给用户的汇报） */
  finalText: string
}

export interface EvalOutcome extends EvalOutcomeDraft {
  metrics: EvalMetrics
  facts: FactResult[]
}

/** 一臂在全部 fixture × repeat 上的均值 */
export interface ArmSummary {
  arm: string
  runs: number
  /** done 的比例 */
  finishedRate: number
  completion: number
  tokens: TokenTotals
  cacheHitRate?: number
  recall?: number
  violations: { before: number; after: number }
  compactions: CompactionCounts
  turns: number
  toolCalls: number
  repeatedToolCalls: number
  wallMs: number
}

export interface EvalReport {
  model: ModelRef
  startedAt: number
  finishedAt: number
  outcomes: EvalOutcome[]
  /** 按臂名索引 */
  summary: Record<string, ArmSummary>
}
