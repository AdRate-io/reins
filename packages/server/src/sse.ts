/**
 * SSE 编码：帧 → 文本；以及缺省编码器（原样推时间线事件）。
 *
 * 帧格式遵循 WHATWG Server-Sent Events：`event:` / `id:` / `data:` 各占一行，空行结束一帧。
 * data 一律 JSON.stringify，字符串里的换行被转义，所以一帧只需一行 data。
 */
import type { SseFrame, StreamEncoder, StreamItem } from "./types.js"

export function encodeSseFrame(frame: SseFrame): string {
  let out = ""
  if (frame.event !== undefined) out += `event: ${frame.event}\n`
  if (frame.id !== undefined) out += `id: ${frame.id}\n`
  out += `data: ${JSON.stringify(frame.data)}\n\n`
  return out
}

/** 注释行：客户端忽略，只为让代理知道连接还活着 */
export const SSE_HEARTBEAT = ": ping\n\n"

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  // nginx 缺省会缓冲上游响应，这个头让它逐帧放行
  "x-accel-buffering": "no",
}

/**
 * 缺省编码器：时间线事件不带 event 名（落到 EventSource.onmessage），`id:` = seq；
 * 控制项带 event 名（start / delta / result / end / error），只监听 onmessage 的客户端自然看不到它们。
 */
export const rawEncoder: StreamEncoder = (item: StreamItem) => {
  switch (item.kind) {
    case "start":
      return [{ event: "start", data: { sessionId: item.sessionId, fromSeq: item.fromSeq, live: item.live } }]
    case "event":
      return [{ id: String(item.event.seq), data: item.event }]
    case "delta":
      return [{ event: "delta", data: item.delta }]
    case "result":
      return [{ event: "result", data: item.result }]
    case "end":
      return [{ event: "end", data: { sessionId: item.sessionId, lastSeq: item.lastSeq } }]
    case "error":
      return [{ event: "error", data: { code: item.code, message: item.message } }]
  }
}
