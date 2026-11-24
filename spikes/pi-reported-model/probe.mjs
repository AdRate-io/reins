/**
 * lowering-pi 的思考回放判据核实：pi-ai 0.85.1 的 anthropic-messages 线把记录里的型号换成厂商在
 * `message_start.message.model` 回报的值（api/anthropic-messages.js 402 行），回放时 transform-messages
 * 按 provider + api + model 三者一致判"同一模型"，不一致就把带签名的 thinking 降成纯文本。
 * 所以要知道：请求的型号 id 与厂商回报的是否逐字相同。不同则每一轮的思考回放都会被降级。
 *
 * 运行：`node spikes/pi-reported-model/probe.mjs`；密钥从 `.env.local` 读（DEEPSEEK_API_KEY；CF_AIG_TOKEN 等可缺，缺则跳过）。
 * 判据：逐格打印请求 id 与 message_start 回报 id，不看状态码。
 */
import { cfGatewayBase, maybe, need } from "../../scripts/local-env.mjs"

async function reportedModel(url, headers, model) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "Say hi." }],
    }),
  })
  if (!res.ok) return `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`
  const text = await res.text()
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = JSON.parse(line.slice(5))
    if (data.type === "message_start") return data.message.model
  }
  return "(no message_start)"
}

const cells = [
  [
    "DeepSeek Anthropic 端口",
    "https://api.deepseek.com/anthropic/v1/messages",
    () => ({ "x-api-key": need("DEEPSEEK_API_KEY") }),
    ["deepseek-v4-flash", "deepseek-flash"],
  ],
  [
    "CF 网关 → 官方 Anthropic",
    () => `${cfGatewayBase()}/anthropic/v1/messages`,
    () => ({ "cf-aig-authorization": `Bearer ${need("CF_AIG_TOKEN")}` }),
    ["claude-haiku-5-5"],
  ],
]
for (const [name, url, headers, models] of cells) {
  if (name.startsWith("CF") && !maybe("CF_AIG_TOKEN")) {
    console.log(`${name}：缺 CF_AIG_TOKEN，跳过`)
    continue
  }
  for (const m of models) {
    const got = await reportedModel(typeof url === "function" ? url() : url, headers(), m)
    console.log(`${name}  请求 ${m}  回报 ${got}  ${got === m ? "一致" : "不一致"}`)
  }
}
