/**
 * 工具入参解码（OnSet 建议 8，2026-11-02）：模型偶尔把整个入参再编码一层，写成 JSON 文本 —— 线协议上的
 * `arguments` 解析一次得到的不是对象，而是字符串 `'{"a":1}'`。工具入参顶层按约定必须是对象，字符串顶层本来就不合法，
 * 所以"解一次得字符串、再解一次恰好得对象"只有二次编码这一种解释，多解这一层不会误伤。
 *
 * 为什么必须在库里做：fetch 版写侧把字符串入参当原始 JSON 文本原样送回（Chat / Responses 的 argumentsOf），
 * 历史里模型看到的是自己写对了的对象，工具却报"要对象收到字符串"—— 记录与执行说法不一，模型会以为工具坏了。
 *
 * 各降级层（fetch 三条线、pi 版）在读侧解析一次之后都调这一个函数，规则不分叉；解过就在 payload.meta 上记
 * `argumentsUnwrapped: true`，库替模型多解了一层要留在时间线上（宿主也可据此按模型统计）。
 */

export interface DecodedToolArguments {
  args: unknown
  /** 为真表示入参被二次编码、已多解一层 */
  unwrapped: boolean
}

/**
 * 输入是读侧已解析一次的值。只在它是字符串、且该字符串能解析成普通对象（非数组、非 null）时换成对象；
 * 其余（解析不了的原始文本、数字、数组……）原样返回，保持"解析不了就原样存字符串"的既有约定。
 */
export function unwrapToolArguments(parsed: unknown): DecodedToolArguments {
  if (typeof parsed !== "string") return { args: parsed, unwrapped: false }
  let inner: unknown
  try {
    inner = JSON.parse(parsed)
  } catch {
    return { args: parsed, unwrapped: false }
  }
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner))
    return { args: inner, unwrapped: true }
  return { args: parsed, unwrapped: false }
}

/** 拼 tool_call payload 的 meta：只有多解过一层才带，正常调用的事件形状不变 */
export function toolCallArgumentsMeta(decoded: DecodedToolArguments): {
  meta?: { argumentsUnwrapped: true }
} {
  return decoded.unwrapped ? { meta: { argumentsUnwrapped: true } } : {}
}
