/**
 * @reinsjs/tools-mcp 的公开类型。MCP SDK 的类型一律不出本包（同降级层对 pi-ai 的约束）：
 * 对外只有 reins 自己的 `Tool` / `Socket`，加上这里几个纯数据形状。
 */
import type { MaybePromise, Socket, Tool, ToolContext } from "@reinsjs/core"

/**
 * 每个请求的 bearer 凭证来源（HTTP 传输）。刻意只有两个方法、且不引用 MCP SDK 的类型：
 * 形状与 SDK 的 `AuthProvider` 结构兼容，宿主不必 import SDK。
 *
 * **不收 SDK 的 `OAuthClientProvider`**：那套的核心是"开浏览器让人点授权"，在服务端 agent 里跑不通——
 * 令牌该由宿主的 Web 应用先拿好、存起来，循环里只负责取用与刷新。完整 OAuth 流程仍不封装（0.1 立场不变），
 * 宿主要用可以在 `token` / `onUnauthorized` 里自己调 SDK 的 `refreshAuthorization` 等函数。
 */
export interface McpAuth {
  /** 每个请求发出前调用。返回 undefined 表示这次不带 Authorization 头 */
  token(): MaybePromise<string | undefined>
  /**
   * 服务器回 401 时调用，之后传输层**自动重试该请求一次**；重试再 401（或没给这个方法）就抛错。
   * 实现里该做的是刷新令牌——下一次 `token()` 要能返回可用的那个
   */
  onUnauthorized?(): MaybePromise<void>
}

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

/** 一次要路由的调用：MCP 原名（不是给模型看的改写名）与入参（原样交给 `tools/call` 的那份） */
export interface McpRoutedCall {
  name: string
  args: unknown
}

/**
 * 同一台服务器、多份凭据（AdRate 建议 14）：工具表仍由 `transport`（目录连接）在 run 起步取一次，
 * 每次 `tools/call` 由宿主选走哪份凭据。前提是各凭据看到的工具表相同（同一份服务端目录）——本包不校验；
 * 某个键的服务器上没有该工具时由服务器报错，按现有规则成 isError。
 *
 * 连接池挂在 Socket 上、只按键区分，Socket 被宿主缓存时就是跨会话、跨用户共享的：
 * `keyOf` 是唯一的授权点（用 `ctx.principal` 判这个人能不能用这个身份），`transportFor` 只能由键决定。
 */
export interface McpRoute {
  /**
   * 这次调用走哪份凭据。必须返回非空字符串；返回别的、或抛错 → 本次调用不发出，模型看到 isError
   * （抛错的 message 原样给模型），**绝不回退到目录连接**。每次 execute 调一次（审批续跑后在真正执行时才调）
   */
  keyOf(call: McpRoutedCall, ctx: ToolContext): MaybePromise<string>
  /**
   * 该键的传输配方。每个键在连接池里第一次被用到时调一次，之后连接懒建、跨 run 复用、断了按这份配方重建一次
   * （与 `transport` 同一套语义）；凭据换了配方要 `evict(key)` 才会重取。抛错或返回不合规 → 本次调用 isError、不入池
   */
  transportFor(key: string): McpTransport
}

export interface McpToolsOptions {
  /** 一台服务器的传输配方。配了 `route` 时它只用于 run 起步的 `tools/list`（目录连接），调用走路由 */
  transport: McpTransport
  /** 按调用选凭据；缺省所有调用走 `transport` */
  route?: McpRoute
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
  /**
   * 关掉底层连接（含 `route` 连接池里的全部连接，池清空）。进程退出、或宿主按请求重建配置时换掉旧的之前调；
   * 关掉后再跑 run 会按配方重建。收摊语义：不等在途调用
   */
  close(): Promise<void>
  /**
   * 移出 `route` 连接池里某个键的连接（凭据撤销、到期、换了配方）：立即移出（之后路由到该键的调用重新调 `transportFor`），
   * 等该连接上在途的调用全部结束再关——不掐断可能已到服务器的写请求；返回的 Promise 关完才 resolve（最长约一到两个 `callTimeoutMs`：在途调用可能还要握手、401 重试一次）。
   * 不存在的键、或没配 route → 无操作
   */
  evict(key: string): Promise<void>
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
