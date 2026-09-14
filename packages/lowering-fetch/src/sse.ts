/**
 * Server-Sent Events 解析（WHATWG 规范的字段子集）：`event:` / `data:` / `id:`，多行 data 以 \n 拼接，
 * 空行分发一条消息，`:` 开头是注释，`retry:` 与未知字段忽略。行尾兼容 \r\n、\n、\r。
 *
 * 比规范宽一处：流结束时缓冲区里还有没被空行收口的消息，也照样分发——部分上游最后一条事件后不发空行。
 * `data` 的 JSON 解析不在这里做：`[DONE]` 这类哨兵是各协议自己的约定。
 */

export interface SseMessage {
  event?: string
  data: string
  id?: string
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event: string | undefined
  let id: string | undefined
  const data: string[] = []

  const flush = (): SseMessage | undefined => {
    const msg: SseMessage = { data: data.join("\n") }
    if (event !== undefined) msg.event = event
    if (id !== undefined) msg.id = id
    const empty = data.length === 0 && event === undefined
    event = undefined
    id = undefined
    data.length = 0
    // 只有 id 或什么都没有的空消息不分发（规范：data 为空且无 event 时忽略）
    return empty ? undefined : msg
  }
  const line = (raw: string): SseMessage | undefined => {
    if (raw === "") return flush()
    if (raw.startsWith(":")) return undefined
    const colon = raw.indexOf(":")
    const field = colon === -1 ? raw : raw.slice(0, colon)
    let value = colon === -1 ? "" : raw.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    switch (field) {
      case "data":
        data.push(value)
        break
      case "event":
        event = value
        break
      case "id":
        id = value
        break
      default:
        break
    }
    return undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      // 逐行切；最后一段可能是半行，留到下一块（done 时整段都算完整）
      let start = 0
      while (true) {
        const nl = buffer.indexOf("\n", start)
        const cr = buffer.indexOf("\r", start)
        let end = -1
        let skip = 1
        if (nl === -1 && cr === -1) break
        if (cr !== -1 && (nl === -1 || cr < nl)) {
          end = cr
          // \r\n 算一个换行；\r 恰在块尾时看不到后面的 \n，留到下一块再判
          if (cr === buffer.length - 1 && !done) break
          if (buffer[cr + 1] === "\n") skip = 2
        } else end = nl
        const msg = line(buffer.slice(start, end))
        if (msg) yield msg
        start = end + skip
      }
      buffer = buffer.slice(start)
      if (done) break
    }
    if (buffer !== "") {
      const msg = line(buffer)
      if (msg) yield msg
    }
    const tail = flush()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}
