/**
 * haltOnFailure 真模型行为验证（2026-11-03，OnSet 建议 9 实施方案验证矩阵末行）。
 *
 * 要看的是"被拦下之后模型下一步做什么"，所以第一批用脚本化降级层确定地造出来（模型一次回复里先改状态、再发通知），
 * 之后同一条日志换 DeepSeek 官方真模型接着跑，最多 3 轮。两个场景：
 *
 *   failed   [board_update(rev 7) → rev 过期失败, chat_send → 被拦]：模型应先用 rev 8 改成功，再重发通知；
 *            判据：真模型阶段 chat_send 至少一次、且第一次 chat_send 之前已有一次成功的 board_update
 *   waiting  [deploy(需审批) → 挂起, chat_send → 以 still waiting 被拦]，宿主随后批准续跑：deploy 补跑成功，
 *            判据：真模型阶段重发了 chat_send
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/batch-halt/probe.mjs [--repeats 5]`；密钥自动从信息文件读。
 */
import { readFileSync } from "node:fs"
import { haltOnFailure } from "../../packages/brain/dist/index.js"
import { InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { callTool, ScriptedLowering } from "../../packages/core/dist/testing/index.js"
import { deepseek } from "../../packages/lowering-fetch/dist/index.js"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const dsKey = info.slice(info.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
if (!dsKey) throw new Error("信息文件里缺 DeepSeek key")
const i = process.argv.indexOf("--repeats")
const repeats = i >= 0 ? Number(process.argv[i + 1]) : 5

const SYSTEM =
  "You are a member of a small product team working on a shared board. Use the tools to act. " +
  "To save round trips, put actions that belong together in the same reply, in the order they should happen."

async function drain(gen) {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

/** 一次试验：脚本化第一批 → （可选）宿主批准 → 真模型最多 3 轮。返回真模型阶段的工具调用序列 */
async function trial(scenario) {
  const log = new InMemoryEventLog()
  const sessionId = `${scenario}-${Math.random().toString(36).slice(2, 8)}`
  const live = [] // 真模型阶段的执行记录：{ name, ok, args }
  let liveStage = false
  let rev = 8
  const record = (name, ok, args) => {
    if (liveStage) live.push({ name, ok, args })
  }
  const tools = [
    {
      name: "board_update",
      description: "Update a board item. `rev` must equal the item's current revision.",
      inputSchema: {
        type: "object",
        properties: { item: { type: "string" }, status: { type: "string" }, rev: { type: "number" } },
        required: ["item", "status", "rev"],
      },
      execute: (a) => {
        if (a.rev !== rev) {
          record("board_update", false, a)
          return { content: [{ type: "text", text: `Rejected: rev ${a.rev} is stale, the item's current rev is ${rev}.` }], isError: true }
        }
        rev++
        record("board_update", true, a)
        return `Item ${a.item} is now "${a.status}" (rev ${rev}).`
      },
    },
    {
      name: "chat_send",
      description: "Send a chat message to a teammate. Wakes them up.",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" }, text: { type: "string" } },
        required: ["to", "text"],
      },
      execute: (a) => {
        record("chat_send", true, a)
        return "Sent."
      },
    },
    {
      name: "deploy",
      description: "Deploy the current build to an environment.",
      inputSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
      needsApproval: true,
      execute: (a) => {
        record("deploy", true, a)
        return `Deployed to ${a.env}.`
      },
    },
  ]
  const common = { sessionId, log, tools, sockets: [haltOnFailure()], systemPrompt: SYSTEM }

  const firstBatch =
    scenario === "failed"
      ? [
          callTool("c1", "board_update", { item: "T-12", status: "ready_for_review", rev: 7 }),
          callTool("c2", "chat_send", { to: "lead", text: "T-12 is ready for review, please take a look." }),
        ]
      : [
          callTool("c1", "deploy", { env: "prod" }),
          callTool("c2", "chat_send", { to: "lead", text: "v2.3 is live in prod." }),
        ]
  const task =
    scenario === "failed"
      ? "Mark board item T-12 as ready_for_review (I think it's at rev 7), then tell lead it's ready for review."
      : "Deploy the current build to prod, then tell lead that v2.3 is live."
  // 第一批：脚本化；之后若模型被问到就停（maxTurns 1 只走这一步）
  await drain(
    runLoop({
      ...common,
      lowering: new ScriptedLowering([{ drafts: firstBatch }]),
      model: { provider: "scripted", id: "scripted" },
      input: task,
      maxTurns: 1,
    }),
  )
  liveStage = true
  const model = deepseek(process.env.MODEL ?? "deepseek-flash", { apiKey: dsKey })
  const result = await drain(
    runLoop({
      ...common,
      ...model,
      maxTurns: 3,
      ...(scenario === "waiting" ? { decisions: [{ sessionId, toolCallId: "c1", approved: true, by: "boss" }] } : {}),
    }),
  )
  const firstChat = live.findIndex((c) => c.name === "chat_send")
  const firstGoodUpdate = live.findIndex((c) => c.name === "board_update" && c.ok)
  const pass =
    scenario === "failed"
      ? firstChat >= 0 && firstGoodUpdate >= 0 && firstGoodUpdate < firstChat
      : live[0]?.name === "deploy" && firstChat > 0
  return { scenario, pass, status: result.status, calls: live.map((c) => `${c.name}${c.ok ? "" : "✗"}`).join(" → ") }
}

const jobs = []
for (const s of ["failed", "waiting"]) for (let r = 0; r < repeats; r++) jobs.push(trial(s))
const rows = await Promise.allSettled(jobs)
const out = rows.map((r) => (r.status === "fulfilled" ? r.value : { scenario: "?", pass: false, status: "threw", calls: String(r.reason) }))
console.table(out)
for (const s of ["failed", "waiting"]) {
  const mine = out.filter((r) => r.scenario === s)
  console.log(`${s}: ${mine.filter((r) => r.pass).length}/${mine.length}`)
}
