/**
 * DeepSeek 的 Anthropic 兼容端口核实：作为"第二家 Anthropic 协议上游"，我们依赖的几件事它怎么反应。
 *   node spikes/deepseek-anthropic-check/probe.mjs
 * 密钥自动从仓库根《模型API测试信息.md》读取（该文件已 gitignore）。原始响应落 out/（已 gitignore）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
// 原始字段块放在文件末尾（前面还有一段说明文字会提到同样的字样），所以取最后一次出现
const block = info.slice(info.lastIndexOf("deepseek官方"))
const key = block.match(/key:\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
const model = block.match(/模型：\s*(\S+)/)?.[1] ?? "deepseek-v4-flash"
const base = block.match(/anthropic 协议 baseurl：\s*(\S+)/)?.[1]
if (!key || !base) throw new Error("没找到 DeepSeek 的 key / baseurl")
const outDir = new URL("./out/", import.meta.url)
await mkdir(outDir, { recursive: true })

async function call(name, body) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 200, ...body }),
  })
  const text = await res.text()
  await writeFile(new URL(`./${name}.json`, outDir), text)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  const brief =
    res.status === 200
      ? `usage=${JSON.stringify(json.usage)} text=${JSON.stringify(
          json.content
            ?.map((c) => c.text ?? c.type)
            .join(" | ")
            ?.slice(0, 80),
        )}`
      : `${JSON.stringify(json).slice(0, 300)}`
  console.log(`\n[${name}] HTTP ${res.status}\n  ${brief}`)
  return { status: res.status, json }
}

const SYSTEM = `You are a terse assistant. Answer in one short sentence. ${"Rule: be exact. ".repeat(120)}`

// 1. 基础往返 + pi-ai 风格的块级 cache_control（system 与最后一条 user）
await call("1-block-cache-control", {
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Say hi.", cache_control: { type: "ephemeral" } }] },
  ],
})
// 2. 同一前缀再发一次：看用量里有没有 cache_read_input_tokens 之类的字段
await call("2-repeat-same-prefix", {
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Say hi again.", cache_control: { type: "ephemeral" } }],
    },
  ],
})
// 3. 请求顶层 cache_control（我们 automatic 模式补的字段）
await call("3-top-level-cache-control", {
  cache_control: { type: "ephemeral" },
  system: SYSTEM,
  messages: [{ role: "user", content: "Say hi a third time." }],
})
// 4. 中途 role:system 消息（感知说明在支持的模型上的落点）
await call("4-mid-conversation-system", {
  system: SYSTEM,
  messages: [
    { role: "user", content: "Say hi." },
    { role: "assistant", content: [{ type: "text", text: "Hi." }] },
    { role: "user", content: "Now say bye." },
    { role: "system", content: [{ type: "text", text: "Runtime status: context window <50% used." }] },
  ],
})
// 5. 工具调用 + thinking 参数（pi-ai 在 thinkingEnabled 时会发）
await call("5-tools-and-thinking", {
  system: SYSTEM,
  thinking: { type: "enabled", budget_tokens: 1024 },
  max_tokens: 2000,
  tools: [
    {
      name: "get_weather",
      description: "Get weather by city",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  ],
  messages: [{ role: "user", content: "What's the weather in Shanghai? Use the tool." }],
})
