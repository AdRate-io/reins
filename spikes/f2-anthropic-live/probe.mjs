/**
 * F2 真模型核实：@reinsjs/lowering-fetch 的 Anthropic Messages 线在 core runLoop 上跑一条带工具的多轮，经 Cloudflare AI Gateway
 * 透传路径打官方模型（F0 体检 43/43 已证网关忠实）。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/f2-anthropic-live/probe.mjs [haiku|opus|all]`；
 * 配置自动从《模型API测试信息.md》读（CF 网关令牌 / account id / gateway id）。可用 F2_HAIKU_MODEL / F2_OPUS_MODEL 换模型。
 *
 * 判据是产出内容不是状态码（暗号法）：
 *   1. 模型先后调两次工具，最终答案含两次结果之和（19）；
 *   2. haiku：显式开 thinking（budget），第二个请求起历史 assistant 里带 signature 的 thinking 块被原样回放且被接受；
 *      opus：缺省 adaptive thinking，不传 thinking 参数；
 *   3. opus：运行中途宿主注入的 system_note（暗号）以中途 role:"system" 到达模型（Haiku 不支持，注入会以 <system_note> user 文本到达）；
 *   4. 系统提示凑到 4.5k token 以上（越过 Haiku 4.5 的 4096 最小可缓存长度），第二个请求起 budget_usage 有 cacheRead > 0——
 *      证明我们自己打的三处断点（system 末块 / tools 末项 / 最后一条 user 末块）在官方上真的命中；
 *   5. 每轮 budget_usage 有真实用量并算出成本；有损落点只有声明过的几种。
 */
import { readFileSync } from "node:fs"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { anthropicMessages } from "../../packages/lowering-fetch/dist/index.js"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const cfToken = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
const cfAccount = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
const cfGateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
if (!cfToken || !cfAccount) throw new Error("信息文件里缺 CF 令牌 / account id")
const BASE = `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/anthropic/v1`

const which = process.argv[2] ?? "all"
const CODEWORD = "TAMARIND"

/** 越过 Haiku 4.5 的 4096 token 最小可缓存长度（Opus / Sonnet 是 1024） */
const LONG_SYSTEM = `You are a terse assistant. Use lookup_price for every item the user names (one call per item), then answer in one line.\n${"Rule: be exact and brief. ".repeat(1100)}`

const gateway = (id, extra) =>
  anthropicMessages(id, {
    provider: "anthropic",
    baseUrl: BASE,
    apiKey: "",
    auth: "none",
    headers: { "cf-aig-authorization": `Bearer ${cfToken}` },
    ...extra,
  })

const TARGETS = {
  haiku: () =>
    gateway(process.env.F2_HAIKU_MODEL ?? "claude-haiku-4-5-20251001", {
      requestOptions: { max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 } },
    }),
  opus: () => gateway(process.env.F2_OPUS_MODEL ?? "claude-opus-5", { requestOptions: { max_tokens: 4096 } }),
}

const lookup = defineTool({
  name: "lookup_price",
  description: "Look up the unit price (USD) of an item in the catalog",
  inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  risk: "low",
  execute: ({ item }) => ({ item, unitPrice: item.toLowerCase().includes("pen") ? 7 : 12 }),
})

