/**
 * pins —— 幸存契约模块（技术方案 §9.3，B3）。
 *
 * 幸存契约本身在 core：`system_note(kind=pin)` 穿越折叠与阈值裁剪自动幸存、重排到覆盖它的摘要之后，
 * `compaction.pinsKept` 记录每次整理保住了谁（fold.ts / pins.ts / truncate.ts，T6）。本模块只做两件事，让契约有人用：
 *
 * 1. **宿主声明** `pins: PinSpec[]`：静态文本（"不要动生产库"）或从时间线抽取的函数（"最近一条带'必须'的用户消息"）。
 *    beforeModel 里算出每条的文字，与模型**当前可见**的同名 pin 逐字比对：相同什么都不做；不同（首轮、内容变了、
 *    或被折叠掉了）就 emit 一条新的 `system_note(kind=pin, actor=system)` 追加到末尾，并用 `supersedes` 指向该 spec
 *    在完整时间线里的上一条 —— 旧值到下一次折叠时不再幸存，否则抽取式 pin 每变一次就永久多一条。
 *    永不返回补丁：只追加、不改前缀（§9.1 prompt cache 约束）。
 * 2. **模型工具** `pin({ text, replaces? })`：模型自己决定什么值得钉（宪法一）。工作在 afterTool 里做（要视图判重与找被替换者，
 *    ToolContext 没有视图），emit `system_note(kind=pin, actor=model, parentId=tool_call)`，再把结果换成回执。
 *    `replaces` 只能指向模型自己钉的（meta.pin.source = "model"）：宿主钉的是宿主的约束，模型动不了。
 *
 * 说明的 `meta.pin` 记来源与 spec 名（不进模型上下文），判重与 supersede 靠它，回放 / eval 也靠它分辨谁钉的。
 * 没有 unpin：append-only 日志里"撤销"只能表达为"被新说明取代"，模型要撤销就钉一条当前有效的说法去替换旧的。
 */
import type {
  CoreEventOf,
  Event,
  EventDraft,
  Socket,
  Tool,
  ToolCallEvent,
  ToolResultDraft,
  TurnContext,
} from "@reinsjs/core"
import { PIN_RULES, PIN_TOOL_NAME, pinToolDescription } from "./rules.js"

/**
 * 宿主声明的一条 pin：
 * - 字符串：静态文本，名字就是文本本身
 * - `{ name, text }`：静态文本，命名（换措辞时名字不变，旧文字会被取代而不是并存）
 * - `{ name, extract }`：每轮从上下文抽取；返回 undefined / 空串表示"这轮没新说法"，上一条继续生效
 */
export type PinSpec =
  | string
  | { name: string; text: string }
  | { name: string; extract: (ctx: TurnContext) => string | undefined }

export interface PinsOptions {
  /** 宿主声明的 pin。名字必须唯一 */
  pins?: readonly PinSpec[]
  /** 是否给模型 `pin` 工具。缺省 true */
  tool?: boolean
  /** 单条 pin 的最大字数（写进工具说明与 schema 的"声明上限"）。缺省 500：pin 是永久占用，长内容该进摘要或记忆 */
  maxTextLength?: number
  /**
   * 校验时在声明上限之上再放的容差比例，缺省 0.2（声明 500 → 实际 600 才拒）。
   * E3c 实测：上限写进说明与 schema 后，Sonnet 5 仍写出 502 / 545 / 558 字符 —— 模型瞄着上限写、数不准自己的字数，
   * 差几个字就拒掉只是白费一轮。声明值仍是 500，模型照旧往 500 以内凑；容差只吃掉数错的那一点。传 0 则严格按声明值。
   */
  overshootTolerance?: number
  /** 规则提示：缺省内置英文文案；传字符串替换；false 则不碰系统提示 */
  rules?: string | false
}

export const PINS_SOCKET_NAME = "pins"
export const DEFAULT_MAX_PIN_TEXT_LENGTH = 500
export const DEFAULT_PIN_OVERSHOOT_TOLERANCE = 0.2

/** system_note.meta.pin 的形状：谁钉的、宿主 spec 名 */
export interface PinMeta {
  source: "host" | "model"
  spec?: string
}

export type PinNote = CoreEventOf<"core.system_note">

