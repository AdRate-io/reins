/**
 * compact —— 自主整理模块（技术方案 §9.2，B2）。
 *
 * 五件事：
 * 1. **工具** `compact({ summary, keep, keepRecentTurns? })`：模型自己决定何时整理、留什么（宪法一）。
 *    工具本身是静态贡献（Socket.tools），整个 run 不变，续跑补齐 pending 时也在场。
 * 2. **规则提示**：静态 systemPrompt 片段（rules.ts），告诉模型什么时候该整理、什么时候别整理。
 * 3. **阈值兜底**：模型没整理、上下文超过裁剪目标时，core 投影链的 budgetTruncate 会机械折叠最旧的轮并记
 *    `compaction(decidedBy=threshold)`；本模块不重复实现，只把它算进连续计数。触发点 = contextLimit − reserveTokens，
 *    宿主经 LoopConfig.projection.reserveTokens 调；perception 会把这个点告诉模型。
 * 4. **连续上限**：连着整理（模型自决 + 阈值兜底合计）达到 maxConsecutive 次仍没有一轮"正常"工作，
 *    说明卡死了（折叠后仍放不下、或模型在反复整理）→ onTurnEnd 返回 pause(budget) 交宿主处理。
 * 5. **取回**（E3c）：摘要下面列出被折叠的每条工具结果（seq + 工具 + 入参），`recall({ seq })` 工具逐字取回一条。
 *    整理丢细节是机制的代价（模型按自己的重要性判断留东西），清单与取回让丢掉的东西有路可回，见 recall.ts。
 *
 * 为什么真正的工作在 afterTool 而不在工具的 execute 里：算覆盖范围需要"模型本轮看到的视图"（ctx.events）与
 * 完整时间线，这些只有 TurnContext 有、ToolContext 没有；工具自己 readTimeline 又会绕开宿主的注册表（ext.* 事件会读不出）。
 * 所以 execute 只占位，afterTool 拿着 ctx 算出 compaction、emit 进日志（循环在 tool_result 之前 append），再把结果换成回执。
 * 这样模块没有跨轮状态：本轮的临时记录挂在 WeakMap<TurnContext> 上，轮结束即随 ctx 回收，两个并发 run 也互不干扰。
 *
 * 日志顺序：… tool_call(compact) → compaction → tool_result（回执）。compaction 的 seq 大于它覆盖的一切，
 * 所以下一轮投影的折叠策略会把范围内的事件盖掉、摘要放到原位置。这也是唯一被允许打掉 prompt cache 的动作（§9.1 约束 5）。
 */
import {
  type CompactionPayload,
  type Event,
  isCompaction,
  type Socket,
  type Tool,
  type ToolCallEvent,
  type ToolResultDraft,
  type TurnContext,
} from "@reins/core"
import {
  type CompactPlan,
  type ManifestOptions,
  parseCompactArgs,
  planCompaction,
  trailingCompactionRun,
} from "./plan.js"
import { recallTool } from "./recall.js"
import { COMPACT_RULES, COMPACT_TOOL_DESCRIPTION, COMPACT_TOOL_NAME, RECALL_TOOL_NAME } from "./rules.js"

export interface CompactOptions {
  /**
   * 连续整理次数上限（模型自决 + 阈值兜底合计），达到即 pause(budget)。缺省 3。
   * 只在模型本轮还要继续（有工具调用）时生效：模型已经收尾作答的轮不拦。
   */
  maxConsecutive?: number
  /**
   * 规则提示：缺省用内置英文文案；传字符串替换；传 false 则本模块不碰系统提示（宿主自己把 COMPACT_RULES 放进去）。
   */
  rules?: string | false
  /**
   * 被折叠工具结果清单（E3c）：缺省列在摘要之后、最多 80 条；传 false 不列；传对象调条数与排除名单。
   * 关掉清单时缺省文案里关于清单的说法就不成立了，宿主应一并换 rules。
   */
  manifest?: false | ManifestOptions
  /** 是否给模型 recall 取回工具（E3c）。缺省 true；false 时清单照列，只是模型自己取不回（宿主另有读法时用） */
  recall?: boolean
}

export const COMPACT_SOCKET_NAME = "compact"
export const DEFAULT_MAX_CONSECUTIVE_COMPACTIONS = 3

export const COMPACT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Your summary of the folded conversation: goals and constraints, decisions and why, current state, next steps.",
    },
    keep: {
      type: "array",
      items: { type: "string" },
      description:
        "Facts that must survive verbatim (identifiers, numbers, user constraints). Empty if none.",
    },
    keepRecentTurns: {
      type: "integer",
      minimum: 0,
      description:
        "How many of the most recent model turns (with their tool results) to leave unfolded. Default 0 = fold everything before the current turn.",
    },
  },
  required: ["summary", "keep"],
  additionalProperties: false,
} as const

/** 本轮的临时记录：只活在一个 TurnContext 的生命周期里 */
interface TurnRecord {
  hadToolCall: boolean
  compactions: number
}

/** 占位回执：正常情况下 afterTool 会把它换掉；看到这句话说明 compact 的 Socket 没装 */
const PLACEHOLDER = `The ${COMPACT_TOOL_NAME} tool is present but its Socket is not installed; nothing was folded.`

