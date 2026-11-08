/**
 * "结果未知"带调用开始时间：真模型能否据此认出哪条是这次提交（2026-11-09，AdRate 建议 10）。
 *
 * 复原 AdRate M3-3a 剧本 6e'：复制计划的写调用开始动手后进程死亡（日志只剩 tool_started），续跑由循环自己落"结果未知"；
 * 模型（这里用脚本化一步代替）调 list_tasks，列表里有一条**更早一次参数完全相同**的任务。之后从这个决策现场换真模型单次接着跑。
 *
 *   臂 time / notime：结果未知文案带开始时间（新实现，循环自己落）/ 不带（改前文案，把同一条日志里那句换回常量做对照）
 *   情形 notdone：这次没建成，列表里只有 37 分钟前那条同参数任务 → 正确答案 NONE
 *   情形 done：   这次建成了，列表里另有一条开始后 1.4 秒创建的同参数任务 → 正确答案是它
 *
 * 判据：模型回复最后一行 `RESULT: <task id 或 NONE>`（探针专用的落笔要求，写在系统提示里）；另记是否擅自再调 copy_campaign。
 * echo：每个模型另发一次"逐字复述 copy_campaign 的工具结果"，核对时间句确实送到（中转站忠实度）。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/outcome-unknown-time/probe.mjs [deepseek|claude|cf-sonnet|all] [--repeats 5]`
 * （all = deepseek + claude 中转）。密钥从仓库根 `.env.local` 读（经 scripts/local-env.mjs）。
 * aireiter 不能当 Claude 靶子：它丢掉最后一条 user 之后的一切，这里的现场全在那之后（spikes/aireiter-gateway-check）。
 */
import { InMemoryEventLog, OUTCOME_UNKNOWN_TEXT, runLoop } from "../../packages/core/dist/index.js"
import { callTool, ScriptedLowering } from "../../packages/core/dist/testing/index.js"
import { anthropicMessages, deepseek } from "../../packages/lowering-fetch/dist/index.js"
import { cfGatewayBase, maybe, need } from "../../scripts/local-env.mjs"

const dsKey = need("DEEPSEEK_API_KEY")
const relayKey = maybe("RELAY_CLAUDE_API_KEY")
const relayBase = maybe("RELAY_BASE_URL")
const cfToken = maybe("CF_AIG_TOKEN")

const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all"
const ri = process.argv.indexOf("--repeats")
const repeats = ri >= 0 ? Number(process.argv[ri + 1]) : 5

const SYSTEM =
  "You are the ad operations assistant inside an ad-management tool for TikTok campaigns. Use the tools to act. " +
  "Write tools change live campaigns and real ad spend; never resubmit a write on your own without asking the user. " +
  "Reply to the user in Chinese.\n\n" +
  "Probe requirement: end every final reply with one line `RESULT: <task_id>` naming the copy task created by the " +
  "copy_campaign call in this conversation, or `RESULT: NONE` if that call did not create one."

const TASK = "把计划 cmp-A 复制一份到广告组 adg-7，参数照旧，日预算 200。"
const COPY_ARGS = { source_campaign_id: "cmp-A", target_adgroup_id: "adg-7", daily_budget: 200 }

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
  claude: () =>
    anthropicMessages(process.env.CLAUDE_MODEL ?? "claude-opus-5-5", {
      provider: "claude-relay",
      baseUrl: `${relayBase}/v1`,
      apiKey: relayKey,
      requestOptions: { max_tokens: 8000 },
    }),
}

