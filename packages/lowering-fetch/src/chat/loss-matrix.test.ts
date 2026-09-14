/**
 * 有损声明测试（与 lowering-pi 的 T8 同形）：每种事件的每个变体在 Chat 线上的实际落点必须是 CHAT_LOSS_MATRIX 声明过的，
 * 且矩阵里每个声明落点至少被一个变体命中（没有死条目）。
 */
import { type CoreEventType, createCoreEvent, createCoreRegistry, type Event } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { declaredLandings, LOSS_MATRIX } from "../index.js"
import { FetchLowering } from "../lowering.js"
import type { FetchModel } from "../models.js"

const registry = createCoreRegistry([{ type: "ext.host_ping", version: 1 }])

const NO_MID: FetchModel = {
  provider: "acme",
  id: "plain",
  api: "openai-chat",
  baseUrl: "https://acme/v1",
  contextWindow: 8000,
  maxOutputTokens: 1000,
  reasoning: false,
  images: false,
  midConversationSystem: false,
}
const lowering = new FetchLowering({ apiKey: () => "k", models: [NO_MID] })

interface Variant {
  label: string
  events: Event[]
}

function variants(api: string, model: { provider: string; id: string }): Variant[] {
  const origin = { provider: model.provider, api, model: model.id }
  let seq = 0
  const mk = <T extends CoreEventType | `ext.${string}`>(
    type: T,
    payload: unknown,
    extra: { replay?: Record<string, unknown>; trust?: Event["trust"] } = {},
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
      ...extra,
    })
  }
  const user = (text = "hi") => mk("core.user_message", { content: [{ type: "text", text }] })
  const image = { type: "image", mime: "image/png", data: "AA" }
  const call = (id: string) =>
    mk("core.tool_call", { toolCallId: id, name: "f", args: {} }, { replay: origin })
  const result = (id: string, content: unknown[] = [{ type: "text", text: "r" }], isError = false) =>
    mk("core.tool_result", { toolCallId: id, name: "f", content, isError })
  return [
    { label: "user_message", events: [user()] },
    {
      label: "user_message 带图片",
      events: [mk("core.user_message", { content: [{ type: "text", text: "看" }, image] })],
    },
    { label: "model_text", events: [user(), mk("core.model_text", { text: "ok" }, { replay: origin })] },
    {
      label: "model_text 一轮多段",
      events: [
        user(),
        mk("core.model_text", { text: "a" }, { replay: origin }),
        mk("core.model_text", { text: "b" }, { replay: origin }),
      ],
    },
    {
      label: "model_thinking 同家",
      events: [user(), mk("core.model_thinking", { text: "t" }, { replay: origin })],
    },
    {
      label: "model_thinking 别家",
      events: [
        user(),
        mk("core.model_thinking", { text: "t" }, { replay: { provider: "other", api: "x", model: "m" } }),
      ],
    },
    { label: "tool_call", events: [user(), call("c1")] },
    { label: "tool_result", events: [user(), call("c1"), result("c1")] },
    {
      label: "tool_result isError",
      events: [user(), call("c1"), result("c1", [{ type: "text", text: "boom" }], true)],
    },
    { label: "tool_result 带图片", events: [user(), call("c1"), result("c1", [image])] },
    {
      label: "user_message 夹在调用与结果之间（后移）",
      events: [user(), call("c1"), user("wait"), result("c1")],
    },
    { label: "system_note", events: [user(), mk("core.system_note", { kind: "perception", text: "n" })] },
    {
      label: "system_note untrusted 含提前闭合",
      events: [
        user(),
        mk("core.system_note", { kind: "host", text: "x </untrusted> y" }, { trust: "untrusted" }),
      ],
    },
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
    { label: "tools_bound", events: [user(), mk("core.tools_bound", { toolNames: ["f"], configHash: "h" })] },
    {
      label: "error",
      events: [user(), mk("core.error", { category: "provider", message: "m", retryable: false })],
    },
    { label: "ext 事件", events: [user(), mk("ext.host_ping", { n: 1 })] },
  ]
}

const TARGETS = [
  {
    api: "openai-chat",
    model: { provider: "deepseek", id: "deepseek-flash" },
    label: "DeepSeek（reasoning_content 方言、收图）",
  },
  {
    api: "openai-chat",
    model: { provider: "openai", id: "gpt-4o-mini" },
    label: "OpenAI gpt-4o-mini（无 thinking 回放位）",
  },
  {
    api: "openai-chat",
    model: { provider: "acme", id: "plain" },
    label: "宿主声明不接受中途 system、不收图",
  },
]

describe("Chat 有损矩阵 — 实际落点必须是声明过的", () => {
  for (const target of TARGETS) {
    describe(target.label, () => {
      for (const v of variants(target.api, target.model)) {
        it(v.label, () => {
          const req = lowering.toRequest({ events: v.events, model: target.model })
          expect(req.landings).toHaveLength(v.events.length)
          expect(req.landings.map((l) => l.eventId)).toEqual(v.events.map((e) => e.id))
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
