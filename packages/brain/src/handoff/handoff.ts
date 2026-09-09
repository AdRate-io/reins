/**
 * handoff —— 会话交接模块（技术方案 §9.5，B5）。
 *
 * 交接的机械部分在 core 循环里（T9）：`onTurnEnd` 返回 `{ handoff }` → 旧会话 append `core.handoff`，
 * 新会话 seq 1 = `system_note(kind=host, 摘要)`、之后是脑子带来的开场事件、最后 `user_message(触发消息)`，
 * 调 `cfg.onHandoff(from, to)`，返回 `handoff` 态；续跑新会话由宿主再起一次 runLoop。本模块只让模型能用它（宪法一）：
 *
 * 1. **工具** `handoff({ summary, nextSteps, triggerMessage?, reason? })`，静态贡献 + 规则提示 `HANDOFF_RULES`。
 *    工作在 afterTool：解析入参、把意图记在本轮（WeakMap<TurnContext>，轮结束即回收），把结果换成回执；
 *    本轮其余工具调用照常执行，onTurnEnd 时才真正交接 —— 交接只能在轮次边界发生，且不该打断同轮的其他工作。
 * 2. **开场说明**由本模块排版：摘要 + 编号的下一步。`handoff.summary` 与新会话 seq 1 的文字是同一段，
 *    回放旧会话就能看到新会话拿到了什么。
 * 3. **pin 跟着走**：模型当前可见、未被取代的 `system_note(kind=pin)`（宿主的和模型的）原样复制成新会话的开场事件
 *    （`HandoffIntent.opening`，保留 meta.pin 与 actor，provenance 指回旧事件），在新会话里仍是 pin：穿越那边的折叠，
 *    pins() Socket 见同名同文的宿主 pin 也不会再注入一条。方案里"首条 system_note 携带 summary 与 pins"落成
 *    "摘要一条 + pin 各一条"，因为 pin 塞进摘要正文就不再是 pin 了。
 * 4. **触发消息**缺省取模型当前可见的最后一条用户消息：长任务里那通常就是原始任务陈述；模型可以显式给别的。
 *
 * 注意注册顺序：onTurnEnd 第一个给意见的 Socket 说了算，本模块应排在 compact 等可能返回 pause 的 Socket 之前，
 * 否则模型调了 handoff、拿到了回执，本轮却被别的模块暂停 —— 回执会撒谎。
 *
 * 不带走的：外溢到 BlobStore 的结果（fetch_blob 按会话隔离，见 §17）、旧会话的其他历史。规则提示里已告知模型。
 */
import type {
  CoreEventOf,
  Event,
  EventDraft,
  HandoffIntent,
  Socket,
  Tool,
  ToolCallEvent,
  ToolResultDraft,
  TurnContext,
} from "@reins/core"
import { isModelOutput, supersededIds } from "@reins/core"
import { HANDOFF_RULES, HANDOFF_TOOL_DESCRIPTION, HANDOFF_TOOL_NAME } from "./rules.js"

export interface HandoffOptions {
  /** 是否把当前可见、未被取代的 pin 复制到新会话开头。缺省 true */
  carryPins?: boolean
  /** 规则提示：缺省内置英文文案；传字符串替换；false 则不碰系统提示 */
  rules?: string | false
}

export const HANDOFF_SOCKET_NAME = "handoff"
/** 模型没给 reason 时记在 handoff 事件里的值 */
export const DEFAULT_HANDOFF_REASON = "model_decision"

export const HANDOFF_INPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Everything the next session must know, written for someone who has not seen this conversation: goal in the user's words, what is done, decisions and why, exact state of unfinished work, identifiers it will need.",
    },
    nextSteps: {
      type: "array",
      items: { type: "string" },
      description: "Concrete actions for the next session, in order. One action per item.",
    },
    triggerMessage: {
      type: "string",
      description:
        "The message the new session should act on. Omit to reuse the latest user message from this session.",
    },
    reason: {
      type: "string",
      description:
        "Why you are handing off (e.g. context_pressure, phase_boundary). Recorded in the timeline.",
    },
  },
  required: ["summary", "nextSteps"],
  additionalProperties: false,
} as const