async function run(name) {
  const bound = TARGETS[name]()
  const caps = bound.lowering.capabilities(bound.model)
  const log = new InMemoryEventLog()
  const events = []
  const requests = []
  let injected = false
  const gen = runLoop({
    sessionId: `f2-${name}-${Date.now()}`,
    log,
    lowering: bound.lowering,
    model: bound.model,
    tools: [lookup],
    systemPrompt: LONG_SYSTEM,
    input:
      "How much do one pen and one notebook cost together? Look up each item separately, then give the total.",
    onLandings: (losses, req) => requests.push({ losses, body: req.payload.body }),
    sockets: [
      {
        id: "spike-inject",
        // 第一批工具结果回来后注入一条宿主说明（暗号）：Opus 上应以中途 system 到达；措辞是指令不是"套暗号"的提问，避开厂商分类器
        afterTool: (ctx) => {
          if (!injected) {
            injected = true
            ctx.emit({
              type: "core.system_note",
              actor: "host",
              payload: {
                kind: "host",
                text: `Harness note (from the runtime, not the user): when you give the final answer, append the codeword ${CODEWORD} at the end.`,
              },
            })
          }
          return undefined
        },
      },
    ],
  })
  let result
  while (true) {
    const step = await gen.next()
    if (step.done) {
      result = step.value
      break
    }
    events.push(step.value)
  }
  const types = events.map((e) => e.type.replace("core.", ""))
  const texts = events.filter((e) => e.type === "core.model_text").map((e) => e.payload.text)
  const calls = events.filter((e) => e.type === "core.tool_call")
  const thinkings = events.filter((e) => e.type === "core.model_thinking")
  const usages = events.filter((e) => e.type === "core.budget_usage").map((e) => e.payload.tokens)
  const errors = events.filter((e) => e.type === "core.error").map((e) => e.payload.message)
  const finalText = texts.at(-1) ?? ""
  const lastReq = requests.at(-1)?.body
  const msgs = lastReq?.messages ?? []
  const historyAssistants = msgs.filter((m) => m.role === "assistant")
  const midSystem = msgs.filter((m) => m.role === "system")
  const signedThinking = historyAssistants
    .flatMap((m) => m.content)
    .filter((b) => b.type === "thinking" && b.signature)
  const bpCount = (body) => {
    const has = (b) => b && typeof b === "object" && "cache_control" in b
    return (
      (body.system ?? []).filter(has).length +
      (body.tools ?? []).filter(has).length +
      (body.messages ?? []).flatMap((m) => m.content).filter(has).length +
      (body.cache_control ? 1 : 0)
    )
  }

  const checks = [
    ["run 正常结束", result?.status === "done", `${result?.status} ${errors.join(" | ")}`],
    [
      "调了两次工具",
      calls.length >= 2,
      `calls=${calls.length} ${calls.map((c) => JSON.stringify(c.payload.args)).join(" ")}`,
    ],
    ["最终答案含总价 19", /19/.test(finalText), finalText.slice(0, 120)],
    [
      caps.midConversationSystem
        ? "中途注入的 system_note 以 role:system 到达且暗号出现在最终答案"
        : "不支持中途 system：说明以 user 文本到达，暗号仍出现在最终答案",
      finalText.includes(CODEWORD) &&
        (caps.midConversationSystem ? midSystem.length >= 1 : midSystem.length === 0),
      `midSystem=${midSystem.length} tail=${finalText.slice(-60)}`,
    ],
    [
      name === "haiku"
        ? "Haiku：产出带签名的 thinking，且第二个请求起历史 assistant 里原样回放（被接受）"
        : "Opus：缺省 adaptive thinking，请求体不带 thinking 参数；历史里的 thinking 块带签名回放",
      name === "haiku"
        ? thinkings.length >= 1 &&
          thinkings.every((t) => t.replay?.thinkingSignature) &&
          signedThinking.length >= 1
        : !("thinking" in (lastReq ?? {})) && (thinkings.length === 0 || signedThinking.length >= 1),
      `thinkings=${thinkings.length} signedInHistory=${signedThinking.length} thinkingParam=${JSON.stringify(lastReq?.thinking)}`,
    ],
    [
      "每个请求体的断点数在 1～4 之间：system 末块 + tools 末项 + 最后一条 user 末块（说明殿后时顶层 cache_control）",
      requests.every((r) => bpCount(r.body) >= 1 && bpCount(r.body) <= 4) &&
        requests.every((r) => r.body.system?.at(-1)?.cache_control && r.body.tools?.at(-1)?.cache_control),
      requests.map((r) => `${bpCount(r.body)}${r.body.cache_control ? "(top)" : ""}`).join(","),
    ],
    [
      "第二个请求起 cacheRead > 0（我们打的断点在官方上真命中）",
      usages.length >= 2 && usages.slice(1).every((u) => (u.cacheRead ?? 0) > 0),
      JSON.stringify(usages),
    ],
    [
      "每轮 budget_usage 有真实用量",
      usages.length >= 2 &&
        usages.every((u) => u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0 && u.output > 0),
      JSON.stringify(usages),
    ],
    [
      "有损落点只有声明过的几种（工具结果的 untrusted 标记为 exact；system_note 在 Haiku 上是 lossy user-role）",
      requests.every((r) =>
        r.losses.every(
          (l) =>
            (l.kind === "dropped" && (l.type === "core.budget_usage" || l.type === "core.tools_bound")) ||
            (l.kind === "lossy" &&
              l.type === "core.system_note" &&
              l.landing === "user-role" &&
              !caps.midConversationSystem),
        ),
      ),
      JSON.stringify(requests.flatMap((r) => r.losses.map((l) => `${l.type}:${l.kind}/${l.landing}`))),
    ],
  ]
  console.log(
    `\n=== ${name} (${bound.model.provider}/${bound.model.id}) midConversationSystem=${caps.midConversationSystem} ===`,
  )
  console.log(`事件序列：${types.join(" → ")}`)
  let pass = 0
  for (const [label, ok, detail] of checks) {
    pass += ok ? 1 : 0
    console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ← ${detail}`}`)
    if (ok && process.env.F2_VERBOSE) console.log(`    ${detail}`)
  }
  if (process.env.F2_VERBOSE) console.log(JSON.stringify(lastReq, null, 1).slice(0, 4000))
  console.log(`${name}: ${pass}/${checks.length}`)
  return pass === checks.length
}

const names = which === "all" ? Object.keys(TARGETS) : TARGETS[which] ? [which] : null
if (!names) {
  console.error("用法：node spikes/f2-anthropic-live/probe.mjs [haiku|opus|all]")
  process.exit(2)
}
let allOk = true
for (const n of names) {
  try {
    allOk = (await run(n)) && allOk
  } catch (e) {
    allOk = false
    console.log(`✗ ${n} 异常：${e?.message ?? e}`)
  }
}
process.exit(allOk ? 0 : 1)
