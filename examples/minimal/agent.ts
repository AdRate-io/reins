/**
 * 五分钟体验（PRD §5.1）。装上、配自己的模型，就得到一辆有驾驭经验的车。
 * 这个文件就是你项目里的 agent 定义；`POST` 是 Web 标准 handler，形状上能直接挂到 Next / TanStack Start / Hono 的路由。
 *
 * 它会被照抄成宿主骨架，所以安全上按生产形态写，只把"你是谁"留给你换：
 * - **会话归属**：谁开的会话只有谁能读、续、批（`authorizeSession`）。身份取自 `server.ts` 发的 HttpOnly 访客 cookie，
 *   这只是"同一个浏览器"，不是登录——接进你的项目时把 `visitorOf` 换成你的登录态，归属表换成库里的一列。
 * - **签名密钥**：`REINS_SECRET` 没设就每个进程随机生成一把并告警一次，不用写死的开发值。
 *   随机密钥下暂停状态只在本进程有效（重启、多实例就续不上），与 memoryStore 的寿命一致；上持久存储或多实例必须注入同一把真密钥。
 * 其余见根 README「Security notes」。
 */
import { anthropic } from "@reinsjs/lowering-fetch"
import { createAgent, defineTool, memoryStore, type Principal } from "@reinsjs/agent"

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

/** server.ts 发的访客 cookie 名；值是 32 位十六进制随机串 */
export const VISITOR_COOKIE = "reins_visitor"
const VISITOR_RE = /^[0-9a-f]{32}$/

/** 从 Cookie 头里取合规的访客 id；server.ts 也用它判要不要发新 cookie */
export function visitorIdOf(cookieHeader: string | null | undefined): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, value] = part.trim().split("=")
    if (name === VISITOR_COOKIE && value !== undefined && VISITOR_RE.test(value)) return value
  }
  return undefined
}

/** 从请求里认出"谁在问"；认不出就是 undefined（handler 回 401）。接进你的项目时换成你的登录态 */
function visitorOf(request: Request): Principal | undefined {
  const id = visitorIdOf(request.headers.get("cookie"))
  return id === undefined ? undefined : { id }
}

/** 会话 → 开它的人。内存表与 memoryStore 同寿命；换持久存储时这张表也要进库 */
const owners = new Map<string, string>()

function randomSecret(): string {
  console.warn(
    "REINS_SECRET is not set: using a random per-process secret. Paused runs cannot be resumed after a restart or on another instance; set REINS_SECRET before using a persistent store or more than one instance.",
  )
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")
}

export const agent = createAgent({
  // thinking 不在这里设：Opus 5 起厂商缺省 adaptive；要手调就在 requestOptions 里按型号给 `thinking`
  model: anthropic(process.env.REINS_MODEL ?? "claude-opus-5", {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    // 走网关或代理时才需要：给到协议根（其后接 /messages），如 https://host/api/v1；网关若丢中途 system，再加 midConversationSystem: false
    ...(process.env.REINS_GATEWAY_BASE ? { baseUrl: process.env.REINS_GATEWAY_BASE } : {}),
  }),
  tools: [getWeather, deploy],
  store: memoryStore(), // 或 sqliteStores(openSqlite("./agent.db"))（@reinsjs/store-sqlite 及其 /node 入口），或自己实现 EventLog 接口
  systemPrompt: "你是一个简短直接的助手。",
  secret: process.env.REINS_SECRET || randomSecret(), // 签名暂停状态（续跑凭据）
  handler: {
    principal: (request) => {
      const who = visitorOf(request)
      if (!who) throw new Response("unauthorized", { status: 401 })
      return who
    },
    // 只有字面 true 放行，其余一律 404（不承认会话存在）
    authorizeSession: ({ sessionId, principal, isNew }) => {
      if (!principal) return false
      if (isNew) {
        owners.set(sessionId, principal.id)
        return true
      }
      return owners.get(sessionId) === principal.id
    },
  },
})

export const POST = agent.handler // Web 标准 (Request) => Response
