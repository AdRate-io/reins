/**
 * eventsToContext 的顺序规则：并行工具时落在两条 tool_result 之间的说明 / 摘要后移到同批结果之后。
 * 真实触发场景（E3 跑数）：模型并行调 memory 与 pin，pin 的留痕说明排在自己的结果之前，把 tool_result 拆成两段，
 * DeepSeek 报 400 "Each tool_result block must have a corresponding tool_use block in the previous message"。
 */
import {
  type CoreEventPayloads,
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  type Event,
} from "@reins/core"
import { describe, expect, it } from "vitest"
import { eventsToContext } from "./to-request.js"

const registry = createCoreRegistry()
let seq = 0
const ev = <T extends CoreEventType>(type: T, actor: Event["actor"], payload: CoreEventPayloads[T]): Event =>
  createCoreEvent(registry, {
    type,
    actor,
    payload,
    sessionId: "s",
    seq: ++seq,
    at: 1000 + seq,
    id: `e${seq}`,
  })

const model = { provider: "anthropic", id: "m", api: "anthropic-messages", reasoning: true } as Parameters<
  typeof eventsToContext
>[0]["model"]
const caps = (midConversationSystem: boolean) =>
  ({ midConversationSystem, api: "anthropic-messages" }) as Parameters<
    typeof eventsToContext
  >[0]["capabilities"]

const result = (id: string) =>
  ev("core.tool_result", "tool", {
    toolCallId: id,
    name: "t",
    content: [{ type: "text", text: id }],
    isError: false,
  })

describe("eventsToContext：说明后移", () => {
  it("两条 tool_result 之间的 system_note 后移到同批结果之后，落点备注说明后移；支持 / 不支持中途 system 都一样", () => {
    for (const mid of [true, false]) {
      seq = 0
      const events = [
        ev("core.user_message", "user", { content: [{ type: "text", text: "go" }] }),
        ev("core.tool_call", "model", { toolCallId: "a", name: "t", args: {} }),
        ev("core.tool_call", "model", { toolCallId: "b", name: "t", args: {} }),
        result("a"),
        ev("core.system_note", "model", { kind: "pin", text: "pinned" }),
        result("b"),
        ev("core.model_text", "model", { text: "ok" }),
      ]
      const { context, landings } = eventsToContext({ events, model, capabilities: caps(mid) })
      expect(
        context.messages.map((m) => (m.role === "toolResult" ? `result:${m.toolCallId}` : m.role)),
      ).toEqual([
        "user",
        "assistant",
        "result:a",
        "result:b",
        "user", // 后移的说明（标记的 system 或带标签的 user）
        "assistant",
      ])
      const note = landings.find((l) => l.type === "core.system_note")
      expect(note?.kind).toBe(mid ? "exact" : "lossy")
      expect(note?.note).toContain("已后移到同批工具结果之后")
    }
  })

  it("结果没到齐就来了新的模型输出（被拒 / 暂停未续）或用户消息：攒着的说明在它之前放出，不丢", () => {
    seq = 0
    const events = [
      ev("core.user_message", "user", { content: [{ type: "text", text: "go" }] }),
      ev("core.tool_call", "model", { toolCallId: "a", name: "t", args: {} }),
      ev("core.tool_call", "model", { toolCallId: "b", name: "t", args: {} }),
      result("a"),
      ev("core.system_note", "model", { kind: "perception", text: "status" }),
      ev("core.user_message", "user", { content: [{ type: "text", text: "next" }] }),
    ]
    const { context, landings } = eventsToContext({ events, model, capabilities: caps(true) })
    expect(
      context.messages.map((m) => (m.role === "toolResult" ? `result:${m.toolCallId}` : m.role)),
    ).toEqual([
      "user",
      "assistant",
      "result:a",
      "user", // 后移的说明
      "user", // next
    ])
    expect(landings.filter((l) => l.type === "core.system_note")).toHaveLength(1)
  })

  it("没有并行工具时说明不动：顺序与从前一致", () => {
    seq = 0
    const events = [
      ev("core.user_message", "user", { content: [{ type: "text", text: "go" }] }),
      ev("core.tool_call", "model", { toolCallId: "a", name: "t", args: {} }),
      result("a"),
      ev("core.system_note", "model", { kind: "perception", text: "status" }),
      ev("core.model_text", "model", { text: "ok" }),
    ]
    const { landings } = eventsToContext({ events, model, capabilities: caps(true) })
    expect(landings.find((l) => l.type === "core.system_note")?.note).toBeUndefined()
  })
})
