/**
 * SSE 解析：多行 data、CRLF、注释、块边界切在半行 / 多字节字符中间、末尾无空行。
 */
import { describe, expect, it } from "vitest"
import { parseSse, type SseMessage } from "./sse.js"

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c)
      controller.close()
    },
  })
}

async function all(chunks: (string | Uint8Array)[]): Promise<SseMessage[]> {
  const out: SseMessage[] = []
  for await (const m of parseSse(streamOf(chunks))) out.push(m)
  return out
}

describe("parseSse", () => {
  it("基本消息、event / id 字段、data 前的一个空格被去掉", async () => {
    expect(await all(['event: ping\nid: 1\ndata: {"a":1}\n\n'])).toEqual([
      { event: "ping", id: "1", data: '{"a":1}' },
    ])
  })

  it("多行 data 以 \\n 拼接；注释与未知字段忽略", async () => {
    expect(await all([": keep-alive\nretry: 3000\ndata: line1\ndata: line2\n\n"])).toEqual([
      { data: "line1\nline2" },
    ])
  })

  it("CRLF 与裸 CR 都算换行，包括 \\r 恰好切在块尾", async () => {
    expect(await all(["data: a\r\n\r\ndata: b\r", "\n\r\n", "data: c\r\r"])).toEqual([
      { data: "a" },
      { data: "b" },
      { data: "c" },
    ])
  })

  it("块边界切在半行与多字节字符中间不影响结果", async () => {
    const bytes = new TextEncoder().encode("data: 你好\n\ndata: [DONE]\n\n")
    const cut = 8 // 切在"你"的三个字节中间
    expect(await all([bytes.slice(0, cut), bytes.slice(cut, cut + 3), bytes.slice(cut + 3)])).toEqual([
      { data: "你好" },
      { data: "[DONE]" },
    ])
  })

  it("流结束时没有收口空行的消息也分发；只有 id 的空消息不分发", async () => {
    expect(await all(["id: 9\n\ndata: tail"])).toEqual([{ data: "tail" }])
  })

  it("空流不产出任何消息", async () => {
    expect(await all([])).toEqual([])
  })
})