/** 入参 schema；`maxLength` 随 maxTextLength 变，模型下笔前就看得到上限（E3c） */
export function pinInputSchema(maxTextLength: number) {
  return {
    type: "object",
    properties: {
      text: {
        type: "string",
        maxLength: maxTextLength,
        description: `The note to pin, one or two sentences (at most ${maxTextLength} characters). It will be shown verbatim after every future summary.`,
      },
      replaces: {
        type: "string",
        description:
          "Exact text of one of your earlier pinned notes that this one supersedes. Omit to add a new note.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  } as const
}

export const PIN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "The note to pin, one or two sentences. It will be shown verbatim after every future summary.",
    },
    replaces: {
      type: "string",
      description:
        "Exact text of one of your earlier pinned notes that this one supersedes. Omit to add a new note.",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const

export interface PinArgs {
  text: string
  replaces?: string
}

export function parsePinArgs(
  raw: unknown,
  maxTextLength = DEFAULT_MAX_PIN_TEXT_LENGTH,
  overshootTolerance = DEFAULT_PIN_OVERSHOOT_TOLERANCE,
): PinArgs {
  if (typeof raw !== "object" || raw === null) throw new RangeError(`${PIN_TOOL_NAME} expects an object`)
  const o = raw as Record<string, unknown>
  if (typeof o.text !== "string" || o.text.trim().length === 0) {
    throw new RangeError("`text` must be a non-empty string")
  }
  const text = o.text.trim()
  // 报错仍报声明上限：模型该往 500 以内凑，容差只是不为数错的几个字白费一轮
  if (text.length > Math.ceil(maxTextLength * (1 + overshootTolerance))) {
    throw new RangeError(
      `\`text\` is ${text.length} characters; pins are limited to ${maxTextLength}. Split it across several notes or put it in your compact summary instead.`,
    )
  }
  if (o.replaces !== undefined && (typeof o.replaces !== "string" || o.replaces.trim().length === 0)) {
    throw new RangeError("`replaces` must be a non-empty string when given")
  }
  return typeof o.replaces === "string" ? { text, replaces: o.replaces.trim() } : { text }
}

export function isPinNoteEvent(e: Event): e is PinNote {
  return e.type === "core.system_note" && (e as PinNote).payload.kind === "pin"
}

export function pinMetaOf(e: PinNote): PinMeta | undefined {
  const m = e.payload.meta?.pin
  if (typeof m !== "object" || m === null) return undefined
  const source = (m as { source?: unknown }).source
  if (source !== "host" && source !== "model") return undefined
  const spec = (m as { spec?: unknown }).spec
  return typeof spec === "string" ? { source, spec } : { source }
}

/** 某个宿主 spec 最后一条 pin（从后往前找） */
export function lastHostPin(events: readonly Event[], spec: string): PinNote | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Event
    if (!isPinNoteEvent(e)) continue
    const meta = pinMetaOf(e)
    if (meta?.source === "host" && meta.spec === spec) return e
  }
  return undefined
}

/** 模型钉的、文字完全相同的一条（从后往前找） */
export function findModelPin(events: readonly Event[], text: string): PinNote | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Event
    if (isPinNoteEvent(e) && pinMetaOf(e)?.source === "model" && e.payload.text === text) return e
  }
  return undefined
}

interface NormalizedSpec {
  name: string
  text?: string
  extract?: (ctx: TurnContext) => string | undefined
}

function normalizeSpecs(specs: readonly PinSpec[]): NormalizedSpec[] {
  const out: NormalizedSpec[] = []
  const names = new Set<string>()
  for (const spec of specs) {
    const n: NormalizedSpec =
      typeof spec === "string"
        ? { name: spec, text: spec }
        : "text" in spec
          ? { name: spec.name, text: spec.text }
          : { name: spec.name, extract: spec.extract }
    if (n.name.trim().length === 0) throw new RangeError("pins: a spec name must not be empty")
    if (names.has(n.name)) throw new RangeError(`pins: duplicate spec name ${JSON.stringify(n.name)}`)
    if (n.text !== undefined && n.text.trim().length === 0) {
      throw new RangeError(`pins: the text of static pin ${JSON.stringify(n.name)} must not be empty`)
    }
    if (n.extract !== undefined && typeof n.extract !== "function") {
      throw new RangeError(`pins: extract of spec ${JSON.stringify(n.name)} must be a function`)
    }
    names.add(n.name)
    out.push(n)
  }
  return out
}

function pinDraft(
  text: string,
  meta: PinMeta,
  actor: "system" | "model",
  extra: { supersedes?: string; parentId?: string; provenanceRef?: string },
): EventDraft<"core.system_note", PinNote["payload"]> {
  const payload: PinNote["payload"] = { kind: "pin", text, meta: { pin: meta } }
  if (extra.supersedes !== undefined) payload.supersedes = [extra.supersedes]
  const draft: EventDraft<"core.system_note", PinNote["payload"]> = {
    type: "core.system_note",
    actor,
    payload,
    provenance:
      extra.provenanceRef !== undefined
        ? { source: PINS_SOCKET_NAME, ref: extra.provenanceRef }
        : { source: PINS_SOCKET_NAME },
  }
  if (extra.parentId !== undefined) draft.parentId = extra.parentId
  return draft
}

