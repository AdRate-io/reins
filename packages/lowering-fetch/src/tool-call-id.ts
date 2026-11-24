/**
 * 工具调用 id 的跨层 / 跨厂商规整（全库审查 #29）。
 *
 * 时间线里的 toolCallId 是写入它的降级层按当时的厂商原样存的：本包存厂商原文，lowering-pi 经 OpenAI Responses 存的是
 * pi-ai 拼出的复合 id `${call_id}|${fc_ 项 id}`。README 承诺两条降级层写下的事件可互相回放，所以发往各线之前要把
 * 别处写下的 id 翻成该线认得的形状。事件本身不动（只 append），规整只发生在写侧、是纯函数：同一个 id 在 tool_use 与
 * tool_result（call 与 output）两处各调一次，配对自然一致。
 */

/**
 * Anthropic `tool_use.id` / `tool_result.tool_use_id` 的厂商字符集是 `^[a-zA-Z0-9_-]+$`。与 pi-ai
 * （anthropic-messages normalizeToolCallId）同一规则：非法字符换成 `_`、截到 64 位——同一段时间线经两条降级层发往
 * Anthropic 得到同一个 id。厂商自己产出的 id（`toolu_…`）原样不变。
 */
export function anthropicToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

/**
 * pi-ai 的 Responses 复合 id `call_x|fc_y` 拆成 `call_id` 与 `fc_` 项 id；不是这种形状的原样作 call_id。
 * 只认 `|fc_` 这一种已知形状（lowering-pi to-request 同一判据），不猜别的分隔。
 */
export function splitResponsesToolCallId(id: string): { callId: string; itemId?: string } {
  const at = id.indexOf("|fc_")
  if (at <= 0) return { callId: id }
  return { callId: id.slice(0, at), itemId: id.slice(at + 1) }
}

/** OpenAI Chat Completions 对 `tool_calls[].id` / `tool_call_id` 的长度上限（超出 400，pi-ai 同一常量） */
const CHAT_TOOL_CALL_ID_MAX = 40

/**
 * Chat 线的 `tool_calls[].id` / tool 消息的 `tool_call_id`：OpenAI 限 40 字符，pi-ai 经 Responses 写下的复合 id
 * `call_x|fc_y` 几乎都超（`fc_` 项 id 常上百字符），原样发出即 400，时间线整段回放、会话就此卡死。
 *
 * - 不含 `|` 且不超 40 位的原样（Chat 厂商自己产出的 id、本包别的线写下的常见 id 都在此列，回放逐字不变）；
 * - 其余与 pi-ai（openai-completions normalizeToolCallId）同一规则：非法字符换 `_`，复合 id 拼成 `${call}_${item}`，
 *   仍超 40 位就取 call 段前缀 + `_` + 原 id 的 8 位哈希——哈希按整个原 id 算，同轮多个调用共用 call_id、只靠
 *   `fc_` 项 id 区分时也互不相同（Chat 要求同一条 assistant 里 id 互异）。哈希函数逐字照 pi-ai `shortHash`，
 *   同一段时间线经两条降级层发往 Chat 得到同一个 id。
 *
 * 映射有损：非法字符换 `_` 后 `a|b` 与 `a_b`、哈希截 8 位理论上都可能撞号，与 pi-ai 同等；只在不同厂商 / 降级层
 * 写下的 id 混在一段时间线里时才可能出现。落点仍记 exact（id 不是模型可见内容，配对关系不变）。
 */
export function chatToolCallId(id: string): string {
  if (!id.includes("|") && id.length <= CHAT_TOOL_CALL_ID_MAX) return id
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")
  const at = id.indexOf("|")
  const callId = sanitize(at >= 0 ? id.slice(0, at) : id)
  const itemId = at >= 0 ? sanitize(id.slice(at + 1)) : ""
  const combined = itemId.length > 0 ? `${callId}_${itemId}` : callId
  if (combined.length <= CHAT_TOOL_CALL_ID_MAX) return combined
  const hash = shortHash(id).slice(0, 8)
  return `${callId.slice(0, Math.max(1, CHAT_TOOL_CALL_ID_MAX - hash.length - 1))}_${hash}`
}

/** 逐字照 pi-ai `utils/hash.js` 的 shortHash（确定性、非加密），只用来缩短长 id */
function shortHash(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}
