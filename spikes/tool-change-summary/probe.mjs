/**
 * 工具表大批增删时说明压缩（2026-11-20，AdRate 建议 15）：只列 20 个名字（出现过的排前）+ 总数，
 * 模型还能不能认出"TikTok 工具没了"、不去调已移除的工具？
 *
 * 现场：第一段（脚本化）挂 378 件 MCP 工具，模型用过 campaign_get、adgroup_status_update；第二段 MCP 工具全没了
 * （凭据过期），循环自己写 tools_bound + 变化说明，用户接着提要求，换真模型单次接着跑。
 *
 *   臂 summary：新实现（循环自己落的压缩说明）
 *   臂 full：   对照，同一条日志只把那句换回改前文案（378 个名字全列）
 *   题 used：   "把广告组 adg-7 暂停"——要用的 adgroup_status_update 用过，说明里点名
 *   题 unused： "查一下我名下的 BC 列表"——要用的 bc_get 没用过，压缩说明里也不在 20 个之内
 *
 * 判据：没有调用任何已移除的工具（调了循环回 Unknown tool，记违规）；回复最后一行 `RESULT: DONE` / `RESULT: UNAVAILABLE`
 * （探针专用落笔要求），正确答案都是 UNAVAILABLE。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/tool-change-summary/probe.mjs [deepseek|cf-sonnet|all] [--repeats 2]`。
 * 密钥从仓库根 `.env.local` 读（经 scripts/local-env.mjs）。
 */
import { InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { callTool, ScriptedLowering, say } from "../../packages/core/dist/testing/index.js"
import { anthropicMessages, deepseek } from "../../packages/lowering-fetch/dist/index.js"
import { cfGatewayBase, maybe, need } from "../../scripts/local-env.mjs"

const dsKey = need("DEEPSEEK_API_KEY")
const cfToken = maybe("CF_AIG_TOKEN")

const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all"
const ri = process.argv.indexOf("--repeats")
const repeats = ri >= 0 ? Number(process.argv[ri + 1]) : 2

const SYSTEM =
  "You are the ad operations assistant inside an ad-management tool for TikTok campaigns. Use the tools to act. " +
  "Reply to the user in Chinese.\n\n" +
  "Probe requirement: end every final reply with one line `RESULT: DONE` if you completed the user's latest request, " +
  "or `RESULT: UNAVAILABLE` if you could not because the needed capability is not available to you."

const MODELS = {
  deepseek: () => deepseek("deepseek-flash", { apiKey: dsKey }),
  "cf-sonnet": () =>
    anthropicMessages(process.env.CF_MODEL ?? "claude-sonnet-5-5", {
      provider: "anthropic",
      baseUrl: `${cfGatewayBase()}/anthropic/v1`,
      apiKey: "",
      auth: "none",
      headers: { "cf-aig-authorization": `Bearer ${cfToken}` },
      requestOptions: { max_tokens: 4096 },
    }),
}

/** 378 个 TikTok 风格的工具名（实体 × 动作，取前 378 个），保证含两道题与第一段要用的名字 */
const ENTITIES = [
  "advertiser",
  "campaign",
  "adgroup",
  "ad",
  "creative",
  "bc",
  "bc_asset",
  "bc_member",
  "audience",
  "pixel",
  "pixel_event",
  "catalog",
  "catalog_product",
  "report",
  "identity",
  "video",
  "image",
  "music",
  "comment",
  "lead",
  "tcm_order",
  "spark_ad",
  "smart_plus_campaign",
  "smart_plus_adgroup",
  "rule",
  "budget",
  "payment",
  "invoice",
  "app",
  "offline_event",
  "store",
  "showcase",
  "brand_safety",
  "split_test",
  "reach_frequency",
  "gmv_max",
  "creative_portfolio",
  "playable",
  "instant_page",
  "form",
]
const ACTIONS = [
  "get",
  "list",
  "create",
  "update",
  "status_update",
  "delete",
  "info_get",
  "batch_get",
  "export",
  "audit",
]
const MCP = [...new Set(ENTITIES.flatMap((e) => ACTIONS.map((a) => `${e}_${a}`)))].slice(0, 378)
for (const n of ["campaign_get", "adgroup_status_update", "bc_get"]) if (!MCP.includes(n)) throw new Error(n)

const mcpTool = (name) => ({
  name,
  description: `TikTok Marketing API: ${name.replace(/_/g, " ")}.`,
  risk: "low",
  inputSchema: { type: "object", properties: { advertiser_id: { type: "string" } } },
  execute: () => JSON.stringify({ ok: true }),
})
const hostTool = {
  name: "list_tasks",
  description: "List recent background tasks in this ad-management tool.",
  risk: "low",
  inputSchema: { type: "object", properties: {} },
  execute: () => JSON.stringify({ tasks: [] }),
}

const QUESTIONS = {
  used: "把广告组 adg-7 暂停。",
  unused: "查一下我名下的 BC 列表。",
}

async function drain(gen) {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}
async function events(log, sessionId) {
  const out = []
  for await (const e of log.read(sessionId)) out.push(e)
  return out
}

/** full 臂：变化说明落库时换回改前文案（378 个名字全列）；InMemoryEventLog 读写都 clone，只能在 append 时改 */
class FullNoteLog extends InMemoryEventLog {
  async append(events) {
    return super.append(
      events.map((e) =>
        e.type === "core.system_note" && e.payload.meta?.toolsChanged
          ? {
              ...e,
              payload: {
                ...e.payload,
                text: `Your available tools changed since the previous run. Removed (no longer callable, even if earlier turns used them): ${e.payload.meta.toolsChanged.removed.join(", ")}.`,
              },
            }
          : e,
      ),
    )
  }
}

/** 第一段：脚本化模型用过 campaign_get 与 adgroup_status_update */
async function scene(arm) {
  const log = arm === "full" ? new FullNoteLog() : new InMemoryEventLog()
  const sessionId = `tcs-${Math.random().toString(36).slice(2, 8)}`
  await drain(
    runLoop({
      sessionId,
      log,
      systemPrompt: SYSTEM,
      tools: [hostTool, ...MCP.map(mcpTool)],
      lowering: new ScriptedLowering([
        { drafts: [callTool("c1", "campaign_get", { advertiser_id: "adv-1" })] },
        { drafts: [callTool("c2", "adgroup_status_update", { advertiser_id: "adv-1" })] },
        { drafts: [say("已查到计划 cmp-A，并把广告组 adg-3 暂停了。\nRESULT: DONE")] },
      ]),
      model: { provider: "scripted", id: "scripted" },
      input: "看下 cmp-A 计划，再把广告组 adg-3 暂停。",
    }),
  )
  return { log, sessionId }
}

async function trial(modelName, question, arm) {
  const { log, sessionId } = await scene(arm)
  const before = (await events(log, sessionId)).length
  const calls = []
  const gen = runLoop({
    sessionId,
    log,
    systemPrompt: SYSTEM,
    tools: [hostTool],
    ...MODELS[modelName](),
    input: QUESTIONS[question],
    maxTurns: 2,
  })
  let result
  while (true) {
    const step = await gen.next()
    if (step.done) {
      result = step.value
      break
    }
    if (step.value.type === "core.tool_call") calls.push(step.value.payload.name)
  }
  const note = (await events(log, sessionId))
    .slice(before)
    .find((e) => e.type === "core.system_note" && e.payload.meta?.toolsChanged)
  if (!note || note.payload.text.includes("Removed 378 tools") !== (arm === "summary"))
    throw new Error(`unexpected note: ${note?.payload.text}`)
  if (process.env.SHOW_NOTE) console.log(`[note:${arm}] ${note.payload.text}`)
  const after = (await events(log, sessionId)).slice(before)
  const text = after.filter((e) => e.type === "core.model_text").at(-1)?.payload.text ?? ""
  const said = text.match(/RESULT:\s*`?(DONE|UNAVAILABLE)`?\s*$/m)?.[1] ?? "(none)"
  const removedCalls = calls.filter((n) => MCP.includes(n))
  return {
    modelName,
    question,
    arm,
    pass: said === "UNAVAILABLE" && removedCalls.length === 0,
    said,
    removedCalls,
    status: result.status,
    tail: text.slice(-200).replace(/\n/g, " ⏎ "),
  }
}

// 没配 CF 网关令牌时 all 只跑 DeepSeek
const targets = which === "all" ? ["deepseek", ...(cfToken ? ["cf-sonnet"] : [])] : [which]
for (const modelName of targets) {
  const jobs = []
  for (const question of Object.keys(QUESTIONS))
    for (const arm of ["summary", "full"])
      for (let i = 0; i < repeats; i++)
        jobs.push(
          trial(modelName, question, arm).catch((err) => ({
            modelName,
            question,
            arm,
            pass: false,
            said: `ERROR ${String(err?.message ?? err).slice(0, 160)}`,
            removedCalls: [],
          })),
        )
  const rows = await Promise.all(jobs)
  for (const r of rows)
    console.log(
      `${r.pass ? "✓" : "✗"} ${r.modelName} ${r.question}/${r.arm} said=${r.said}${r.removedCalls.length ? ` CALLED ${r.removedCalls.join(",")}` : ""} ${r.status ?? ""} :: ${r.tail ?? ""}`,
    )
  for (const question of Object.keys(QUESTIONS))
    for (const arm of ["summary", "full"]) {
      const g = rows.filter((r) => r.question === question && r.arm === arm)
      console.log(`== ${modelName} ${question}/${arm}: ${g.filter((r) => r.pass).length}/${g.length}`)
    }
}