export interface HandoffArgs {
  summary: string
  nextSteps: string[]
  triggerMessage?: string
  reason?: string
}

export function parseHandoffArgs(raw: unknown): HandoffArgs {
  if (typeof raw !== "object" || raw === null) throw new RangeError(`${HANDOFF_TOOL_NAME} expects an object`)
  const o = raw as Record<string, unknown>
  if (typeof o.summary !== "string" || o.summary.trim().length === 0) {
    throw new RangeError("`summary` must be a non-empty string")
  }
  if (!Array.isArray(o.nextSteps) || o.nextSteps.some((s) => typeof s !== "string")) {
    throw new RangeError("`nextSteps` must be an array of strings (it may be empty)")
  }
  const out: HandoffArgs = {
    summary: o.summary.trim(),
    nextSteps: (o.nextSteps as string[]).map((s) => s.trim()).filter((s) => s.length > 0),
  }
  for (const key of ["triggerMessage", "reason"] as const) {
    const v = o[key]
    if (v === undefined) continue
    if (typeof v !== "string" || v.trim().length === 0)
      throw new RangeError(`\`${key}\` must be a non-empty string when given`)
    out[key] = v.trim()
  }
  return out
}

/** 新会话 seq 1 的文字（也是旧会话 handoff.summary）：摘要 + 编号的下一步 */
export function composeHandoffNote(args: Pick<HandoffArgs, "summary" | "nextSteps">): string {
  const lines = [
    "Handoff from a previous session. What follows was written by the model before handing off; nothing else from that session is available here.",
    "",
    "## Summary",
    args.summary,
  ]
  if (args.nextSteps.length > 0) {
    lines.push("", "## Next steps")
    lines.push(...args.nextSteps.map((step, i) => `${i + 1}. ${step}`))
  }
  return lines.join("\n")
}

type PinNote = CoreEventOf<"core.system_note">
const isPin = (e: Event): e is PinNote =>
  e.type === "core.system_note" && (e as PinNote).payload.kind === "pin"

/** 模型当前可见、未被取代的 pin，按可见顺序复制成新会话的开场草稿 */
export function carriedPins(ctx: TurnContext): EventDraft[] {
  const superseded = supersededIds(ctx.timeline)
  const out: EventDraft[] = []
  for (const e of ctx.events) {
    if (!isPin(e) || superseded.has(e.id)) continue
    const payload: PinNote["payload"] = { kind: "pin", text: e.payload.text }
    if (e.payload.meta !== undefined) payload.meta = e.payload.meta
    out.push({
      type: "core.system_note",
      actor: e.actor,
      payload,
      provenance: { source: HANDOFF_SOCKET_NAME, ref: e.id },
    })
  }
  return out
}

/** 模型当前可见的最后一条用户消息的文字；没有则 undefined */
export function lastVisibleUserMessage(events: readonly Event[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Event
    if (e.type !== "core.user_message") continue
    const text = (e as CoreEventOf<"core.user_message">).payload.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim()
    return text.length > 0 ? text : undefined
  }
  return undefined
}

/**
 * 上一次 run 里模型调了 handoff、拿到了"已安排交接"的回执，但那一轮被打断（审批暂停、宿主中止），
 * 没能走到 onTurnEnd，内存里的意图随之丢失（R2）。续跑补齐 pending 后循环会再调 onTurnEnd，
 * 这里从日志把入参找回来：最后一条成功的 handoff 回执之后，既没有 `core.handoff`（说明还没交接），
 * 也没有新的模型输出（说明没有开新的一轮、旧意图仍然有效）。任一不满足即 undefined。
 */
export function unfinishedHandoffArgs(timeline: readonly Event[]): HandoffArgs | undefined {
  let receipt: CoreEventOf<"core.tool_result"> | undefined
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i] as Event
    if (e.type === "core.handoff") return undefined
    if (isModelOutput(e)) {
      // 回执之前的模型输出就是发起交接的那一轮本身；回执之后出现的模型输出说明新的一轮已开始
      if (receipt) break
      return undefined
    }
    if (e.type === "core.tool_result") {
      const r = e as CoreEventOf<"core.tool_result">
      if (r.payload.name === HANDOFF_TOOL_NAME && !r.payload.isError && !receipt) receipt = r
    }
  }
  if (!receipt) return undefined
  const call = timeline.find(
    (e): e is CoreEventOf<"core.tool_call"> =>
      e.type === "core.tool_call" &&
      (e as CoreEventOf<"core.tool_call">).payload.toolCallId === receipt?.payload.toolCallId,
  )
  if (!call) return undefined
  try {
    return parseHandoffArgs(call.payload.args)
  } catch {
    return undefined
  }
}

