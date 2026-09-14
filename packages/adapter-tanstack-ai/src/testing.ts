/**
 * 测试用的脚本化 TanStack 文本适配器：按剧本逐次吐 AG-UI chunk，并记录每次 chatStream 收到的选项
 * （providerMessages / systemPrompts / tools），断言"模型看到了什么"就看它。与 @reinsjs/core/testing 的
 * ScriptedLowering 同一思路，只是产出的是 TanStack 流而不是 reins 草稿。
 */
import type { AnyTextAdapter, StreamChunk, TextOptions, TokenUsage } from "@tanstack/ai"

export interface ScriptedBlockText {
  kind: "text"
  text: string
}
export interface ScriptedBlockThinking {
  kind: "thinking"
  text: string
  signature?: string
}
export interface ScriptedBlockToolCall {
  kind: "tool"
  id: string
  name: string
  args: unknown
}
export type ScriptedBlock = ScriptedBlockText | ScriptedBlockThinking | ScriptedBlockToolCall

export interface ScriptedResponse {
  blocks: ScriptedBlock[]
  usage?: Partial<TokenUsage>
}

export type AdapterScript =
  | readonly ScriptedResponse[]
  | ((options: TextOptions, call: number) => ScriptedResponse)

export const say = (text: string): ScriptedBlock => ({ kind: "text", text })
export const think = (text: string, signature?: string): ScriptedBlock =>
  signature === undefined ? { kind: "thinking", text } : { kind: "thinking", text, signature }
export const callTool = (id: string, name: string, args: unknown): ScriptedBlock => ({
  kind: "tool",
  id,
  name,
  args,
})

export interface ScriptedAdapter extends AnyTextAdapter {
  /** 每次 chatStream 收到的选项，按调用顺序 */
  calls: TextOptions[]
}

export const SCRIPTED_MODEL = "scripted-1"
export const SCRIPTED_PROVIDER = "scripted"

export function scriptedAdapter(script: AdapterScript): ScriptedAdapter {
  const calls: TextOptions[] = []
  let n = 0
  const adapter = {
    kind: "text" as const,
    name: SCRIPTED_PROVIDER,
    model: SCRIPTED_MODEL,
    "~types": {} as AnyTextAdapter["~types"],
    calls,
    async *chatStream(options: TextOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const call = n++
      const response = typeof script === "function" ? script(options, call) : script[call]
      if (!response) throw new Error(`剧本没有第 ${call + 1} 次响应`)
      const runId = options.runId ?? `run_${call}`
      const threadId = options.threadId ?? "thread"
      const ts = () => Date.now()
      yield { type: "RUN_STARTED", threadId, runId, timestamp: ts() } as StreamChunk
      const messageId = `msg_${call}`
      let hasTool = false
      let i = 0
      for (const b of response.blocks) {
        i++
        if (b.kind === "text") {
          yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant", timestamp: ts() } as StreamChunk
          // 拆成两段 delta，检验拼块
          const mid = Math.ceil(b.text.length / 2)
          yield {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: b.text.slice(0, mid),
            timestamp: ts(),
          } as StreamChunk
          if (mid < b.text.length)
            yield {
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta: b.text.slice(mid),
              timestamp: ts(),
            } as StreamChunk
          yield { type: "TEXT_MESSAGE_END", messageId, timestamp: ts() } as StreamChunk
        } else if (b.kind === "thinking") {
          const rid = `${messageId}_r${i}`
          yield { type: "REASONING_START", messageId: rid, timestamp: ts() } as StreamChunk
          yield {
            type: "REASONING_MESSAGE_START",
            messageId: rid,
            role: "reasoning",
            timestamp: ts(),
          } as StreamChunk
          yield {
            type: "REASONING_MESSAGE_CONTENT",
            messageId: rid,
            delta: b.text,
            timestamp: ts(),
          } as StreamChunk
          yield { type: "REASONING_MESSAGE_END", messageId: rid, timestamp: ts() } as StreamChunk
          // 签名故意排在 END 之后（Anthropic 适配器的真实顺序）
          if (b.signature !== undefined)
            yield {
              type: "REASONING_ENCRYPTED_VALUE",
              subtype: "message",
              entityId: rid,
              encryptedValue: b.signature,
              timestamp: ts(),
            } as StreamChunk
          yield { type: "REASONING_END", messageId: rid, timestamp: ts() } as StreamChunk
        } else {
          hasTool = true
          yield {
            type: "TOOL_CALL_START",
            toolCallId: b.id,
            toolCallName: b.name,
            parentMessageId: messageId,
            timestamp: ts(),
          } as StreamChunk
          yield {
            type: "TOOL_CALL_ARGS",
            toolCallId: b.id,
            delta: JSON.stringify(b.args),
            timestamp: ts(),
          } as StreamChunk
          yield { type: "TOOL_CALL_END", toolCallId: b.id, timestamp: ts() } as StreamChunk
        }
      }
      const usage: TokenUsage = {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        ...response.usage,
      }
      yield {
        type: "RUN_FINISHED",
        threadId,
        runId,
        finishReason: hasTool ? "tool_calls" : "stop",
        usage,
        timestamp: ts(),
      } as unknown as StreamChunk
    },
    structuredOutput() {
      return Promise.reject(new Error("scripted adapter 不支持结构化输出"))
    },
  }
  return adapter as unknown as ScriptedAdapter
}
