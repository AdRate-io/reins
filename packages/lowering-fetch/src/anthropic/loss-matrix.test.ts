/**
 * 有损声明测试（与 Chat 线、lowering-pi 的 T8 同形）：每种事件的每个变体在 Anthropic 线上的实际落点必须是矩阵声明过的，
 * 且矩阵里每个声明落点至少被一个变体命中（没有死条目）。变体覆盖 S1 摆放的每种情形与 thinking 的四种来源。
 */
import {
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  type Event,
  type ToolSpec,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { declaredLandings, LOSS_MATRIX } from "../index.js"
import { FetchLowering } from "../lowering.js"
import type { FetchModel } from "../models.js"

const registry = createCoreRegistry([{ type: "ext.host_ping", version: 1 }])

/** 第三方 Anthropic 协议上游：宿主声明支持中途 system、不收图 */
const COMPAT: FetchModel = {
  provider: "acme",
  id: "compat",
  api: "anthropic-messages",
  baseUrl: "https://acme/anthropic/v1",
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  reasoning: true,
  images: false,
  midConversationSystem: true,
}
const lowering = new FetchLowering({ apiKey: () => "k", models: [COMPAT] })

interface Variant {
  label: string
  events: Event[]
  /** 本次请求的工具表（L1 引用变体需要：引用只能指向表里的工具） */
  tools?: ToolSpec[]
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
  const text = (t = "ok") => mk("core.model_text", { text: t }, { replay: origin })
  const image = { type: "image", mime: "image/png", data: "AA" }
  const call = (id: string, args: unknown = {}) =>
    mk("core.tool_call", { toolCallId: id, name: "f", args }, { replay: origin })
  const result = (id: string, content: unknown[] = [{ type: "text", text: "r" }], isError = false) =>
    mk("core.tool_result", { toolCallId: id, name: "f", content, isError })
  const note = (t = "n") => mk("core.system_note", { kind: "perception", text: t })
  const sysResult = (content: unknown[]) =>
    mk(
      "core.tool_result",
      { toolCallId: "c1", name: "tool_find", content, isError: false },
      { trust: "system" },
    )
  return [
    { label: "user_message", events: [user()] },
    {
      label: "user_message 空内容",
      events: [mk("core.user_message", { content: [{ type: "text", text: "" }] })],
    },
    {
      label: "user_message 带图片",
      events: [mk("core.user_message", { content: [{ type: "text", text: "看" }, image] })],
    },
    { label: "model_text", events: [user(), text()] },
    { label: "model_text 空正文", events: [user(), text("")] },
    {
      label: "model_thinking 带签名",
      events: [
        user(),
        mk("core.model_thinking", { text: "t" }, { replay: { ...origin, thinkingSignature: "sig" } }),
      ],
    },
    {
      label: "model_thinking redacted",
      events: [
        user(),
        mk(
          "core.model_thinking",
          { text: "[Reasoning redacted]" },
          { replay: { ...origin, thinkingSignature: "d", redacted: true } },
        ),
      ],
    },
    {
      label: "model_thinking 无签名",
      events: [user(), mk("core.model_thinking", { text: "t" }, { replay: origin })],
    },
    {
      label: "model_thinking 别家",
      events: [
        user(),
        mk(
          "core.model_thinking",
          { text: "t" },
          { replay: { provider: "other", api: "x", model: "m", thinkingSignature: "s" } },
        ),
      ],
    },
    { label: "tool_call", events: [user(), call("c1")] },
    { label: "tool_call 非对象入参", events: [user(), call("c1", "raw")] },
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
    { label: "system_note 收尾", events: [user(), note()] },
    { label: "system_note 夹在 user 与 assistant 之间", events: [user(), note(), text()] },
    { label: "system_note 首条", events: [note(), text(), user()] },
    { label: "system_note 跟在 assistant 后", events: [user(), text(), note(), text()] },
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
    // L1：工具定义引用（有原生能力的模型：exact tool-reference / lossy tool-reference / lossy tool_result；无能力或 untrusted：exact tool_result）
    {
      label: "tool_result 只有工具引用（已绑定、system 信任）",
      events: [user(), call("c1"), sysResult([refG])],
      tools: specs,
    },
    {
      label: "tool_result 工具引用 + 文本（system 信任）",
      events: [user(), call("c1"), sysResult([{ type: "text", text: "Loaded" }, refG])],
      tools: specs,
    },
    { label: "tool_result 工具引用未绑定（system 信任）", events: [user(), call("c1"), sysResult([refG])] },
    {
      label: "tool_result 工具引用但结果 untrusted",
      events: [user(), call("c1"), result("c1", [refG])],
      tools: specs,
    },
  ]
}

const refG = { type: "tool_reference", name: "g", description: "dg", inputSchema: { type: "object" } }
const specs: ToolSpec[] = [
  { name: "f", description: "d", inputSchema: { type: "object" } },
  { name: "g", description: "dg", inputSchema: { type: "object" }, deferLoading: true },
]

const TARGETS = [
  {
    api: "anthropic-messages",
    model: { provider: "anthropic", id: "claude-opus-5" },
    label: "Opus 5（支持中途 system、收图）",
  },
  {
    api: "anthropic-messages",
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
    label: "Haiku 4.5（不支持中途 system）",
  },
  {
    api: "anthropic-messages",
    model: { provider: "acme", id: "compat" },
    label: "宿主声明的兼容上游（中途 system、不收图）",
  },
]

describe("Anthropic 有损矩阵 — 实际落点必须是声明过的", () => {
  for (const target of TARGETS) {
    describe(target.label, () => {
      for (const v of variants(target.api, target.model)) {
        it(v.label, () => {
          const req = lowering.toRequest({
            events: v.events,
            model: target.model,
            ...(v.tools ? { tools: v.tools } : {}),
          })
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
        for (const l of lowering.toRequest({
          events: v.events,
          model: target.model,
          ...(v.tools ? { tools: v.tools } : {}),
        }).landings) {
          const key = l.type.startsWith("ext.") ? "ext.*" : l.type
          seen.add(`${key}|${l.kind}|${l.landing}`)
        }
      }
    }
    const dead: string[] = []
    for (const [type, specs] of Object.entries(LOSS_MATRIX["anthropic-messages"] ?? {})) {
      for (const s of specs)
        if (!seen.has(`${type}|${s.kind}|${s.landing}`)) dead.push(`${type} ${s.kind}/${s.landing}`)
    }
    expect(dead).toEqual([])
  })
})
