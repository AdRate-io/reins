/**
 * 排障：单独打一次模型请求，按开关带 / 不带工具表与 Skill 长提示。node examples/adrate/probe.ts [tools] [skills]
 * 密钥从仓库根 `.env.local` 读（经 scripts/local-env.mjs：AIREITER_API_KEY，REINS_PROVIDER=deepseek 时 DEEPSEEK_API_KEY）。
 */
import { execFileSync } from "node:child_process"
import { anthropicMessages, deepseek } from "@reinsjs/lowering-fetch"
import { toolSpecOf } from "@reinsjs/agent"
import { need } from "../../scripts/local-env.mjs"
import { adrateTools } from "./tools.ts"

const withTools = process.argv.includes("tools")
const withSkills = process.argv.includes("skills")
const useDeepseek = process.env.REINS_PROVIDER === "deepseek"
const modelId = process.env.REINS_MODEL ?? (useDeepseek ? "deepseek-v4-flash" : "claude-opus-5")
// PROBE_THINKING=0 关 thinking（两家 Chat / Messages 都认 thinking.type = "disabled"；Fable 5.1 对 disabled 会 400，那就别关）；不设则用厂商缺省
const requestOptions = process.env.PROBE_THINKING === "0" ? { thinking: { type: "disabled" } } : undefined
const { model, lowering } = useDeepseek
  ? deepseek(modelId, { apiKey: need("DEEPSEEK_API_KEY"), ...(requestOptions ? { requestOptions } : {}) })
  : anthropicMessages(modelId, {
      provider: "aireiter",
      baseUrl: "https://aireiter.com/api/v1",
      apiKey: need("AIREITER_API_KEY"),
      reasoning: true,
      images: true,
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      midConversationSystem: false,
      ...(requestOptions ? { requestOptions } : {}),
    })
const skill = (n: string) => execFileSync("adrate", ["skills", "read", n], { encoding: "utf8" })
const systemPrompt = withSkills ? `你是助手。\n\n${skill("adrate-shared")}\n\n${skill("adrate-ads")}` : "你是助手。"
const tools = withTools ? adrateTools().map(toolSpecOf) : []
const req = lowering.toRequest({
  model,
  systemPrompt,
  tools,
  events: [
    {
      id: "e1", sessionId: "p", seq: 1, at: Date.now(), type: "core.user_message", schemaVersion: 1, actor: "user", trust: "principal",
      payload: { content: [{ type: "text", text: `${"数据行 ".repeat(Number(process.env.PROBE_BIG ?? 0) * 250)}只回答一个字：好` }] },
    },
  ],
})
console.log(`tools=${tools.length} systemPrompt=${systemPrompt.length} chars thinking=${process.env.PROBE_THINKING !== "0"}`)
const t0 = Date.now()
try {
  const gen = lowering.stream(req, {})
  while (true) {
    const step = await gen.next()
    if (step.done) { console.log(`  → ${step.value.stopReason} usage=${JSON.stringify(step.value.usage)} ${step.value.errorMessage ?? ""} ${Date.now() - t0}ms`); break }
    console.log(`  draft ${step.value.type}`)
  }
} catch (err) {
  console.log(`  ✗ ${(err as Error).name}: ${(err as Error).message} ${Date.now() - t0}ms`)
}
