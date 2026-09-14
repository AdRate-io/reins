/**
 * T8 有损声明测试：每种事件在两家 API 上实际落点必须是 LOSS_MATRIX 声明过的一种。
 * 这里逐类型、逐变体地过一遍 toRequest，矩阵漏一项就红 —— "禁止静默丢弃"由测试守着。
 */
import { type CoreEventType, createCoreEvent, createCoreRegistry, type Event } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { declaredLandings, LOSS_MATRIX } from "./loss-matrix.js"
import { PiAiLowering } from "./pi-lowering.js"

const registry = createCoreRegistry([{ type: "ext.host_ping", version: 1 }])
const lowering = new PiAiLowering({
  apiKey: () => "k",
  requestOptions: () => ({ reasoningEffort: "medium" }),
})

interface Variant {
  label: string
  events: Event[]
}

/** 每种事件至少一个变体；有条件落点的类型给出每个分支 */
function variants(api: string, model: { provider: string; id: string }): Variant[] {
  const origin = { provider: model.provider, api, model: model.id }
  let seq = 0
  const mk = <T extends CoreEventType | `ext.${string}`>(
    type: T,
    payload: unknown,
    replay?: Record<string, unknown>,
  ): Event => {
    seq += 1
    const actor =
      type === "core.user_message"
        ? "user"
        : type === "core.tool_result"
          ? "tool"
          : type.startsWith("core.model_") || type === "core.tool_call"
            ? "model"
            : "system"
    return createCoreEvent(registry, {
      type: type as CoreEventType,
      payload: payload as never,
      sessionId: "s",
      seq,
      actor,
      at: seq,
      id: `e${seq}`,
      ...(replay ? { replay } : {}),
    })
  }
  const user = () => mk("core.user_message", { content: [{ type: "text", text: "hi" }] })
  return [
    { label: "user_message", events: [user()] },
    { label: "model_text", events: [user(), mk("core.model_text", { text: "ok" }, origin)] },
    {
      label: "model_thinking 带签名",
      events: [user(), mk("core.model_thinking", { text: "t" }, { ...origin, thinkingSignature: "sig" })],
    },
    { label: "model_thinking 无签名", events: [user(), mk("core.model_thinking", { text: "t" }, origin)] },
    {
      label: "model_thinking 别家模型",
      events: [
        user(),
        mk(
          "core.model_thinking",
          { text: "t" },
          { provider: "other", api: "other-api", model: "m", thinkingSignature: "sig" },
        ),
      ],
    },
    {
      label: "tool_call 对象入参",
      events: [user(), mk("core.tool_call", { toolCallId: "c1", name: "f", args: { a: 1 } }, origin)],
    },
    {
      label: "tool_call 非对象入参",
      events: [user(), mk("core.tool_call", { toolCallId: "c1", name: "f", args: "raw" }, origin)],
    },
    {
      label: "tool_result",
      events: [
        user(),
        mk("core.tool_call", { toolCallId: "c1", name: "f", args: {} }, origin),
        mk("core.tool_result", {
          toolCallId: "c1",
          name: "f",
          content: [{ type: "text", text: "r" }],
          isError: false,
        }),
      ],
    },
    {
      label: "user_message 夹在 tool_call 与 tool_result 之间（后移）",
      events: [
        user(),
        mk("core.tool_call", { toolCallId: "c1", name: "f", args: {} }, origin),
        user(),
        mk("core.tool_result", {
          toolCallId: "c1",
          name: "f",
          content: [{ type: "text", text: "r" }],
          isError: false,
        }),
      ],
    },
    { label: "system_note", events: [user(), mk("core.system_note", { kind: "perception", text: "n" })] },
    {
      label: "compaction",
      events: [
        mk("core.compaction", { coversSeq: [1, 2], summary: "s", decidedBy: "model", pinsKept: [] }),
        user(),
      ],
    },
    {
      label: "approval_request",
      events: [user(), mk("core.approval_request", { toolCallId: "c", policyId: "p", summary: "s" })],
    },
    {
      label: "approval_decision",
      events: [user(), mk("core.approval_decision", { toolCallId: "c", approved: true, by: "u" })],
    },
    { label: "run_paused", events: [user(), mk("core.run_paused", { reason: "approval" })] },
    { label: "run_resumed", events: [user(), mk("core.run_resumed", {})] },
    {
      label: "budget_usage",
      events: [user(), mk("core.budget_usage", { tokens: { input: 1, output: 1 }, toolCalls: 0, wallMs: 0 })],
    },
    { label: "memory_op", events: [user(), mk("core.memory_op", { op: "view", path: "/memories/a" })] },
    {
      label: "handoff",
      events: [user(), mk("core.handoff", { toSessionId: "s2", summary: "s", reason: "r" })],
    },
    {
      label: "error",
      events: [user(), mk("core.error", { category: "provider", message: "m", retryable: false })],
    },
    { label: "ext 事件", events: [user(), mk("ext.host_ping", { n: 1 })] },
  ]
}

const TARGETS = [
  {
    api: "anthropic-messages",
    model: { provider: "anthropic", id: "claude-opus-5" },
    label: "Anthropic Opus 5（支持中途 system）",
  },
  {
    api: "anthropic-messages",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    label: "Anthropic Sonnet 5（不支持中途 system）",
  },
  {
    api: "openai-responses",
    model: { provider: "openai", id: "gpt-5.4" },
    label: "OpenAI Responses gpt-5.4（reasoning）",
  },
  {
    api: "openai-responses",
    model: { provider: "openai", id: "gpt-4.1" },
    label: "OpenAI Responses gpt-4.1（非 reasoning）",
  },
]

describe("有损矩阵 — 实际落点必须是声明过的", () => {
  for (const target of TARGETS) {
    describe(target.label, () => {
      for (const v of variants(target.api, target.model)) {
        it(v.label, () => {
          const req = lowering.toRequest({ events: v.events, model: target.model })
          expect(req.landings).toHaveLength(v.events.length)
          for (const landing of req.landings) {
            const declared = declaredLandings(target.api, landing.type)
            const hit = declared.find((d) => d.kind === landing.kind && d.landing === landing.landing)
            expect(hit, `${landing.type} 落到 ${landing.kind}/${landing.landing}，矩阵未声明`).toBeDefined()
          }
        })
      }
    })
  }

  it("矩阵里每个声明落点都至少被某个变体命中过（没有死条目）", () => {
    const seen = new Set<string>()
    for (const target of TARGETS) {
      for (const v of variants(target.api, target.model)) {
        for (const l of lowering.toRequest({ events: v.events, model: target.model }).landings) {
          const key = l.type.startsWith("ext.") ? "ext.*" : l.type
          seen.add(`${target.api}|${key}|${l.kind}|${l.landing}`)
        }
      }
    }
    const dead: string[] = []
    for (const [api, table] of Object.entries(LOSS_MATRIX)) {
      for (const [type, specs] of Object.entries(table)) {
        for (const s of specs)
          if (!seen.has(`${api}|${type}|${s.kind}|${s.landing}`))
            dead.push(`${api} ${type} ${s.kind}/${s.landing}`)
      }
    }
    expect(dead).toEqual([])
  })
})
