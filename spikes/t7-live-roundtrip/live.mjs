/**
 * T7 真实往返：带 API key 跑一次"用户提问 → 模型思考并调工具 → 回传结果 → 模型再思考并作答"，
 * 第二次请求回放第一次的 thinking（Anthropic signature / OpenAI encrypted reasoning）。
 *
 * 运行：先在仓库根 `pnpm build`，然后
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node spikes/t7-live-roundtrip/live.mjs
 * 只设一个 key 就只跑那一家。
 */
import { createCoreEvent, createCoreRegistry } from "../../packages/core/dist/index.js"
import { PiAiLowering } from "../../packages/lowering-pi/dist/index.js"

const registry = createCoreRegistry()
const keys = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY }
const lowering = new PiAiLowering({
  apiKey: (provider) => keys[provider],
  requestOptions: (ref) =>
    ref.provider === "openai" ? { reasoningEffort: "medium" } : { thinkingEnabled: true },
})
const tools = [
  {
    name: "get_weather",
    description: "查询城市当前天气",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
]

async function roundTrip(model) {
  const sessionId = `live-${model.provider}`
  let seq = 0
  const events = []
  const push = (draft) => {
    seq += 1
    const e = createCoreEvent(registry, { ...draft, sessionId, seq })
    events.push(e)
    return e
  }
  const run = async (label) => {
    const req = lowering.toRequest({
      events,
      tools,
      model,
      systemPrompt: "你是天气助手，必须先调用 get_weather 再回答。",
    })
    const lossy = req.landings.filter((l) => l.kind !== "exact")
    console.log(
      `\n[${label}] 发送 ${events.length} 条事件；非 exact 落点：${lossy.length ? JSON.stringify(lossy) : "无"}`,
    )
    const gen = lowering.stream(req, {})
    let r = await gen.next()
    while (!r.done) {
      push(r.value)
      const d = r.value
      console.log(
        `  ← ${d.type}`,
        d.type === "core.tool_call" ? JSON.stringify(d.payload) : JSON.stringify(d.payload).slice(0, 80),
        d.replay?.thinkingSignature ? `(签名 ${String(d.replay.thinkingSignature).length} 字符)` : "",
      )
      r = await gen.next()
    }
    console.log("  收尾：", JSON.stringify(r.value))
  }

  push({
    type: "core.user_message",
    actor: "user",
    payload: { content: [{ type: "text", text: "上海现在天气怎么样？" }] },
  })
  await run("第一轮")
  const call = events.find((e) => e.type === "core.tool_call")
  if (!call) {
    console.log("  模型没有调工具，往返到此为止")
    return
  }
  push({
    type: "core.tool_result",
    actor: "tool",
    parentId: call.id,
    payload: {
      toolCallId: call.payload.toolCallId,
      name: call.payload.name,
      content: [{ type: "text", text: "晴，28℃，东南风 2 级" }],
      isError: false,
    },
  })
  push({
    type: "core.system_note",
    actor: "system",
    payload: { kind: "perception", text: "Context usage: under 50%. No compaction needed." },
  })
  await run("第二轮（回放第一轮 thinking + 工具结果 + 中途 system_note）")
}

if (keys.anthropic) await roundTrip({ provider: "anthropic", id: "claude-opus-5" })
else console.log("未设 ANTHROPIC_API_KEY，跳过 Anthropic")
if (keys.openai) await roundTrip({ provider: "openai", id: "gpt-5.4" })
else console.log("未设 OPENAI_API_KEY，跳过 OpenAI")