function replaceResult(result: ToolResultDraft, text: string, isError: boolean): ToolResultDraft {
  return { ...result, payload: { ...result.payload, content: [{ type: "text", text }], isError } }
}

/** 占位回执：正常情况下 afterTool 会把它换掉；看到这句话说明 pins 的 Socket 没装 */
const PLACEHOLDER = `The ${PIN_TOOL_NAME} tool is present but its Socket is not installed; nothing was pinned.`

export function pins(opts: PinsOptions = {}): Socket {
  const specs = normalizeSpecs(opts.pins ?? [])
  const withTool = opts.tool ?? true
  const maxTextLength = opts.maxTextLength ?? DEFAULT_MAX_PIN_TEXT_LENGTH
  if (!Number.isInteger(maxTextLength) || maxTextLength < 1) {
    throw new RangeError(`pins.maxTextLength must be an integer >= 1, got ${String(maxTextLength)}`)
  }
  const tolerance = opts.overshootTolerance ?? DEFAULT_PIN_OVERSHOOT_TOLERANCE
  if (!(tolerance >= 0 && tolerance < 1)) {
    throw new RangeError(`pins.overshootTolerance must be within [0, 1), got ${String(tolerance)}`)
  }
  if (specs.length === 0 && !withTool) {
    throw new RangeError("pins: with neither host pins nor a model-facing tool this socket does nothing")
  }

  const tool: Tool = {
    name: PIN_TOOL_NAME,
    description: pinToolDescription(maxTextLength),
    inputSchema: pinInputSchema(maxTextLength) as unknown as Record<string, unknown>,
    validate: (raw) => parsePinArgs(raw, maxTextLength, tolerance),
    risk: "low",
    execute: () => PLACEHOLDER,
  }

  const socket: Socket = {
    name: PINS_SOCKET_NAME,

    beforeModel(ctx: TurnContext) {
      for (const spec of specs) {
        const raw = spec.text ?? spec.extract?.(ctx)
        const text = raw?.trim()
        if (!text) continue // 抽取函数这轮没新说法：上一条继续生效
        const visible = lastHostPin(ctx.events, spec.name)
        if (visible?.payload.text === text) continue
        // 视图里没有（首轮 / 被折叠掉）或文字变了：追加一条；取代该 spec 在完整时间线里的上一条（可能已不可见）
        const previous = lastHostPin(ctx.timeline, spec.name)
        const extra: { supersedes?: string; provenanceRef: string } = { provenanceRef: spec.name }
        if (previous) extra.supersedes = previous.id
        ctx.emit(pinDraft(text, { source: "host", spec: spec.name }, "system", extra))
      }
      return undefined
    },

    afterTool(ctx: TurnContext, call: ToolCallEvent, result: ToolResultDraft) {
      if (!withTool || call.payload.name !== PIN_TOOL_NAME || result.payload.isError) return undefined
      // 入参已由 validate 校验过；重新解析拿规范形态（循环不把校验后的入参传给 afterTool）
      let args: PinArgs
      try {
        args = parsePinArgs(call.payload.args, maxTextLength, tolerance)
      } catch (err) {
        return replaceResult(result, err instanceof Error ? err.message : String(err), true)
      }

      let replaced: PinNote | undefined
      if (args.replaces !== undefined) {
        replaced = findModelPin(ctx.events, args.replaces)
        if (!replaced) {
          const hostHit = ctx.events.find(
            (e) => isPinNoteEvent(e) && e.payload.text === args.replaces && pinMetaOf(e)?.source === "host",
          )
          return replaceResult(
            result,
            hostHit
              ? "That note was pinned by the host and cannot be replaced."
              : "No note pinned by you matches `replaces` exactly. Check the visible pinned notes and pass the text verbatim.",
            true,
          )
        }
        if (replaced.payload.text === args.text) {
          return replaceResult(
            result,
            "That note is already pinned with the same text; nothing changed.",
            false,
          )
        }
      } else if (findModelPin(ctx.events, args.text)) {
        return replaceResult(result, "Already pinned; nothing changed.", false)
      }

      const extra: { supersedes?: string; parentId: string; provenanceRef: string } = {
        parentId: call.id,
        provenanceRef: call.payload.toolCallId,
      }
      if (replaced) extra.supersedes = replaced.id
      ctx.emit(pinDraft(args.text, { source: "model" }, "model", extra))
      return replaceResult(
        result,
        replaced
          ? "Pinned, replacing the earlier note. The old note will not survive the next compaction."
          : "Pinned. This note will survive compaction verbatim until you replace it.",
        false,
      )
    },
  }
  if (withTool) socket.tools = [tool]
  if (withTool && opts.rules !== false) socket.systemPrompt = opts.rules ?? PIN_RULES
  return socket
}
