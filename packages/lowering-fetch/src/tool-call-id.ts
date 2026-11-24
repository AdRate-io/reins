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
