/**
 * 脚本化降级层：按剧本逐轮吐出预设的事件草稿，不联网。
 * 给循环、脑子模块与适配器写单测用 —— 只关心"模型看到了什么、说了什么"，不关心线协议。
 * 每次 toRequest 的输入都留在 requests 里，测试据此断言模型每轮看到的事件。
 */
import type { CoreEventDraft, EventDraft } from "../events/create.js"
import type {
  LandingRecord,
  LoweredRequest,
  Lowering,
  LoweringCapabilities,
  LoweringOutcome,
  LoweringStreamContext,
  ModelRef,
  ToRequestInput,
} from "../lowering/types.js"

export interface ScriptedTurn {
  drafts: readonly CoreEventDraft[]
  /** 缺省：有 tool_call 则 toolUse，否则 stop；用量固定 input 10 / output 5 */
  outcome?: Partial<LoweringOutcome>
  /** 模拟 stream 中途抛异常（网络断开等）；先吐完 drafts 再抛 */
  throws?: Error
}

export interface ScriptedPayload {
  turn: number
  input: ToRequestInput
}

export type Script = readonly ScriptedTurn[] | ((input: ToRequestInput, turn: number) => ScriptedTurn)

export const SCRIPTED_CAPABILITIES: LoweringCapabilities = {
  api: "scripted",
  midConversationSystem: true,
  thinkingReplay: true,
  parallelTools: true,
  taskBudget: false,
  deferredTools: false,
  images: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
}

export class ScriptedLowering implements Lowering<ScriptedPayload> {
  /** 每次 toRequest 的输入，按调用顺序 */
  readonly requests: ToRequestInput[] = []
  private turn = 0
  private readonly caps: LoweringCapabilities

  constructor(
    private readonly script: Script,
    opts: { capabilities?: Partial<LoweringCapabilities> } = {},
  ) {
    this.caps = { ...SCRIPTED_CAPABILITIES, ...opts.capabilities }
  }

  capabilities(_model: ModelRef): LoweringCapabilities {
    return this.caps
  }

  toRequest(input: ToRequestInput): LoweredRequest<ScriptedPayload> {
    this.requests.push(input)
    const landings: LandingRecord[] = input.events.map((e) => ({
      eventId: e.id,
      type: e.type,
      kind: "exact",
      landing: "scripted",
    }))
    const turn = this.turn++
    return { model: input.model, capabilities: this.caps, landings, payload: { turn, input } }
  }

  async *stream(
    req: LoweredRequest<ScriptedPayload>,
    ctx: LoweringStreamContext = {},
  ): AsyncGenerator<EventDraft, LoweringOutcome> {
    const step = this.turnAt(req.payload.turn, req.payload.input)
    for (const d of step.drafts) {
      if (d.type === "core.model_text") ctx.onDelta?.({ kind: "text", index: 0, delta: d.payload.text })
      yield d
    }
    if (step.throws) throw step.throws
    const hasToolCall = step.drafts.some((d) => d.type === "core.tool_call")
    return {
      stopReason: hasToolCall ? "toolUse" : "stop",
      usage: { input: 10, output: 5 },
      ...step.outcome,
    }
  }

  private turnAt(turn: number, input: ToRequestInput): ScriptedTurn {
    if (typeof this.script === "function") return this.script(input, turn)
    const step = this.script[turn]
    if (!step) throw new Error(`剧本只有 ${this.script.length} 轮，第 ${turn + 1} 轮没有台词`)
    return step
  }
}

// ---- 草稿速写 ----

export const say = (text: string): CoreEventDraft => ({
  type: "core.model_text",
  actor: "model",
  payload: { text },
})

export const think = (text: string): CoreEventDraft => ({
  type: "core.model_thinking",
  actor: "model",
  payload: { text },
  replay: { provider: "scripted", api: "scripted", model: "scripted", thinkingSignature: `sig:${text}` },
})

export const callTool = (toolCallId: string, name: string, args: unknown): CoreEventDraft => ({
  type: "core.tool_call",
  actor: "model",
  payload: { toolCallId, name, args },
})
