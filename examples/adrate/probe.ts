/** 排障：单独打一次模型请求，按开关带 / 不带工具表与 Skill 长提示。node examples/adrate/probe.ts [tools] [skills] */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { anthropic } from "@reinsjs/lowering-pi"
import { toolSpecOf } from "reins"
import { adrateTools } from "./tools.ts"

const withTools = process.argv.includes("tools")
const withSkills = process.argv.includes("skills")
const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const keys = [...info.matchAll(/密钥[^`]*`(sk-[^`]+)`/g)].map((m) => m[1] as string)
const deepseek = process.env.REINS_PROVIDER === "deepseek"
const { model, lowering } = anthropic(process.env.REINS_MODEL ?? (deepseek ? "deepseek-v4-flash" : "claude-opus-5"), {
  apiKey: (deepseek ? keys[1] : keys[0]) as string,
  baseUrl: deepseek ? "https://api.deepseek.com/anthropic" : "https://aireiter.com/api",
  requestOptions: { thinkingEnabled: process.env.PROBE_THINKING !== "0", thinkingBudgetTokens: 2048 },
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
