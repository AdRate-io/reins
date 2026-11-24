/**
 * recall —— 按 seq 逐字取回一条被折叠的工具结果或用户消息（E3c，技术方案 §9.2；用户消息 2026-11-24）。
 *
 * 为什么要有它：整理是模型自己的取舍，两个模型族的实测都把"复核过的字段值"整理成了"状态正常"一句结论，
 * 被问到时只能说"摘要里没留，可以重查"——而重查要宿主工具、且查到的是现在的值不是当时的值。原件本来就在
 * 日志里（宪法二），缺的只是一条读回去的路。compact 的摘要下面列出被折叠的每条结果（`seq N tool(arguments)`），
 * 这个工具把其中一条原样拿回来，与 spill 的 fetch_blob 是同一个思路：让模型看见、给它能力，不替它决定。
 *
 * 读的是**本会话**的日志（ctx.log.read(ctx.sessionId)），别的会话一律当不存在。fork 出的会话（eval 探针）复制了
 * 事件且保留 seq，所以摘要里的 seq 在子会话照样有效。原始读取不过注册表：只看 core 稳定字段（type / seq / payload），
 * 与 spill.referencedHere 同一理由。
 *
 * 取回的内容再次进入上下文，是模型有意识的花费；结果超过外溢上限时由 spill 模块照常处理（recall 不在它的排除名单里）。
 * 已外溢的原件事件里只剩预览，这里不复述预览，而是指向 blob 让模型用 fetch_blob 读全文。
 *
 * 用户消息（2026-11-24，AdRate 建议 17 第一步）：用户贴的截图随旧轮被折叠后原本取不回。清单只列带媒体的用户消息，
 * 但这里接受任何 user_message 的 seq——取回的是原话，拒绝纯文本消息没有意义。取回内容以 tool_result 进上下文，
 * 缺省 untrusted：旧消息重读一遍是"看资料"，不该被当成新指令再执行一次，这正是想要的。
 */
import type {
  ContentPart,
  CoreEventOf,
  Tool,
  ToolCallEvent,
  ToolContext,
  ToolResultEvent,
} from "@reinsjs/core"
import { FETCH_BLOB_TOOL_NAME } from "../spill/rules.js"
import { RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME } from "./rules.js"

export const RECALL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    seq: {
      type: "integer",
      minimum: 1,
      description: "The `seq` shown next to the folded tool result or user message in a summary's list.",
    },
  },
  required: ["seq"],
  additionalProperties: false,
} as const

export interface RecallArgs {
  seq: number
}

export function parseRecallArgs(raw: unknown): RecallArgs {
  if (typeof raw !== "object" || raw === null) throw new RangeError(`${RECALL_TOOL_NAME} expects an object`)
  const seq = (raw as Record<string, unknown>).seq
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new RangeError("`seq` must be a positive integer")
  }
  return { seq }
}

const fail = (text: string) => ({ content: [{ type: "text", text }] as ContentPart[], isError: true })

function digest(args: unknown, max = 200): string {
  if (args === undefined) return ""
  let text: string
  try {
    text = JSON.stringify(args) ?? String(args)
  } catch {
    text = String(args)
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

type UserMessageEvent = CoreEventOf<"core.user_message">

interface Located {
  result?: ToolResultEvent
  call?: ToolCallEvent
  user?: UserMessageEvent
  foundType?: string
}

/** 在本会话日志里找 seq 对应的 tool_result 及其 tool_call，或 user_message */
async function locate(ctx: ToolContext, seq: number): Promise<Located> {
  let result: ToolResultEvent | undefined
  let user: UserMessageEvent | undefined
  let foundType: string | undefined
  const calls = new Map<string, ToolCallEvent>()
  for await (const e of ctx.log.read(ctx.sessionId)) {
    if (e.type === "core.tool_call") calls.set((e as ToolCallEvent).payload.toolCallId, e as ToolCallEvent)
    if (e.seq === seq) {
      foundType = e.type
      if (e.type === "core.tool_result") result = e as ToolResultEvent
      if (e.type === "core.user_message") {
        user = e as UserMessageEvent
        break
      }
    }
    if (result && calls.has(result.payload.toolCallId)) break
  }
  const out: Located = {}
  if (result) {
    out.result = result
    const call = calls.get(result.payload.toolCallId)
    if (call) out.call = call
  }
  if (user) out.user = user
  if (foundType) out.foundType = foundType
  return out
}

export async function recallResult(
  args: RecallArgs,
  ctx: ToolContext,
): Promise<{ content: ContentPart[]; isError: boolean }> {
  const { result, call, user, foundType } = await locate(ctx, args.seq)
  if (user) {
    const header = `[Recalled user message seq ${args.seq}. Original content follows verbatim.]`
    return { content: [{ type: "text", text: header }, ...user.payload.content], isError: false }
  }
  if (!result) {
    return fail(
      foundType
        ? `seq ${args.seq} is a ${foundType.replace(/^core\./, "")} event, not a tool result or user message. Pass a seq from a summary's list.`
        : `No event with seq ${args.seq} in this session.`,
    )
  }
  const { name, spilled, isError, content } = result.payload
  const head = `${name}(${digest(call?.payload.args)})`
  if (spilled) {
    // 不是失败而是"换个工具取"的指路：以 isError 回会让 haltOnFailure 拦下同批后面的调用。
    // recall 看不到本 run 的工具表（spill({ tool: false }) 或后来去掉了 spill 时没有 fetch_blob），只能如实附条件（全库审查 2026-11-25 #66）
    const text = `[seq ${args.seq} ${head} was too large to keep inline; its full output is stored verbatim as blob "${spilled.blobId}". Read it with ${FETCH_BLOB_TOOL_NAME}({ id: "${spilled.blobId}" }) if that tool is in your tool list; ${RECALL_TOOL_NAME} cannot return it.]`
    return { content: [{ type: "text", text }], isError: false }
  }
  const header = `[Recalled tool result seq ${args.seq}: ${head}${isError ? " (the tool reported an error)" : ""}. Original output follows verbatim.]`
  return { content: [{ type: "text", text: header }, ...content], isError: false }
}

export function recallTool(): Tool {
  return {
    name: RECALL_TOOL_NAME,
    description: RECALL_TOOL_DESCRIPTION,
    inputSchema: RECALL_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: parseRecallArgs,
    risk: "low",
    execute: (args, ctx) => recallResult(args as RecallArgs, ctx),
  }
}
