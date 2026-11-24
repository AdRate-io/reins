/**
 * budget —— 预算模块（技术方案 §9.8，B8）。
 *
 * 循环自己只有一条粗兜底（轮数 `maxTurns`），每轮记一条 `budget_usage`。本模块把宿主关心的五维上限做成边界：
 * contextTokens（单次请求送进模型的上下文大小）、totalTokens（本次 run 累计输入 + 输出）、turns、toolCalls、wallMs。
 *
 * 做法：`onTurnEnd` 里对照 `ctx.budget`（循环在模型调用后已更新 tokensSpent / lastUsage，进 onTurnEnd 前刷新 wallMs、含本轮工具耗时），任一维 **用量 ≥ 上限**
 * 即返回 `{ pause: { reason: "budget", code, note } }`，循环 append `run_paused(reason=budget)` 并以 paused 返回，note 进
 * `Interruption` 给宿主看；原因码 `code`（缺省 `BUDGET_PAUSE_CODE`）随暂停落库，事后与"连续整理失败""宿主自己的配额"分得开。只在模型本轮还要继续（有工具调用）时拦：模型已经收尾作答的轮，循环本来就要停，
 * 把一个自然结束的 run 改成"暂停"只会让宿主续跑一个没事可做的会话。
 *
 * totalTokens / turns / toolCalls / wallMs 四维的上限是**每次 run** 的：宿主续跑（同一 sessionId 再起 runLoop）即视为再批一份预算，
 * 这几维从零计。contextTokens 例外：它是最近一次请求的真实上下文大小（续跑的新 run 从日志最后一条 budget_usage 继承），
 * 续跑不会让它变小。onTurnEnd 查的是本轮那次请求（整理之前）的用量，所以续跑那一轮就算模型当轮整理也至少再停一次，
 * 之后的请求变小才解开；模型不整理 / 不交接就会续跑一次、停一次。缺省说明按此如实告知宿主。
 * compact 的到线请求只按窗口比例触发、不看这里的上限，上限低于软线时请模型整理靠 perception 的余量档位提醒。
 * 会话级 / 用户级配额由宿主聚合 `budget_usage` 事件自己做（§9.8：库不做配额）；要"整个会话不超过 X"就把 X 减去
 * 已用量再传进来。模型在触顶前收到的提醒来自 perception 模块（同一份 limits 传给它，它按最紧一维报余量档位）。
 *
 * 注册顺序：onTurnEnd 第一个给意见的 Socket 说了算。本模块应排在 handoff 之后（模型已决定交接就让它交接，
 * 新会话由宿主再起时照样受限），其余位置不敏感 —— compact 的暂停同样是 budget 原因。
 */
import { contextTokensOf, type Socket, type TurnContext } from "@reinsjs/core"

/** 五维上限；给了哪几维就只查哪几维。与 perception 的 limits 是同一个形状 */
export interface BudgetLimits {
  /**
   * 单次请求送进模型的上下文大小（input + cacheRead + cacheWrite），按最近一次请求的真实用量。
   * 不是 run 级的：续跑不重置（新 run 继承上一请求的读数）。续跑那一轮查的是该轮整理前那次请求，至少再停一次，
   * 之后的请求上下文变小才解开
   */
  contextTokens?: number
  /** 本次 run 累计 token（输入 + 输出，不含缓存读写 —— 与 TurnContext.budget.tokensSpent 同口径） */
  totalTokens?: number
  /** 本次 run 的模型轮数 */
  turns?: number
  /** 本次 run 真正执行过的工具调用数 */
  toolCalls?: number
  /** 距 run 开始的毫秒数 */
  wallMs?: number
}

export type BudgetDimension = keyof BudgetLimits

export interface BudgetHit {
  dimension: BudgetDimension
  used: number
  limit: number
}

export interface BudgetOptions {
  limits: BudgetLimits
  /** 暂停说明（给宿主看，进 Interruption.note）；缺省英文一句话列出触顶的维度 */
  note?: (hits: readonly BudgetHit[]) => string
  /**
   * 暂停原因码（AdRate 建议 16），缺省恒为 `BUDGET_PAUSE_CODE`。缺省不把维度编进码里：可能多维同时触顶，一个码装不下；
   * 要按维度区分的宿主在这里自己算（如 `(hits) => \`acme.budget.${hits[0].dimension.toLowerCase()}\``——维度名带大写，要先转小写）。
   * 返回值须满足 core 的 `PAUSE_CODE_RE`（只收小写），否则码被丢掉、记一条非终结 `core.error`，暂停照常
   */
  code?: (hits: readonly BudgetHit[]) => string
}

