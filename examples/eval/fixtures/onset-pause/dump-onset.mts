/**
 * 从 OnSet 的真实装配导出摄影角色的"世界声明"：系统提示（宿主提示 + memory / skills 等宿主 Socket 的规则片段）与全部工具声明。
 *
 * 为什么要从 OnSet 代码导：时间线里只有 `tools_bound` 的名字，没有说明与 schema，也没有系统提示；
 * 凭记忆重写会让模型面对的不是当时那张卷子。compact / spill / perception / budget 四个模块不导 —— 它们由 eval 的臂提供，
 * 正是这次要对照的部分。
 *
 * 在 OnSet 仓库里跑（要它的 node_modules 与源码），只读一份数据库副本，不碰线上库：
 *   sqlite3 -readonly <OnSet>/data/onset.db ".backup /tmp/onset-copy.db"
 *   cd <OnSet> && ONSET_ROOT=$PWD npx tsx <reins>/examples/eval/fixtures/onset-pause/dump-onset.mts /tmp/onset-copy.db <输出 world-spec.json>
 */
import { writeFileSync } from "node:fs"

const root = process.env.ONSET_ROOT
const [dbPath, out] = process.argv.slice(2)
if (!root || !dbPath || !out) throw new Error("usage: ONSET_ROOT=<OnSet repo> tsx dump-onset.mts <db copy> <out.json>")

const { resolveSocketContributions } = await import(`${root}/node_modules/@reinsjs/core/dist/index.js`)
const { InMemoryRunRegistry } = await import(`${root}/node_modules/@reinsjs/server/dist/index.js`)
const { initDatabase } = await import(`${root}/src/server/db/database`)
const { findRole } = await import(`${root}/src/server/roles/registry`)
const { buildAgentDefinition, createMainBrain } = await import(`${root}/src/server/services/agent-runtime/assembly`)

/** 第三轮试拍的项目 */
const PROJECT_ID = "01a18abb-3a7b-7634-8ae4-8c53baaa4687"
/** 宿主自己的 Socket：规则片段进系统提示、工具进工具表；其余四个由臂提供 */
const HOST_SOCKETS = new Set(["onset-legacy-guard", "onset-memory-guard", "memory", "skills"])

initDatabase(dbPath)
const def = buildAgentDefinition(PROJECT_ID, findRole("cinematographer"), createMainBrain("unused"), new InMemoryRunRegistry())
const sockets = (def.sockets ?? []).filter((s: { name: string }) => HOST_SOCKETS.has(s.name))
const resolved = await resolveSocketContributions({ ...def, sockets })
const tools = resolved.tools.map((t: Record<string, unknown>) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  ...(t.risk ? { risk: t.risk } : {}),
  ...(t.resultPolicy ? { resultPolicy: t.resultPolicy } : {}),
}))
writeFileSync(out, JSON.stringify({ systemPrompt: resolved.systemPrompt, tools }, null, 2))
console.log(`${tools.length} tools, system prompt ${resolved.systemPrompt?.length ?? 0} chars → ${out}`)
process.exit(0)
