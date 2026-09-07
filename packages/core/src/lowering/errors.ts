export type LoweringErrorCode =
  | "unsupported_model" // 解析不到这个 provider/id
  | "unsupported_api" // 模型用的线协议本实现不支持
  | "missing_api_key" // 没配这家的 key
  | "invalid_request" // 事件序列翻译不出合法请求（如孤儿 tool_result）

export class LoweringError extends Error {
  constructor(
    readonly code: LoweringErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`)
    this.name = "LoweringError"
  }
}
