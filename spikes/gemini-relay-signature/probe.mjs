/**
 * Gemini 经中转站（仓库根 `.env.local` 的 RELAY_GEMINI_API_KEY / RELAY_BASE_URL，经 scripts/local-env.mjs 读）多轮工具调用的签名核实（2026-11-05，OnSet 建议 12 前置）。
 *
 * 问题：Gemini 3 多轮函数调用要求回放 functionCall 上的 thoughtSignature。中转站把它放在非标字段里
 * （Messages 线的 tool_use.signature 等），reins 读流时不保留这些字段——丢了之后中转站还认不认？
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/gemini-relay-signature/probe.mjs [chat|anthropic|responses|all]`
 * 原始请求 / 响应落到 OUT_DIR（缺省系统临时目录），只记请求体与响应正文，不记头（不含密钥）。
 *
 * 判据是产出内容不是状态码（暗号法）：工具 step 1 返回一次性口令，step 2 必须带口令才给暗号——强制至少两轮
 * 依赖调用，第三个请求的历史里有两次 tool_call。最终答案含暗号 ⟺ 中转站接受了 reins 产出的历史。
 * 另外从第一轮原始流里找签名类字段（signature / thought_signature / thoughtSignature / extra_content），
 * 再看 reins 发出的第二、三个请求里这些字段还在不在。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import {
  anthropicMessages,
  chatCompletions,
  openaiResponses,
} from "../../packages/lowering-fetch/dist/index.js"
import { need } from "../../scripts/local-env.mjs"

const key = need("RELAY_GEMINI_API_KEY")
// RELAY_BASE_URL 不带 /v1、无尾斜杠
const base = need("RELAY_BASE_URL")
const MODEL = process.env.MODEL ?? "gemini-3.8-flash-high"
const OUT = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), "reins-gemini-sig-"))
mkdirSync(OUT, { recursive: true })

const rand = () =>
  Array.from({ length: 6 }, () => "ACDEFHJKLNPRTUXY34679"[Math.floor(Math.random() * 21)]).join("")

const SIG_RE = /"(signature|thought_signature|thoughtSignature|extra_content)"/g

function target(line, recorder) {
  const common = {
    provider: "gemini-relay",
    baseUrl: `${base}/v1`,
    apiKey: key,
    reasoning: true,
    fetch: recorder,
    requestOptions: { max_tokens: 4096 },
  }
  if (line === "chat") return chatCompletions(MODEL, common)
  if (line === "anthropic") return anthropicMessages(MODEL, common)
  return openaiResponses(MODEL, { ...common, requestOptions: { max_output_tokens: 4096 } })
}

async function run(line) {
  const pass = rand()
  const codeword = rand()
  const exchanges = []
  /** 包一层 fetch：记下请求体与完整响应正文（clone 后读，不影响降级层消费） */
  const recorder = async (url, init) => {
    const res = await fetch(url, init)
    const entry = { url: String(url), status: res.status, body: JSON.parse(String(init.body)), raw: "" }
    exchanges.push(entry)
    entry.raw = await res.clone().text()
    return res
  }
  const bound = target(line, recorder)
  const step = defineTool({
    name: "vault_step",
    description:
      "Two-step vault. Call with {step:1} to get a one-time passphrase. Then call with {step:2, passphrase} to get the codeword.",
    inputSchema: {
      type: "object",
      properties: { step: { type: "integer" }, passphrase: { type: "string" } },
      required: ["step"],
    },
    risk: "low",
    execute: ({ step, passphrase }) => {
      if (step === 1) return { passphrase: pass }
      if (step === 2) return passphrase === pass ? { codeword } : { error: "wrong passphrase" }
      return { error: "unknown step" }
    },
  })
  const gen = runLoop({
    sessionId: `gsig-${line}-${Date.now()}`,
    log: new InMemoryEventLog(),
    lowering: bound.lowering,
    model: bound.model,
    tools: [step],
    systemPrompt: "You are a terse assistant. Use the tools; never guess values.",
    input:
      "Open the vault (step 1, then step 2 with the passphrase) and tell me the codeword. Reply with the codeword only.",
    onLandings: () => {},
  })
  const events = []
  let result
  while (true) {
    const s = await gen.next()
    if (s.done) {
      result = s.value
      break
    }
    events.push(s.value)
  }
  writeFileSync(join(OUT, `${line}.json`), JSON.stringify(exchanges, null, 1))
  const finalText = events.filter((e) => e.type === "core.model_text").at(-1)?.payload.text ?? ""
  const calls = events.filter((e) => e.type === "core.tool_call")
  const errors = events.filter((e) => e.type === "core.error").map((e) => e.payload.message?.slice(0, 300))
  const sigIn = (s) => [...new Set([...s.matchAll(SIG_RE)].map((m) => m[1]))]
  console.log(`\n=== ${line} (${MODEL}) ===`)
  console.log(
    `结果 ${result?.status}  工具调用 ${calls.length} 次  最终答案含暗号 ${finalText.includes(codeword) ? "✓" : "✗"}`,
  )
  if (errors.length) console.log(`错误：${errors.join(" | ")}`)
  exchanges.forEach((x, i) => {
    console.log(
      `  请求 ${i + 1}: HTTP ${x.status}  响应里的签名字段 [${sigIn(x.raw).join(",")}]  请求体里的签名字段 [${sigIn(JSON.stringify(x.body)).join(",")}]`,
    )
    if (x.status !== 200) console.log(`    响应：${x.raw.slice(0, 400)}`)
  })
  console.log(`  最终答案：${finalText.slice(0, 120)}`)
  return { line, ok: result?.status === "done" && finalText.includes(codeword) }
}

const which = process.argv[2] ?? "all"
const lines = which === "all" ? ["chat", "anthropic", "responses"] : [which]
const out = await Promise.all(lines.map(run))
console.log(`\n原始交换：${OUT}`)
console.log(out.map((r) => `${r.ok ? "✓" : "✗"} ${r.line}`).join("  "))
