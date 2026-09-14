/**
 * 最小演示服务：一个 node:http 进程，`/` 送出 index.html，`/agent` 是 createAgentHandler + AG-UI 编码。
 *
 * 运行（先在仓库根 `pnpm build`）：
 *   node packages/ui-agui/demo/serve.mjs                       # 无密钥：剧本假模型，离线可跑
 *   ANTHROPIC_API_KEY=… REINS_GATEWAY_BASE=https://host/api node packages/ui-agui/demo/serve.mjs   # 真模型
 * 可选：REINS_ANTHROPIC_MODEL（缺省 claude-opus-5）、PORT（缺省 8787）。
 *
 * node:http 适配用 @reinsjs/server/node 的 nodeListener；用框架的话用框架自带的即可。
 * 存储用内存实现：重启即清空，演示"重连补发"要在同一进程内做。
 */
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { defineTool, InMemoryEventLog } from "../../core/dist/index.js"
import { callTool, ScriptedLowering, say, think } from "../../core/dist/testing/index.js"
import { PiAiLowering } from "../../lowering-pi/dist/index.js"
import { createAgentHandler } from "../../server/dist/index.js"
import { nodeListener } from "../../server/dist/node.js"
import { aguiEncoding } from "../dist/index.js"

// ---- 工具：一个普通的、一个要审批的 ----
const weather = defineTool({
  name: "get_weather",
  description: "查询城市当前天气（演示用假数据）",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  execute: ({ city }) => ({ city, temp: 26, condition: "多云", humidity: "61%" }),
})
const deploy = defineTool({
  name: "deploy",
  description: "把当前版本上线到指定环境。高风险操作，需要人审批。",
  inputSchema: {
    type: "object",
    properties: { env: { type: "string", enum: ["staging", "prod"] } },
    required: ["env"],
  },
  needsApproval: true,
  execute: ({ env }) => `已上线到 ${env}`,
})

// ---- 模型：有密钥走真模型（经网关或官方），没有就用剧本 ----
const key = process.env.ANTHROPIC_API_KEY
const gateway = process.env.REINS_GATEWAY_BASE
const modelId = process.env.REINS_ANTHROPIC_MODEL ?? "claude-opus-5"
let lowering
let model
if (key) {
  lowering = new PiAiLowering({
    apiKey: () => key,
    models: gateway
      ? [
          {
            provider: "anthropic",
            id: modelId,
            api: "anthropic-messages",
            baseUrl: gateway,
            reasoning: true,
            contextWindow: 200_000,
            maxOutputTokens: 16_000,
            images: true,
          },
        ]
      : [],
    requestOptions: () => ({ thinkingEnabled: true }),
  })
  model = { provider: "anthropic", id: modelId }
} else {
  // 剧本按轮循环：想一想 → 查天气 → 回答；第二次提问时同样再来一遍
  lowering = new ScriptedLowering((_input, turn) =>
    turn % 2 === 0
      ? { drafts: [think("用户想知道天气，先查一下"), callTool(`c${turn}`, "get_weather", { city: "上海" })] }
      : {
          drafts: [say("上海现在 26℃，多云，湿度 61%。要不要我顺手把版本上线？（试试让我 deploy 到 prod）")],
        },
  )
  model = { provider: "scripted", id: "scripted" }
}

const handler = createAgentHandler(
  {
    log: new InMemoryEventLog(),
    lowering,
    model,
    tools: [weather, deploy],
    systemPrompt: "你是 reins 的演示助手。回答简短。查天气用 get_weather；用户要求上线时调用 deploy。",
    secret: "demo-secret",
  },
  { encode: aguiEncoding() },
)

const handleAgent = nodeListener(handler)
const html = await readFile(fileURLToPath(new URL("./index.html", import.meta.url)))

const server = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    return res.end(html)
  }
  if (!req.url?.startsWith("/agent")) {
    res.writeHead(404)
    return res.end()
  }
  await handleAgent(req, res)
})

const port = Number(process.env.PORT ?? 8787)
server.listen(port, () => {
  console.log(
    `reins demo → http://localhost:${port}   模型：${model.provider}/${model.id}${gateway ? `（经 ${gateway}）` : ""}`,
  )
})
