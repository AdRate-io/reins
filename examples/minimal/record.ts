/**
 * 录一段真实会话：用 agent.ts 里那个 agent 不经 HTTP 跑三次（问天气 → 要上线 → 审批后续跑），
 * 把整条时间线按 JSONL（一行一个事件）写到文件，供 replay.ts 离线回放。
 *
 *   pnpm build && ANTHROPIC_API_KEY=… node examples/minimal/record.ts [输出路径]
 *
 * 三次 run 用同一个 sessionId，这就是 reins 的"续聊"：不需要在内存里保存对话对象，日志就是对话。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Event, RunResult } from "reins"
import { agent } from "./agent.ts"

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("请设置 ANTHROPIC_API_KEY（走网关再加 REINS_GATEWAY_BASE=https://host/api）")
  process.exit(1)
}

const out = process.argv[2] ?? new URL("./recordings/weather-deploy.jsonl", import.meta.url).pathname

/** 跑一次，边跑边把每条刚入日志的事件打一行，返回四态结果 */
async function run(label: string, options: Parameters<typeof agent.run>[0]): Promise<RunResult> {
  console.log(`\n▶ ${label}`)
  const gen = agent.run(options)
  while (true) {
    const step = await gen.next()
    if (step.done) {
      console.log(`  ⏹ ${step.value.status}（lastSeq ${step.value.lastSeq}）`)
      return step.value
    }
    console.log(`  ${String(step.value.seq).padStart(3)}  ${step.value.actor.padEnd(6)} ${step.value.type}`)
  }
}

// 1. 问天气：模型思考、调 get_weather、回答
const first = await run("上海今天天气怎么样？", { input: "上海今天天气怎么样？" })
const sessionId = first.sessionId

// 2. 要上线：deploy 声明了 needsApproval，循环在执行前暂停等人点头
const second = await run("很好，把当前版本上线到 prod", { sessionId, input: "很好，把当前版本上线到 prod" })
if (second.status !== "paused") {
  console.error(`预期暂停等审批，实际 ${second.status}；录制中止`)
  process.exit(1)
}
const approvals = second.interruptions.filter((i) => i.kind === "approval")

// 3. 批准：回传上次的 state（模拟另一个进程 / 另一次请求），循环验签后执行 deploy 并让模型收尾
const third = await run("Boss 批准上线", {
  sessionId,
  resume: second.state,
  decisions: approvals.map((a) => ({ toolCallId: a.toolCallId, approved: true, by: "boss" })),
})
if (third.status !== "done") console.warn(`最后一次 run 以 ${third.status} 结束，仍照样录下`)

// 日志就是全部：一行一个事件，原样落盘
const events: Event[] = []
for await (const e of agent.definition.log.read(sessionId)) events.push(e)
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`)
console.log(`\n✓ 会话 ${sessionId} 共 ${events.length} 条事件 → ${out}`)
console.log(`  回放：node examples/minimal/replay.ts ${out} --html examples/minimal/recordings/replay.html`)
