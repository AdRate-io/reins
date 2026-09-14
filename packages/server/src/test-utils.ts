/**
 * 测试辅助：SSE 帧解析（整段与逐帧）、可控闸门、断言用的小工具。只被 *.test.ts 引用。
 */
import type { Event } from "@reinsjs/core"

export interface Frame {
  event?: string
  id?: string
  data: unknown
}

/** 把一个 SSE 文本块（不含结尾空行）解析成帧；注释行（": ping"）返回 undefined */
function parseBlock(block: string): Frame | undefined {
  const frame: Frame = { data: undefined }
  let hasData = false
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const field = line.slice(0, idx)
    const value = line.slice(idx + 1).replace(/^ /, "")
    if (field === "event") frame.event = value
    else if (field === "id") frame.id = value
    else if (field === "data") {
      frame.data = JSON.parse(value)
      hasData = true
    }
  }
  return hasData ? frame : undefined
}

export function parseFrames(text: string): Frame[] {
  const out: Frame[] = []
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue
    const f = parseBlock(block)
    if (f) out.push(f)
  }
  return out
}

/** 逐帧读一个 SSE 响应体：能在流还没结束时就拿到已到达的帧（验证"确实在流式推"） */
export class FrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private pending = ""
  private readonly queue: Frame[] = []
  private done = false
  readonly seen: Frame[] = []

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader()
  }

  async next(): Promise<Frame | undefined> {
    while (this.queue.length === 0 && !this.done) {
      const { done, value } = await this.reader.read()
      if (done) {
        this.done = true
        break
      }
      this.pending += this.decoder.decode(value, { stream: true })
      const blocks = this.pending.split("\n\n")
      this.pending = blocks.pop() ?? ""
      for (const b of blocks) {
        const f = parseBlock(b)
        if (f) this.queue.push(f)
      }
    }
    const f = this.queue.shift()
    if (f) this.seen.push(f)
    return f
  }

  /** 读到第一个满足条件的帧为止（含），返回途中读到的全部帧 */
  async until(pred: (f: Frame) => boolean): Promise<Frame[]> {
    const got: Frame[] = []
    while (true) {
      const f = await this.next()
      if (!f) throw new Error(`流已结束，仍未等到目标帧；已收到 ${JSON.stringify(got)}`)
      got.push(f)
      if (pred(f)) return got
    }
  }

  async rest(): Promise<Frame[]> {
    const got: Frame[] = []
    while (true) {
      const f = await this.next()
      if (!f) return got
      got.push(f)
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel()
  }
}

/** 一个可以从外面打开的闸门：工具 execute 里 await 它，测试就能把 run 卡在任意位置 */
export function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait: () => promise }
}

export const eventFrames = (frames: Frame[]) => frames.filter((f) => f.event === undefined)
export const eventsOf = (frames: Frame[]) => eventFrames(frames).map((f) => f.data as Event)
export const typesOf = (frames: Frame[]) => eventsOf(frames).map((e) => e.type.replace("core.", ""))

export function postRequest(body: unknown, url = "http://test/agent"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function getRequest(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL("http://test/agent")
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return new Request(url, { method: "GET", headers })
}

/** 拿到响应体的逐帧读取器；SSE 响应没有 body 就是 bug，直接抛 */
export async function openReader(response: Promise<Response> | Response): Promise<FrameReader> {
  const res = await response
  if (!res.body) throw new Error(`响应没有 body（status ${res.status}）`)
  return new FrameReader(res.body)
}