export const BUDGET_SOCKET_NAME = "budget"

/** 本模块暂停时的缺省原因码（`reins.` 前缀留给内置来源） */
export const BUDGET_PAUSE_CODE = "reins.budget"

/** 上限必须是正的有限数；构造期就拒绝，免得跑起来才发现"0 上限"把一切都拦了 */
export function assertLimits(limits: BudgetLimits): void {
  for (const [dimension, limit] of Object.entries(limits)) {
    if (limit === undefined) continue
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      throw new RangeError(
        `budget.limits.${dimension} must be a positive finite number, got ${String(limit)}`,
      )
    }
  }
}

/** 各维当前用量；contextTokens 没有真实用量（还没请求过）时为 undefined */
export function budgetUsedOf(budget: TurnContext["budget"]): Record<BudgetDimension, number | undefined> {
  return {
    contextTokens: budget.lastUsage ? contextTokensOf(budget.lastUsage) : undefined,
    totalTokens: budget.tokensSpent,
    turns: budget.turns,
    toolCalls: budget.toolCalls,
    wallMs: budget.wallMs,
  }
}

/** 触顶的维度（用量 ≥ 上限），按 BudgetLimits 字段顺序。纯函数 */
export function checkBudget(budget: TurnContext["budget"], limits: BudgetLimits): BudgetHit[] {
  const used = budgetUsedOf(budget)
  const hits: BudgetHit[] = []
  for (const dimension of Object.keys(used) as BudgetDimension[]) {
    const limit = limits[dimension]
    const value = used[dimension]
    if (limit === undefined || value === undefined) continue
    if (value >= limit) hits.push({ dimension, used: value, limit })
  }
  return hits
}

/**
 * 缺省暂停说明。按维度分两种口径如实说（全库审查 2026-11-25 #23）：
 * - 四个 run 级维度（totalTokens / turns / toolCalls / wallMs）续跑即从零计，说"续跑拿到一份新预算"；
 * - contextTokens 是最近一次请求的真实上下文大小，续跑的新 run 从日志继承这个读数，不会因续跑变小——
 *   只承诺新预算就会让宿主续跑一次、停一次。改说"续跑不重置，续跑后至少还会再停一次，之后请求变小才解开"（第二波返修：
 *   续跑那一轮查的是该轮整理之前那次请求，模型当轮整理也照样停）
 */
export function defaultBudgetNote(hits: readonly BudgetHit[]): string {
  const parts = hits.map((h) => `${h.dimension} ${h.used}/${h.limit}`)
  const context = hits.some((h) => h.dimension === "contextTokens")
  const perRun = hits.some((h) => h.dimension !== "contextTokens")
  let note = `Run budget reached: ${parts.join(", ")}. Paused for the host to decide whether to grant more`
  if (perRun)
    note += context
      ? "; resuming the session starts a fresh run budget for the per-run limits."
      : "; resuming the session starts a fresh run budget."
  else note += "."
  if (context)
    note +=
      " contextTokens is the size of the latest model request, not a per-run total, so resuming does not reset it." +
      " Each turn is checked against the request that turn made, before any compaction in it takes effect," +
      " so the resumed run pauses at least once more; the limit clears only once a later request is smaller" +
      " (after the model compacts, or the session hands off)."
  return note
}

export function budget(opts: BudgetOptions): Socket {
  assertLimits(opts.limits)
  const note = opts.note ?? defaultBudgetNote
  // 本轮模型有没有发工具调用：没有就是收尾作答，循环本来要停，不拦。挂在 WeakMap<TurnContext> 上，轮结束即回收
  const continuing = new WeakMap<TurnContext, boolean>()

  return {
    name: BUDGET_SOCKET_NAME,
    afterModel(ctx, events) {
      continuing.set(
        ctx,
        events.some((e) => e.type === "core.tool_call"),
      )
    },
    onTurnEnd(ctx) {
      if (!continuing.get(ctx)) return undefined
      const hits = checkBudget(ctx.budget, opts.limits)
      if (hits.length === 0) return undefined
      return {
        pause: { reason: "budget", code: opts.code ? opts.code(hits) : BUDGET_PAUSE_CODE, note: note(hits) },
      }
    },
  }
}
