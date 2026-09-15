import { createCoreEvent, createCoreRegistry, type Event } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { JsonlParseError, parseEventsJsonl, toEventsJsonl } from "./jsonl.js"

const registry = createCoreRegistry()
const events: Event[] = [
  createCoreEvent(registry, {
    sessionId: "j",
    seq: 1,
    at: 1,
    type: "core.user_message",
    actor: "user",
    payload: { content: [{ type: "text", text: "hi" }] },
  }),
  createCoreEvent(registry, {
    sessionId: "j",
    seq: 2,
    at: 2,
    type: "core.model_text",
    actor: "model",
    payload: { text: "yo" },
  }),
]

describe("JSONL 读写", () => {
  it("往返一致；空行跳过；末尾带换行", () => {
    const text = toEventsJsonl(events)
    expect(text.endsWith("\n")).toBe(true)
    expect(parseEventsJsonl(`\n${text}\n  \n`)).toEqual(events)
    expect(toEventsJsonl([])).toBe("")
  })

  it("坏 JSON 与未登记类型都报错并带行号（fail-closed）", () => {
    const text = `${JSON.stringify(events[0])}\n{not json\n`
    expect(() => parseEventsJsonl(text)).toThrow(JsonlParseError)
    expect(() => parseEventsJsonl(text)).toThrow(/line 2/)

    const ext = { ...events[1], type: "ext.unknown", seq: 2 }
    const t2 = `${JSON.stringify(events[0])}\n${JSON.stringify(ext)}\n`
    expect(() => parseEventsJsonl(t2)).toThrow(/line 2/)
    // 未来版本也拒
    const future = { ...events[1], schemaVersion: 99 }
    expect(() => parseEventsJsonl(JSON.stringify(future))).toThrow(/line 1/)
  })
})
