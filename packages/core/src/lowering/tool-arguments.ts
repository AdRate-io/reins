/**
 * 工具入参解码（OnSet 建议 8，2026-11-02）：模型偶尔把整个入参再编码一层，写成 JSON 文本 —— 线协议上的
 * `arguments` 解析一次得到的不是对象，而是字符串 `'{"a":1}'`。工具入参顶层按约定必须是对象，字符串顶层本来就不合法，
 * 所以"解一次得字符串、再解一次恰好得对象"只有二次编码这一种解释，多解这一层不会误伤。
 *
 * 不变式（fetch 版写侧依赖它）：**时间线里 `tool_call.args` 是字符串 ⟺ 它就是线上原文**。Chat / Responses 写侧
 * 把字符串入参原样当 JSON 文本送回（argumentsOf），所以凡是没解成对象的，读侧一律存原文，不存"解过一层的字符串"——
 * 否则历史里模型看到的（被替它解过一层的文本）与工具拿到的（字符串）说法不一，模型会以为工具坏了。
 *
 * 各降级层读侧都调这里，规则不分叉；解过就在 payload.meta 上记 `argumentsUnwrapped: true`，库替模型多解了一层
 * 要留在时间线上（宿主也可据此按模型统计）。
 */

export interface DecodedToolArguments {
  args: unknown
  /** 为真表示入参被二次编码、已多解一层 */
  unwrapped: boolean
}

/**
 * 输入是已解析一次的值（pi-ai 的 `toolCall.arguments`、Anthropic `content_block_start.input`）。
 * 只在它是字符串、且该字符串能解析成普通对象（非数组、非 null）时换成对象；其余原样返回。
 * 多解的这一层容忍字符串字面量里的裸控制字符（模型二次编码时常把换行写成真换行，内层解析因此失败）。
 */
export function unwrapToolArguments(parsed: unknown): DecodedToolArguments {
  if (typeof parsed !== "string") return { args: parsed, unwrapped: false }
  const inner = parseLenient(parsed)
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner))
    return { args: inner, unwrapped: true }
  return { args: parsed, unwrapped: false }
}

/**
 * 输入是线上原文（Chat / Responses 的 `arguments`、Anthropic `input_json_delta` 拼出的文本）。
 * 空白 → `{}`；解析一次得非字符串 → 用它；得字符串 → 交 unwrapToolArguments，解不成对象就存**原文**（见文件头不变式）；
 * 解析失败 → 存原文。
 */
export function decodeToolArgumentsText(raw: string): DecodedToolArguments {
  if (raw.trim() === "") return { args: {}, unwrapped: false }
  let once: unknown
  try {
    once = JSON.parse(raw)
  } catch {
    return { args: raw, unwrapped: false }
  }
  if (typeof once !== "string") return { args: once, unwrapped: false }
  const decoded = unwrapToolArguments(once)
  return decoded.unwrapped ? decoded : { args: raw, unwrapped: false }
}

/** 拼 tool_call payload 的 meta：只有多解过一层才带，正常调用的事件形状不变 */
export function toolCallArgumentsMeta(decoded: DecodedToolArguments): {
  meta?: { argumentsUnwrapped: true }
} {
  return decoded.unwrapped ? { meta: { argumentsUnwrapped: true } } : {}
}

/** 先严格解析；失败再把字符串字面量里的裸控制字符转义后重试一次；仍失败返回 undefined */
function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const repaired = escapeControlCharsInStrings(text)
    if (repaired === text) return undefined
    try {
      return JSON.parse(repaired)
    } catch {
      return undefined
    }
  }
}

/** 只改字符串字面量内部的 U+0000–U+001F（JSON 不许裸出现），字面量外的空白换行原样保留 */
function escapeControlCharsInStrings(text: string): string {
  let out = ""
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      escaped = false
      out += ch
      continue
    }
    if (ch === "\\") escaped = true
    else if (ch === '"') inString = false
    else {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20) {
        out += CONTROL_ESCAPES[ch] ?? `\\u${code.toString(16).padStart(4, "0")}`
        continue
      }
    }
    out += ch
  }
  return out
}

const CONTROL_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
}
