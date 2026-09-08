/**
 * 五分钟体验（PRD §5.1）。装上、配自己的模型，就得到一辆有驾驭经验的车。
 * 这个文件就是你项目里的 agent 定义；`POST` 是 Web 标准 handler，直接给 Next / TanStack Start / Hono 的路由用。
 */
import { anthropic } from "@reins/lowering-pi"
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
  store: memoryStore(), // 或 sqliteStore("./agent.db")（M1），或自己实现 EventLog 接口
  systemPrompt: "你是一个简短直接的助手。",
  secret: process.env.REINS_SECRET ?? "dev-only-secret", // 签名暂停状态，生产环境请换
})

export const POST = agent.handler // Web 标准 (Request) => Response