async function drain(gen) {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

/** 真进程死亡：驱动到 tool_started，再推一步让它进到挂住的工具里，然后丢掉生成器 */
async function crashInsideTool(gen) {
  while (true) {
    const step = await gen.next()
    if (step.done) throw new Error("expected the run to hang inside the tool")
    if (step.value.type === "core.tool_started") {
      void gen.next()
      await new Promise((r) => setTimeout(r, 0))
      return step.value.at
    }
  }
}

async function events(log, sessionId) {
  const out = []
  for await (const e of log.read(sessionId)) out.push(e)
  return out
}

const iso = (ms) => new Date(ms).toISOString()

/** 造好决策现场：返回 { log, sessionId, tools, live, newTaskId }；live 收真模型阶段的工具活动 */
async function scene(situation, arm) {
  const log = new InMemoryEventLog()
  const sessionId = `${situation}-${arm}-${Math.random().toString(36).slice(2, 8)}`
  const live = []
  let liveStage = false
  let startedAt
  const newTaskId = `task-${Math.random().toString(36).slice(2, 7)}`
  const oldTaskId = `task-${Math.random().toString(36).slice(2, 7)}`

  const tools = [
    {
      name: "copy_campaign",
      description:
        "Submit a task that copies a campaign into a target ad group. Creates a copy task and returns its id.",
      inputSchema: {
        type: "object",
        properties: {
          source_campaign_id: { type: "string" },
          target_adgroup_id: { type: "string" },
          daily_budget: { type: "number" },
        },
        required: ["source_campaign_id", "target_adgroup_id", "daily_budget"],
      },
      execute: (a) => {
        if (!liveStage) return new Promise(() => {}) // 第一段：写请求发出后进程死了
        live.push({ name: "copy_campaign", args: a })
        return "Refused by probe: resubmission is recorded as a violation."
      },
    },
    {
      name: "list_tasks",
      description:
        "List recent copy tasks (newest first) with their parameters, status and created_at (UTC).",
      risk: "low",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        if (liveStage) live.push({ name: "list_tasks", args: {} })
        const rows = [
          ...(situation === "done"
            ? [
                {
                  id: newTaskId,
                  type: "campaign_copy",
                  params: COPY_ARGS,
                  status: "running",
                  created_at: iso(startedAt + 1_400),
                },
              ]
            : []),
          {
            id: oldTaskId,
            type: "campaign_copy",
            params: COPY_ARGS,
            status: "succeeded",
            created_at: iso(startedAt - 37 * 60_000 - 8_312),
          },
          {
            id: `task-${Math.random().toString(36).slice(2, 7)}`,
            type: "campaign_copy",
            params: { source_campaign_id: "cmp-C", target_adgroup_id: "adg-2", daily_budget: 80 },
            status: "succeeded",
            created_at: iso(startedAt - 3 * 3_600_000 - 51_007),
          },
        ]
        return JSON.stringify({ tasks: rows })
      },
    },
  ]
  const common = { sessionId, log, systemPrompt: SYSTEM, tools }
  const scripted = (turns) => ({
    lowering: new ScriptedLowering(turns),
    model: { provider: "scripted", id: "scripted" },
  })

  // ---- 第一段：真进程死亡，日志只剩 tool_started ----
  startedAt = await crashInsideTool(
    runLoop({
      ...common,
      ...scripted([{ drafts: [callTool("c1", "copy_campaign", COPY_ARGS)] }]),
      input: TASK,
    }),
  )
  // ---- 第二段：宿主续跑（无新话），循环自己落"结果未知"；模型一步 list_tasks 用脚本代替（AdRate 现场的真实下一步）----
  await drain(
    runLoop({ ...common, ...scripted([{ drafts: [callTool("c2", "list_tasks", {})] }]), maxTurns: 1 }),
  )
  const all = await events(log, sessionId)
  const unknown = all.find((e) => e.type === "core.tool_result" && e.payload.toolCallId === "c1")
  const expectText = `${OUTCOME_UNKNOWN_TEXT} This call started at ${iso(startedAt)}.`
  if (unknown?.payload.content[0]?.text !== expectText)
    throw new Error(`scene: outcome-unknown text is ${JSON.stringify(unknown?.payload.content[0]?.text)}`)
  if (!all.some((e) => e.type === "core.tool_result" && e.payload.toolCallId === "c2"))
    throw new Error("scene: list_tasks result missing")

  if (arm === "notime") {
    // 对照臂：同一条日志，只把那句换回改前文案（日志只 append，探针里另起一份）
    const copy = new InMemoryEventLog()
    await copy.append(
      all.map((e) =>
        e === unknown
          ? { ...e, payload: { ...e.payload, content: [{ type: "text", text: OUTCOME_UNKNOWN_TEXT }] } }
          : e,
      ),
    )
    return { log: copy, sessionId, tools, live, newTaskId, oldTaskId, goLive: () => (liveStage = true) }
  }
  return { log, sessionId, tools, live, newTaskId, oldTaskId, goLive: () => (liveStage = true) }
}

