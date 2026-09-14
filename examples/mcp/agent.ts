/**
 * 一个 agent 同时挂进程内工具与 MCP 工具。重点是 `buildAgent()`：**每次请求调一次**，
 * MCP 配置从 mcp.config.json 现读 —— 改了配置，下一次请求就用新的工具表，进程不重启，也不需要库提供"热加载"接口：
 * createAgent 只是拼对象，mcpTools 懒连接，按请求重建没有代价。工具表变了循环会记 tools_bound 并告诉模型增删了什么。
 *
 * 模型来源与 examples/adrate 相同：REINS_PROVIDER=aireiter（缺省，claude-opus-5）或 deepseek；密钥从仓库根
 * 《模型API测试信息.md》读，也可用 ANTHROPIC_API_KEY 覆盖；REINS_MODEL 覆盖模型 id。
 */
import { mkdirSync, readFileSync } from "node:fs"
import { approval, budget, compact, perception, pins, spill } from "@reinsjs/brain"
import { anthropic } from "@reinsjs/lowering-pi"
import { sqliteStores } from "@reinsjs/store-sqlite"
import { openSqlite } from "@reinsjs/store-sqlite/node"
import { httpTransport, type McpToolsSocket, mcpTools } from "@reinsjs/tools-mcp"
import { type Agent, createAgent, defineTool } from "reins"

const here = (p: string) => new URL(p, import.meta.url)

function readKey(section: "aireiter" | "deepseek"): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const info = readFileSync(here("../../模型API测试信息.md"), "utf8")
  const keys = [...info.matchAll(/密钥[^`]*`(sk-[^`]+)`/g)].map((m) => m[1] as string)
  const key = section === "aireiter" ? keys[0] : keys[1]
  if (!key) throw new Error(`没在 模型API测试信息.md 里找到 ${section} 的密钥；或设 ANTHROPIC_API_KEY`)
  return key
}

const provider = (process.env.REINS_PROVIDER ?? "aireiter") as "aireiter" | "deepseek"
const modelId = process.env.REINS_MODEL ?? (provider === "deepseek" ? "deepseek-v4-flash" : "claude-opus-5")
const baseUrl = provider === "deepseek" ? "https://api.deepseek.com/anthropic" : "https://aireiter.com/api"

/** mcp.config.json 的形状 */
export interface McpConfig {
  servers: { name: string; url: string; prefix?: string; headers?: Record<string, string> }[]
}

export function readMcpConfig(): McpConfig {
  return JSON.parse(readFileSync(here("./mcp.config.json"), "utf8")) as McpConfig
}

/** 进程内工具：报表要用的日期。与 MCP 工具并列在同一张工具表上，模型分不出也不需要分出谁是谁 */
const today = defineTool<Record<string, never>>({
  name: "today",
  description: "Return today's date (ISO 8601) for use in reports.",
  inputSchema: { type: "object", properties: {} },
  // approval 缺省 byRisk：未声明 risk 也按"先问人"处理（第一次真跑时 today 就被拦下等审批了）。只读工具要明说
  risk: "low",
  execute: () => ({ date: new Date().toISOString().slice(0, 10) }),
})

const SYSTEM = `You are an inventory operations assistant.
- Work only through the tools you are given. Read before you write; verify a write by reading the item back.
- Some writes require human approval; when a call is waiting for approval, do not repeat it.
- Pin important intermediate conclusions (the list of items to act on, the results of each write).
- Finish with a short markdown table of what changed (sku, name, before, after) and today's date.
- Answer in Chinese, briefly.`

/** 跨请求不变的部分：模型、存储。MCP 部分每次 buildAgent 重建 */
const model = anthropic(modelId, {
  apiKey: readKey(provider),
  baseUrl,
  requestOptions: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
  ...(provider === "deepseek" ? { midConversationSystem: true } : {}),
})
mkdirSync(here("./data/").pathname, { recursive: true })
const store = sqliteStores(openSqlite(here("./data/mcp-demo.db").pathname))

/**
 * MCP Socket 按"服务器配置的 JSON"缓存：配置没变就复用同一条连接（省掉每次请求的 MCP 握手），
 * 配置变了（改了 url / prefix / headers）才换新的并把旧的关掉。配置里删掉的服务器也在这里被关掉。
 */
const mcpCache = new Map<string, McpToolsSocket>()

function mcpSockets(config: McpConfig): McpToolsSocket[] {
  const wanted = new Map(config.servers.map((s) => [JSON.stringify(s), s]))
  for (const [key, socket] of mcpCache) {
    if (!wanted.has(key)) {
      mcpCache.delete(key)
      void socket.close()
    }
  }
  return [...wanted].map(([key, s]) => {
    let socket = mcpCache.get(key)
    if (!socket) {
      socket = mcpTools({
        transport: httpTransport({ url: s.url, ...(s.headers ? { headers: s.headers } : {}) }),
        ...(s.prefix ? { prefix: s.prefix } : {}),
      })
      mcpCache.set(key, socket)
    }
    return socket
  })
}

/** 进程退出前关掉全部 MCP 连接 */
export async function closeMcp(): Promise<void> {
  await Promise.all([...mcpCache.values()].map((s) => s.close()))
  mcpCache.clear()
}

/** 每次请求调一次：现读配置 → 取 / 建 MCP Socket → 拼 agent。createAgent 只是拼对象，按请求重建没有代价 */
export function buildAgent(): Agent {
  const config = readMcpConfig()
  const mcp = mcpSockets(config)
  return createAgent({
    model,
    store,
    tools: [today],
    systemPrompt: SYSTEM,
    sockets: [
      ...mcp,
      perception(),
      compact(),
      pins(),
      spill({ maxResultTokens: 4000 }),
      budget({ limits: { turns: 30, toolCalls: 60 } }),
      // approval 放末尾：判定的是 rewrite 之后真正要执行的入参。缺省 byRisk：readOnly 放行、其余先问人
      approval(),
    ],
    secret: process.env.REINS_SECRET ?? "dev-only-secret",
  })
}
