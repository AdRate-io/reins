/**
 * 验收：只凭父会话的 JSONL，能按记录的 childSessionId 找到每个子会话的 JSONL，并证明两边都是自洽的时间线。
 *
 *   node examples/team/replay.ts recordings/<parent>.jsonl
 *
 * 不需要 API key，不碰数据库：父、子录像都经 registry.read（读时升级、未知类型拒绝）→ 整批 append 进内存 EventLog（seq 连续校验）。
 * 找不到任何一个子录像即退出码 1。
 */
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createCoreRegistry, type Event, InMemoryEventLog } from "reins"
import { childSessionsOf, type ExpertOutcome } from "./subagent-tool.ts"

const file = process.argv[2]
if (!file) {
  console.error("用法：node examples/team/replay.ts recordings/<parent>.jsonl")
  process.exit(1)
}
const EXPERT_TOOL_NAMES = new Set(["ask_analyst", "ask_writer"])
const registry = createCoreRegistry()

async function load(path: string): Promise<Event[]> {
  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim() !== "")
  const events = lines.map((l) => registry.read(JSON.parse(l)))
  const log = new InMemoryEventLog()
  await log.append(events) // 存储层校验：同会话、seq 从 1 连续
  return events
}

function stats(events: Event[]) {
  const count = (t: string) => events.filter((e) => e.type === t).length
  const usage = events
    .filter((e) => e.type === "core.budget_usage")
    .map((e) => (e.payload as { tokens: { input: number; output: number; cacheRead?: number } }).tokens)
    .reduce((a, t) => ({ input: a.input + t.input, output: a.output + t.output, cacheRead: a.cacheRead + (t.cacheRead ?? 0) }), {
      input: 0,
      output: 0,
      cacheRead: 0,
    })
  return { events: events.length, requests: count("core.budget_usage"), toolCalls: count("core.tool_call"), memoryOps: count("core.memory_op"), usage }
}

const parent = await load(file)
const parentId = parent[0]?.sessionId ?? "?"
const ps = stats(parent)
console.log(`父会话 ${parentId}：${ps.events} 条事件，模型请求 ${ps.requests}，工具调用 ${ps.toolCalls}，记忆操作 ${ps.memoryOps}，tokens in ${ps.usage.input}+cache ${ps.usage.cacheRead} / out ${ps.usage.output}`)

const children: ExpertOutcome[] = childSessionsOf(parent, EXPERT_TOOL_NAMES)
if (children.length === 0) {
  console.error("父会话里没有任何 ask_* 结果：编排者没有委派过专家")
  process.exit(1)
}
let missing = 0
for (const c of children) {
  const path = join(dirname(file), `${c.childSessionId}.jsonl`)
  try {
    const child = await load(path)
    const cs = stats(child)
    const first = child.find((e) => e.type === "core.user_message")
    const consistent = first?.sessionId === c.childSessionId
    console.log(
      `  └ ${c.role.padEnd(8)} ${c.childSessionId}  ${c.status.padEnd(6)} ${String(cs.events).padStart(3)} 条，请求 ${cs.requests}，工具 ${cs.toolCalls}，记忆 ${cs.memoryOps}，` +
        `tokens in ${cs.usage.input}+cache ${cs.usage.cacheRead} / out ${cs.usage.output}` +
        (cs.usage.input === c.usage.input && cs.usage.output === c.usage.output ? "（与父结果里的汇总一致）" : "（⚠ 与父结果里的汇总不一致）") +
        (consistent ? "" : "（⚠ 子录像的 sessionId 与父记录不符）"),
    )
  } catch (err) {
    missing++
    console.error(`  └ ${c.role.padEnd(8)} ${c.childSessionId}  ❌ 找不到或读不了子录像 ${path}：${(err as Error).message}`)
  }
}
process.exit(missing > 0 ? 1 : 0)
