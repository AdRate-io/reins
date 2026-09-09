/**
 * 假 Anthropic Messages 端点 —— 跑在 Node 里（不在 workerd 里），只为让 worker 侧走一遍完整的
 * fetch → SSE 解析 → 事件草稿链路，不花钱、不依赖外网、结果确定。
 *
 * 刻意做了两件事来压测流式解析：
 *   1. 工具入参切成两个 input_json_delta（测 pi-ai 的 partial-json 增量拼装）；
 *   2. 把 SSE 事件在**字节层**切碎乱发（一个 event 可能横跨两个 TCP 包），测 TextDecoder + 行缓冲重组。
 * 走 Anthropic SDK 的路径：它会在 baseUrl 后接 /v1/messages，所以这里就监听那个路径。
 */
import { createServer } from "node:http"

const FRAMES = [
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "fake-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 123,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ],
  [
    "content_block_start",
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "用户问上海天气，我该先调 get_weather。" },
    },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "ZmFrZS1zaWduYXR1cmUtZm9yLWVkZ2UtcHJvYmU=" },
    },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "content_block_start",
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_fake_1", name: "get_weather", input: {} },
    },
  ],
  // 入参故意切两段，第二段才补齐 JSON
  [
    "content_block_delta",
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"上海"}' } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 42 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]

const server = createServer((req, res) => {
  if (!req.url?.includes("messages")) {
    process.stderr.write(`[假端点] 路径不匹配，实际收到: ${req.url}\n`)
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("only /v1/messages")
    return
  }
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    // 把 worker 发来的请求体落到 stderr，便于人工核对（不参与断言）
    process.stderr.write(
      `[假端点] ${req.method} ${req.url} 收到 ${body.length} 字节；头部含 x-api-key=${Boolean(req.headers["x-api-key"])} anthropic-version=${req.headers["anthropic-version"] ?? "(无)"}\n`,
    )
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    // 拼成完整 SSE 文本后按字节切碎乱发，逼解析器自己做行缓冲重组
    const text = FRAMES.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("")
    const bytes = Buffer.from(text, "utf8")
    let i = 0
    const tick = () => {
      if (i >= bytes.length) {
        res.end()
        return
      }
      const n = Math.min(bytes.length - i, 7 + (i % 23)) // 7~29 字节一包，故意不对齐事件边界
      res.write(bytes.subarray(i, i + n))
      i += n
      setTimeout(tick, 1)
    }
    tick()
  })
})

const port = Number(process.env.FAKE_PORT ?? 8787)
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`FAKE_READY http://127.0.0.1:${port}\n`)
})
