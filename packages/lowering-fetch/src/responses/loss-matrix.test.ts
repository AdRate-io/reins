/**
 * 有损声明测试（与 Chat / Anthropic 线、lowering-pi 的 T8 同形）：每种事件的每个变体在 Responses 线上的实际落点必须是矩阵声明过的，
 * 且矩阵里每个声明落点至少被一个变体命中（没有死条目）。三个目标：推理模型（developer）、非推理模型（system）、
 * 宿主声明不支持中途 system 且不收图的兼容上游。
 */
import { type CoreEventType, createCoreEvent, createCoreRegistry, type Event } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { declaredLandings, LOSS_MATRIX } from "../index.js"
import { FetchLowering } from "../lowering.js"
import type { FetchModel } from "../models.js"

const registry = createCoreRegistry([{ type: "ext.host_ping", version: 1 }])

/** 第三方 Responses 协议上游：不认中途 developer / system、不收图 */
const COMPAT: FetchModel = {
  provider: "acme",
  id: "compat",
  api: "openai-responses",
  baseUrl: "https://acme/v1",
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  reasoning: true,
  images: false,
  midConversationSystem: false,
}
const lowering = new FetchLowering({ apiKey: () => "k", models: [COMPAT] })

interface Variant {
  label: string
  events: Event[]
}

/** 一个"带加密项的 reasoning 项"签名，与流侧存法一致（整项 JSON） */
const encrypted = (id = "rs_1") =>
  JSON.stringify({
    id,
    type: "reasoning",
    summary: [{ type: "summary_text", text: "t" }],
    encrypted_content: "gAAAA",
  })

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
  const text = (t = "ok", replay: Record<string, unknown> = origin) =>
    mk("core.model_text", { text: t }, { replay })
  const image = { type: "image", mime: "image/png", data: "AA" }
  const call = (id: string, args: unknown = {}, replay: Record<string, unknown> = origin) =>
    mk("core.tool_call", { toolCallId: id, name: "f", args }, { replay })
  const result = (id: string, content: unknown[] = [{ type: "text", text: "r" }], isError = false) =>
    mk("core.tool_result", { toolCallId: id, name: "f", content, isError })
  const note = (t = "n") => mk("core.system_note", { kind: "perception", text: t })
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
    { label: "model_text 带项 id", events: [user(), text("ok", { ...origin, textSignature: "msg_1" })] },
    { label: "model_text 无项 id（补一个）", events: [user(), text()] },
    {
      label: "model_text pi 版签名格式",
      events: [
        user(),
        text("ok", { ...origin, textSignature: '{"v":1,"id":"msg_pi","phase":"final_answer"}' }),
      ],
    },
    { label: "model_text 空正文", events: [user(), text("")] },
    {
      label: "model_thinking 带加密项",
      events: [
        user(),
        mk("core.model_thinking", { text: "t" }, { replay: { ...origin, thinkingSignature: encrypted() } }),
      ],
    },
    {
      label: "model_thinking 加密项来自同家别的型号",
      events: [
        user(),
        mk(
          "core.model_thinking",
          { text: "t" },
          { replay: { ...origin, model: "gpt-5", thinkingSignature: encrypted() } },
        ),
      ],
    },
    {
      label: "model_thinking 无加密项",
      events: [
        user(),
        mk(
          "core.model_thinking",
          { text: "t" },
          {
            replay: {
              ...origin,
              thinkingSignature: JSON.stringify({ id: "rs_2", type: "reasoning", summary: [] }),
            },
          },
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
          {
            replay: {
              provider: "anthropic",
              api: "anthropic-messages",
              model: "m",
              thinkingSignature: "sig",
            },
          },
        ),
      ],
    },
    { label: "tool_call 同模型带项 id", events: [user(), call("call_1", {}, { ...origin, itemId: "fc_1" })] },
    {
      label: "tool_call 同家别的型号（项 id 不带回）",
      events: [user(), call("call_1", {}, { ...origin, model: "gpt-5", itemId: "fc_1" })],
    },
    { label: "tool_call 非对象入参", events: [user(), call("call_1", "raw")] },
    { label: "tool_result", events: [user(), call("call_1"), result("call_1")] },
    {
      label: "tool_result isError",
      events: [user(), call("call_1"), result("call_1", [{ type: "text", text: "boom" }], true)],
    },
    {
      label: "tool_result 带图片",
      events: [user(), call("call_1"), result("call_1", [{ type: "text", text: "see" }, image])],
    },
    {
      label: "user_message 夹在调用与结果之间（后移）",
      events: [user(), call("call_1"), user("wait"), result("call_1")],
    },
    { label: "system_note 收尾", events: [user(), note()] },
    { label: "system_note 首条", events: [note(), user()] },
    { label: "system_note 跟在 assistant 后", events: [user(), text(), note(), user()] },
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
    api: "openai-responses",
    model: { provider: "openai", id: "gpt-5-mini" },
    label: "gpt-5-mini（推理、developer、收图）",
  },
  {
    api: "openai-responses",
    model: { provider: "openai", id: "gpt-4.1" },
    label: "gpt-4.1（非推理、system、收图）",
  },
  {
    api: "openai-responses",
    model: { provider: "acme", id: "compat" },
    label: "宿主声明的兼容上游（不支持中途 system、不收图）",
  },
]

describe("Responses 有损矩阵 — 实际落点必须是声明过的", () => {
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
          seen.add(`${key}|${l.kind}|${l.landing}`)
        }
      }
    }
    const dead: string[] = []
    for (const [type, specs] of Object.entries(LOSS_MATRIX["openai-responses"] ?? {})) {
      for (const s of specs)
        if (!seen.has(`${type}|${s.kind}|${s.landing}`)) dead.push(`${type} ${s.kind}/${s.landing}`)
    }
    expect(dead).toEqual([])
  })

  it("与 lowering-pi 的 openai-responses 表逐格对照：exact 落点同名，差异只在声明过的三格", () => {
    const table = LOSS_MATRIX["openai-responses"] ?? {}
    const exactOf = (type: string) =>
      (table[type] ?? []).filter((s) => s.kind === "exact").map((s) => s.landing)
    expect(exactOf("core.user_message")).toEqual(["user"])
    expect(exactOf("core.model_text")).toEqual(["assistant-message"])
    expect(exactOf("core.model_thinking")).toEqual(["reasoning-item"])
    expect(exactOf("core.tool_call")).toEqual(["function_call"])
    expect(exactOf("core.tool_result")).toEqual(["function_call_output"])
    expect(exactOf("core.system_note")).toEqual(["developer", "system"])
    // 差异格：pi 版无签名 thinking 是 lossy(text-or-drop)、这里 dropped；pi 版非对象入参 lossy(wrapped-args)、这里 exact；
    // pi 版 tool_result 只有 exact、这里多一格 lossy（isError 前缀 / 图片）
    expect((table["core.model_thinking"] ?? []).some((s) => s.kind === "dropped")).toBe(true)
    expect((table["core.tool_call"] ?? []).every((s) => s.kind === "exact")).toBe(true)
    expect((table["core.tool_result"] ?? []).some((s) => s.kind === "lossy")).toBe(true)
  })
})