function replaceResult(result: ToolResultDraft, text: string, isError: boolean): ToolResultDraft {
  return { ...result, payload: { ...result.payload, content: [{ type: "text", text }], isError } }
}

function receipt(plan: Extract<CompactPlan, { ok: true }>, withRecall: boolean): string {
  const [from, to] = plan.payload.coversSeq
  const parts = [`Folded ${plan.folded.length} events (seq ${from}–${to}) into your summary.`]
  if (plan.absorbed.length > 0) parts.push(`${plan.absorbed.length} earlier summary(ies) were absorbed.`)
  if (plan.manifest.length > 0) {
    parts.push(
      `${plan.manifest.length} folded tool result(s) are listed under the summary${withRecall ? ` and can be brought back verbatim with ${RECALL_TOOL_NAME}({ seq })` : ""}.`,
    )
  }
  if (plan.payload.pinsKept.length > 0)
    parts.push(
      `${plan.payload.pinsKept.length} item(s) carried over verbatim (pinned notes and the latest user message).`,
    )
  parts.push(
    plan.keptTurns > 0
      ? `The last ${plan.keptTurns} model turn(s) stay unfolded.`
      : "Only the current turn stays unfolded.",
  )
  parts.push("The originals remain in the session log.")
  return parts.join(" ")
}

export function compact(opts: CompactOptions = {}): Socket {
  const maxConsecutive = opts.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE_COMPACTIONS
  if (!Number.isInteger(maxConsecutive) || maxConsecutive < 1) {
    throw new RangeError(`compact.maxConsecutive 必须是 ≥1 的整数：${String(maxConsecutive)}`)
  }
  const withRecall = opts.recall ?? true
  const records = new WeakMap<TurnContext, TurnRecord>()
  const recordOf = (ctx: TurnContext): TurnRecord => {
    let r = records.get(ctx)
    if (!r) {
      r = { hadToolCall: false, compactions: 0 }
      records.set(ctx, r)
    }
    return r
  }

  const tool: Tool = {
    name: COMPACT_TOOL_NAME,
    description: COMPACT_TOOL_DESCRIPTION,
    inputSchema: COMPACT_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: parseCompactArgs,
    risk: "low",
    execute: () => PLACEHOLDER,
  }

  const socket: Socket = {
    name: COMPACT_SOCKET_NAME,
    tools: withRecall ? [tool, recallTool()] : [tool],

    afterModel(ctx, events) {
      recordOf(ctx).hadToolCall = events.some((e) => e.type === "core.tool_call")
    },

    afterTool(ctx: TurnContext, call: ToolCallEvent, result: ToolResultDraft) {
      if (call.payload.name !== COMPACT_TOOL_NAME || result.payload.isError) return undefined
      // 入参已由 validate 校验过；这里重新解析一遍拿到规范形态（循环不把校验后的入参传给 afterTool）
      let plan: CompactPlan
      try {
        plan = planCompaction(ctx.events, parseCompactArgs(call.payload.args), {
          protectCallId: call.id,
          timeline: ctx.timeline,
          ...(opts.manifest !== undefined ? { manifest: opts.manifest } : {}),
        })
      } catch (err) {
        return replaceResult(result, err instanceof Error ? err.message : String(err), true)
      }
      if (!plan.ok) return replaceResult(result, plan.reason, true)

      const payload: CompactionPayload = plan.payload
      ctx.emit({
        type: "core.compaction",
        actor: "model",
        parentId: call.id,
        provenance: { source: COMPACT_TOOL_NAME, ref: call.payload.toolCallId },
        payload,
      })
      recordOf(ctx).compactions++
      return replaceResult(result, receipt(plan, withRecall), false)
    },

    onTurnEnd(ctx) {
      const record = records.get(ctx)
      if (!record?.hadToolCall) return undefined // 模型已收尾作答，循环本来就要停
      // 本轮的整理：模型自决的（afterTool 记的）+ 本轮开始时投影新造的阈值兜底（seq 大于时间线快照末尾）
      const snapshotEnd = ctx.timeline.at(-1)?.seq ?? 0
      const thresholdThisTurn = ctx.events.filter((e) => isCompaction(e) && e.seq > snapshotEnd).length
      const thisTurn = record.compactions + thresholdThisTurn
      if (thisTurn === 0) return undefined
      const total = thisTurn + trailingCompactionRun(ctx.timeline)
      if (total < maxConsecutive) return undefined
      return {
        pause: {
          reason: "budget",
          note:
            `Context was compacted ${total} times in a row without a turn of progress in between (limit ${maxConsecutive}). ` +
            "Either the window is still too small after folding, or the model is looping on compact. Paused for the host to inspect.",
        },
      }
    },
  }
  if (opts.rules !== false) socket.systemPrompt = opts.rules ?? COMPACT_RULES
  return socket
}

/** 给宿主或测试：某条事件是不是模型自决的整理 */
export function isModelCompaction(e: Event): boolean {
  return isCompaction(e) && e.payload.decidedBy === "model"
}