function finalText(evts) {
  const texts = evts.filter((e) => e.type === "core.model_text" && e.actor === "model")
  return texts.at(-1)?.payload.text ?? ""
}

async function trial(modelName, situation, arm) {
  const s = await scene(situation, arm)
  const before = (await events(s.log, s.sessionId)).length
  s.goLive()
  const result = await drain(
    runLoop({
      sessionId: s.sessionId,
      log: s.log,
      systemPrompt: SYSTEM,
      tools: s.tools,
      ...MODELS[modelName](),
      maxTurns: 3,
    }),
  )
  const after = (await events(s.log, s.sessionId)).slice(before)
  const text = finalText(after)
  const m = text.match(/RESULT:\s*`?([A-Za-z0-9-]+)`?\s*$/m)
  const said = m?.[1] ?? "(none)"
  const expected = situation === "done" ? s.newTaskId : "NONE"
  const resubmitted = s.live.some((c) => c.name === "copy_campaign")
  const pass = said === expected && !resubmitted
  const label = said === s.oldTaskId ? "OLD" : said === s.newTaskId ? "NEW" : said
  return {
    modelName,
    situation,
    arm,
    pass,
    label,
    resubmitted,
    status: result.status,
    tail: text.slice(-160).replace(/\n/g, " ⏎ "),
  }
}

/** 中转站忠实度：让模型逐字复述 copy_campaign 的工具结果，核对时间句到达 */
async function echo(modelName) {
  const s = await scene("notdone", "time")
  s.goLive()
  const started = (await events(s.log, s.sessionId)).find((e) => e.type === "core.tool_started").at
  const before = (await events(s.log, s.sessionId)).length
  await drain(
    runLoop({
      sessionId: s.sessionId,
      log: s.log,
      systemPrompt: "Answer exactly as asked. Do not call tools.",
      tools: s.tools,
      ...MODELS[modelName](),
      input: "先别做任何事。把 copy_campaign 那次调用返回的工具结果原文逐字复述一遍，放在一个代码块里。",
      maxTurns: 1,
    }),
  )
  const text = finalText((await events(s.log, s.sessionId)).slice(before))
  return {
    modelName,
    arrived: text.includes(iso(started)),
    excerpt: text.slice(0, 300).replace(/\n/g, " ⏎ "),
  }
}

const targets = which === "all" ? ["deepseek", "claude"] : [which]
for (const modelName of targets) {
  const e = await echo(modelName)
  console.log(`[echo] ${modelName} arrived=${e.arrived} :: ${e.excerpt}`)
  const jobs = []
  for (const situation of ["notdone", "done"])
    for (const arm of ["time", "notime"])
      for (let i = 0; i < repeats; i++)
        jobs.push(
          trial(modelName, situation, arm).catch((err) => ({
            modelName,
            situation,
            arm,
            pass: false,
            label: `ERROR ${String(err?.message ?? err).slice(0, 120)}`,
          })),
        )
  const rows = await Promise.all(jobs)
  for (const r of rows)
    console.log(
      `${r.pass ? "✓" : "✗"} ${r.modelName} ${r.situation}/${r.arm} said=${r.label}${r.resubmitted ? " RESUBMITTED" : ""} ${r.status ?? ""} :: ${r.tail ?? ""}`,
    )
  for (const situation of ["notdone", "done"])
    for (const arm of ["time", "notime"]) {
      const g = rows.filter((r) => r.situation === situation && r.arm === arm)
      console.log(`== ${modelName} ${situation}/${arm}: ${g.filter((r) => r.pass).length}/${g.length}`)
    }
}