function replaceResult(result: ToolResultDraft, text: string, isError: boolean): ToolResultDraft {
  return { ...result, payload: { ...result.payload, content: [{ type: "text", text }], isError } }
}

/** 占位回执：正常情况下 afterTool 会把它换掉；看到这句话说明 handoff 的 Socket 没装 */
const PLACEHOLDER = `The ${HANDOFF_TOOL_NAME} tool is present but its Socket is not installed; no handoff will happen.`

export function handoff(opts: HandoffOptions = {}): Socket {
  const carryPins = opts.carryPins ?? true
  /** 本轮记下的交接意图；轮结束随 ctx 回收，两个并发 run 互不干扰 */
  const intents = new WeakMap<TurnContext, HandoffIntent>()

  const tool: Tool = {
    name: HANDOFF_TOOL_NAME,
    description: HANDOFF_TOOL_DESCRIPTION,
    inputSchema: HANDOFF_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: parseHandoffArgs,
    risk: "low",
    execute: () => PLACEHOLDER,
  }

  const socket: Socket = {
    name: HANDOFF_SOCKET_NAME,
    tools: [tool],

    afterTool(ctx: TurnContext, call: ToolCallEvent, result: ToolResultDraft) {
      if (call.payload.name !== HANDOFF_TOOL_NAME || result.payload.isError) return undefined
      if (intents.has(ctx)) {
        return replaceResult(
          result,
          "A handoff is already scheduled for the end of this turn; this call changed nothing.",
          true,
        )
      }
      let args: HandoffArgs
      try {
        args = parseHandoffArgs(call.payload.args)
      } catch (err) {
        return replaceResult(result, err instanceof Error ? err.message : String(err), true)
      }
      const { intent, pins, triggerMessage } = intentOf(ctx, args)
      intents.set(ctx, intent)
      const carried = [
        `${args.nextSteps.length} next step${args.nextSteps.length === 1 ? "" : "s"}`,
        `${pins.length} pinned note${pins.length === 1 ? "" : "s"}`,
        triggerMessage !== undefined
          ? "the message to act on"
          : "no message to act on (the host will supply one)",
      ].join(", ")
      return replaceResult(
        result,
        `Handoff scheduled: this session ends when this turn ends, and a new session starts with your summary, ${carried}. Finish any remaining tool calls of this turn; do not start new work.`,
        false,
      )
    },

    onTurnEnd(ctx: TurnContext) {
      const intent = intents.get(ctx)
      if (intent) return { handoff: intent }
      // 本轮内存里没有：可能是上一次 run 被打断、这次补齐 pending 后的收尾，从日志重建（R2）
      const args = unfinishedHandoffArgs(ctx.timeline)
      return args ? { handoff: intentOf(ctx, args).intent } : undefined
    },
  }

  /** 由入参与当前视图算出交接意图：摘要 + 下一步排版成开场说明，带上可见的 pin 与触发消息 */
  function intentOf(
    ctx: TurnContext,
    args: HandoffArgs,
  ): { intent: HandoffIntent; pins: EventDraft[]; triggerMessage: string | undefined } {
    const pins = carryPins ? carriedPins(ctx) : []
    const triggerMessage = args.triggerMessage ?? lastVisibleUserMessage(ctx.events)
    const intent: HandoffIntent = {
      summary: composeHandoffNote(args),
      reason: args.reason ?? DEFAULT_HANDOFF_REASON,
      by: "model",
      ...(triggerMessage !== undefined ? { triggerMessage } : {}),
      ...(pins.length > 0 ? { opening: pins } : {}),
    }
    return { intent, pins, triggerMessage }
  }
  if (opts.rules !== false) socket.systemPrompt = opts.rules ?? HANDOFF_RULES
  return socket
}
