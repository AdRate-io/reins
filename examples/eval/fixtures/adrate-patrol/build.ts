/**
 * 把 examples/adrate 的真实录像 `patrol-disable.jsonl`（B11 巡检降本，2026-09-08）整理成可公开的 fixture 素材：
 *
 *   node examples/eval/fixtures/adrate-patrol/build.ts
 *
 * 产出（都提交进仓库，fixture.ts 只读这两个文件，运行时不再依赖 examples/adrate 与 AdRate CLI）：
 * - recording.jsonl：去外溢（fetch_blob 分片拼回全文、删掉 fetch_blob 对）+ 脱敏后的完整时间线
 * - tools.json：录像里用到的工具在真实运行时的声明（名字、说明、inputSchema、risk、resultPolicy），
 *   取自 examples/adrate/tools.ts 生成的同一张表，保证 eval 里模型看到的工具表与 dogfood 一致
 *
 * 脱敏规则（DECISIONS 2026-09-09 E2）：
 * - 替换：广告主 id（19 位）、计划 id（16 位）、请求 id、Command id、凭证 id、人名 / 团队名 / 广告主名 / 授权账号名
 * - 保留：测试广告主下的计划名（造出来的测试数据，不含业务信息）、时间戳、用量数字、会话与事件 id、模型思考正文
 * 别名等长等形，模型在回放里看到的仍是"像真的"id；同一个值在入参、结果、正文、思考里一起变，回放一致。
 * 构建结束会自查：原 id 一个不剩、别名表每条都命中、没有邮箱与 URL 之外的意外泄漏。报告只打印命中次数，不打印原文。
 */
import { readFileSync, writeFileSync } from "node:fs"
import {
  aliasTable,
  jsonValuesAt,
  matchStrings,
  parseEventsJsonl,
  type Replacement,
  scrubEvents,
  toEventsJsonl,
  unspillRecording,
} from "@reinsjs/eval"
import { adrateTools } from "../../../adrate/tools.ts"

const here = (p: string) => new URL(p, import.meta.url)
const SOURCE = here("../../../adrate/recordings/patrol-disable.jsonl")

/** 录像里出现过、要给模型的工具（fetch_blob 是脑子的，不在其列；wait_seconds 在 fixture 里合成） */
export const TOOL_NAMES = [
  "identity_get",
  "connections_advertisers_list",
  "ads_campaigns_list",
  "ads_campaigns_report",
  "ads_campaigns_get",
  "ads_campaigns_status",
  "commands_get",
  "commands_pending",
  "commands_resume",
  "wait_seconds",
] as const

const pad = (n: number, width: number) => String(n).padStart(width, "0")

function main(): void {
  const raw = parseEventsJsonl(readFileSync(SOURCE, "utf8"))

  // 1. 去外溢
  const un = unspillRecording(raw)
  if (un.incomplete.length > 0) throw new Error(`有外溢结果拼不齐：${un.incomplete.join(", ")}`)

  // 2. 脱敏表
  const advertisers = matchStrings(un.events, /\b7\d{18}\b/)
  const campaigns = matchStrings(un.events, /\b18\d{14}\b/)
  const requestIds = matchStrings(un.events, /\blocal_[0-9a-f]{32}\b/)
  const commandIds = jsonValuesAt(un.events, ["commandId", "credentialId"])
  const names = jsonValuesAt(un.events, ["nickname", "teamName", "advertiserName", "displayName"])
  const table: Replacement[] = [
    ...aliasTable(advertisers, (i) => `7000000000000000${pad(i, 3)}`),
    ...aliasTable(campaigns, (i) => `18000000000${pad(i, 5)}`),
    ...aliasTable(requestIds, (i) => `local_${pad(i, 32)}`),
    ...aliasTable(commandIds, (i) => `00000000-0000-4000-8000-${pad(i, 12)}`),
    ...aliasTable(names, (i) => `name_${pad(i, 2)}`),
  ]
  const { events, hits } = scrubEvents(un.events, table)

  // 3. 自查：原值一个不剩、每条规则都命中、没有意外泄漏
  const after = JSON.stringify(events)
  for (const [from] of table) if (after.includes(from)) throw new Error("脱敏后仍残留原值")
  const missed = hits.filter((h) => h === 0).length
  if (missed > 0) throw new Error(`${missed} 条脱敏规则没有命中，表可能写错了`)
  const leaks = (after.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []).filter((s) => !s.startsWith("reins-"))
  const urls = [...new Set(after.match(/https?:\/\/[^\s"\\]+/g) ?? [])]
  if (leaks.length > 0) throw new Error(`疑似邮箱残留 ${leaks.length} 处`)

  // 4. 工具表
  const byName = new Map(adrateTools().map((t) => [t.name, t]))
  const tools = TOOL_NAMES.map((name) => {
    const t = byName.get(name)
    if (!t) throw new Error(`examples/adrate 的工具表里没有 ${name}`)
    return {
      name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.risk ? { risk: t.risk } : {}),
      ...(t.resultPolicy ? { resultPolicy: t.resultPolicy } : {}),
    }
  })

  writeFileSync(here("./recording.jsonl"), toEventsJsonl(events))
  writeFileSync(here("./tools.json"), `${JSON.stringify(tools, null, 2)}\n`)

  const counts: Record<string, number> = {}
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
  console.log(`源录像 ${raw.length} 条 → 输出 ${events.length} 条（拼回 ${un.restored.length} 个外溢结果，删掉 ${un.droppedFetches} 对 fetch_blob）`)
  console.log(
    `脱敏：广告主 ${advertisers.length}、计划 ${campaigns.length}、请求 id ${requestIds.length}、Command/凭证 id ${commandIds.length}、名称 ${names.length}；共命中 ${hits.reduce((a, b) => a + b, 0)} 处`,
  )
  console.log(`残留 URL（应只有 TikTok/AdRate 文档类公开链接）：${urls.length === 0 ? "无" : urls.join(" ")}`)
  console.log(`事件构成：${JSON.stringify(counts)}`)
  console.log(`工具表 ${tools.length} 个 → tools.json`)
}

main()
