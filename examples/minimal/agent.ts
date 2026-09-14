/**
 * 五分钟体验（PRD §5.1）。装上、配自己的模型，就得到一辆有驾驭经验的车。
 * 这个文件就是你项目里的 agent 定义；`POST` 是 Web 标准 handler，形状上能直接挂到 Next / TanStack Start / Hono 的路由。
 * 但这份配置只够本地体验：没有 `authorizeSession`（知道 sessionId 就能读走整条时间线、续别人的 run）、`secret` 有开发缺省值。
 * 上多用户的生产路由前，按根 README「Security notes」补 `handler: { principal, authorizeSession }` 并换真密钥。
 */
import { anthropic } from "@reinsjs/lowering-pi"
import { createAgent, defineTool, memoryStore } from "reins"

const getWeather = defineTool<{ city: string }>({
  name: "get_weather",
  description: "查询城市当前天气",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  execute: ({ city }) => ({ city, temp: 26, condition: "多云" }), // 换成真接口
})

const deploy = defineTool<{ env: "staging" | "prod" }>({
  name: "deploy",
  description: "把当前版本上线到指定环境",
  inputSchema: { type: "object", properties: { env: { type: "string", enum: ["staging", "prod"] } }, required: ["env"] },
  needsApproval: true, // 模型可以决定调用，但执行前必须有人点头
  execute: ({ env }) => `已上线到 ${env}`,
})

export const agent = createAgent({
  model: anthropic(process.env.REINS_MODEL ?? "claude-opus-5", {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    ...(process.env.REINS_GATEWAY_BASE ? { baseUrl: process.env.REINS_GATEWAY_BASE } : {}), // 走网关或代理时才需要
  }),
  tools: [getWeather, deploy],
  store: memoryStore(), // 或 sqliteStores(openSqlite("./agent.db"))（@reinsjs/store-sqlite 及其 /node 入口），或自己实现 EventLog 接口
  systemPrompt: "你是一个简短直接的助手。",
  secret: process.env.REINS_SECRET ?? "dev-only-secret", // 签名暂停状态；这个缺省值只给本地用，生产必须从环境变量注入
})

export const POST = agent.handler // Web 标准 (Request) => Response
