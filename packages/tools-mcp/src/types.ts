/**
 * @reinsjs/tools-mcp 的公开类型。MCP SDK 的类型一律不出本包（同降级层对 pi-ai 的约束）：
 * 对外只有 reins 自己的 `Tool` / `Socket`，加上这里几个纯数据形状。
 */
import type { Socket, Tool } from "@reinsjs/core"

/** MCP 工具注解（spec 里全部是"提示"，只用来给 risk / needsApproval 定缺省值，不当权限判定） */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** `tools/list` 返回的一个工具，原样搬过来的纯数据；`override` 钩子拿它做逐工具改写的依据 */
export interface McpToolInfo {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: McpToolAnnotations
}

/**
 * 一条 MCP 传输的"配方"：怎么建出底层连接。主入口只有 `httpTransport`（Streamable HTTP，纯 Web 标准），
 * `@reinsjs/tools-mcp/node` 才有 `stdioTransport`（起子进程）。连接本身由 `mcpTools()` 懒建、跨 run 复用，
 * 断了在下一次需要时按这个配方重建一次 —— 所以配方必须可重复调用。
 */
export interface McpTransport {
  readonly kind: "http" | "stdio" | "custom"
  /** 给 Socket.name、告警与报错用的可读标签（不含密钥） */
  readonly label: string
  /**
   * 建一条新的底层传输。返回值是 MCP SDK 的 Transport，对外按 unknown 处理（SDK 类型不出本包）；
   * 自定义传输（如测试用的内存传输）也从这里进
   */
  create(): unknown
}

export interface McpToolsOptions {
  transport: McpTransport
  /**
   * 给模型看的工具名前缀（如 `"gh_"`），多台服务器同名工具靠它区分；缺省无。
   * 调用时按原名发给服务器。宿主工具与 MCP 工具同名时以宿主为准（core 静态贡献的既有规则）
   */
  prefix?: string
  /** 单次 `tools/call` 超时毫秒，缺省 60_000；到点抛错 → 模型看到 isError 结果，循环不崩 */
  callTimeoutMs?: number
  /**
   * run 起步 `tools/list` 失败时怎么办。缺省 false：抛错，run 在写任何日志之前失败（fail-closed，宿主一定知道）。
   * true：本次 run 不贡献工具、告警一次，模型会从工具变化说明里看到这些工具被移除了
   */
  optional?: boolean
  /**
   * 逐工具改写：调整 needsApproval / risk / resultPolicy / description 等；返回 `false` 即不把这个工具给模型。
   * 入参 `tool` 是按缺省规则翻好的 reins Tool，`info` 是服务器原样的声明
   */
  override?(tool: Tool, info: McpToolInfo): Tool | false | undefined
  /** MCP 握手时的客户端自述，缺省 `{ name: "reins", version: <本包版本> }` */
  clientInfo?: { name: string; version: string }
  /** 告警出口（optional 降级、工具名被改写），缺省 console.warn */
  warn?: (message: string) => void
}

export interface McpToolsSocket extends Socket {
  readonly transport: McpTransport
  /** 关掉底层连接。进程退出、或宿主按请求重建配置时换掉旧的之前调；关掉后再跑 run 会按配方重建 */
  close(): Promise<void>
}

/** 本包抛出的错误：连接建不起来、`tools/list` 失败、服务器声明不合法 */
export class McpToolsError extends Error {
  constructor(
    message: string,
    readonly transport: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "McpToolsError"
  }
}
