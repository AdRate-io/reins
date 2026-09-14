/**
 * @reinsjs/tools-mcp —— 把 MCP 服务器接成 reins 的一个 Socket（技术方案 §10，任务 P1）。
 *
 *   import { httpTransport, mcpTools } from "@reinsjs/tools-mcp"
 *   const github = mcpTools({ transport: httpTransport({ url, headers: { Authorization: `Bearer ${token}` } }) })
 *   createAgent({ model, store, tools: [...], sockets: [github, compact(), spill(), approval(...)] })
 *
 * - 主入口只有 Streamable HTTP，零 node:*，能跑在 Workers；stdio（子进程）在 `@reinsjs/tools-mcp/node`。
 * - 工具表按 run 绑定：起步 tools/list 一次，run 内不变；服务器的 listChanged 只影响下一次 run，
 *   循环会把增删写成 tools_bound 快照 + 给模型的说明。不做 MCP 动态注册（PRD）。
 * - 连接由 Socket 持有、跨 run 复用；宿主按请求重建 `mcpTools()` 也没有代价（懒连接）。用完 `close()`。
 * - 0.1 不做：sampling、elicitation、resources、prompts、MCP Apps。
 */
export * from "./http.js"
export { DEFAULT_CALL_TIMEOUT_MS, mcpTools, REINS_MCP_CLIENT_INFO } from "./mcp-tools.js"
export { MODEL_TOOL_NAME_RE, modelToolName, riskOf, toContentParts, toToolInfo } from "./translate.js"
export * from "./types.js"
