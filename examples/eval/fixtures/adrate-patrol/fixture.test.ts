/**
 * fixture 自检：世界从录像里长得对不对、回放工具与补位是否自洽、评分器与约束是否按设计打分。
 * 用脚本化"模型"跑 runEval，不联网。
 */
import type { CoreEventOf, ToRequestInput } from "@reins/core"
import { callTool, type Script, ScriptedLowering, say } from "@reins/core/testing"
import { noneArm, runEval } from "@reins/eval"
import { describe, expect, it } from "vitest"
import { adratePatrolFixtures, loadRecording, seedOf, worldOf } from "./fixture.ts"

const MODEL = { provider: "scripted", id: "scripted" }
const suite = adratePatrolFixtures()
const { world } = suite
const fx = (id: string) => {
  const f = suite.fixtures.find((x) => x.id === id)
  if (!f) throw new Error(id)
  return f
}
const ADV = world.advertiserId
const CANDIDATES = world.candidates.map((c) => c.campaignId)

const calledNames = (input: ToRequestInput) =>
  input.events.filter((e) => e.type === "core.tool_call").map((e) => (e as CoreEventOf<"core.tool_call">).payload.name)
/** 探针会话没有宿主工具（runner 传 tools: []），主任务有 */
const isProbe = (input: ToRequestInput) => (input.tools ?? []).length === 0

/** 探针一律用一句话把所有预埋事实都答上（这里测的是评分器接线，不是模型记性） */
const PROBE_ANSWER = `${world.candidates.length} 条；名称 ${world.candidates[0]?.campaignName}；${world.window.startDate} 至 ${world.window.endDate}；每分钟 ${world.writeLimitPerMinute} 次；广告主 ${ADV}；共 ${world.campaigns.length} 条；CAMPAIGN_STATUS_BUDGET_EXCEED`
const table = (ids: readonly string[]) => `汇总表：\n${ids.map((id, i) => `| ${i + 1} | ${id} | DISABLE | succeeded |`).join("\n")}`

let n = 0
const id = () => `c${++n}`

/** 理想路径：分页读完 → 复核 → 停投 → 汇总 */
const ideal: Script = (input) => {
  if (isProbe(input)) return { drafts: [say(PROBE_ANSWER)] }
  const names = calledNames(input)
  if (!names.includes("ads_campaigns_list"))
    return {
      drafts: [
        callTool(id(), "ads_campaigns_list", { advId: ADV, page: 1, pageSize: 100 }),
        callTool(id(), "ads_campaigns_list", { advId: ADV, page: 2, pageSize: 100 }),
        callTool(id(), "ads_campaigns_report", { advId: ADV, ...world.window, groupBy: "none", page: 1, pageSize: 100 }),
        callTool(id(), "ads_campaigns_report", { advId: ADV, ...world.window, groupBy: "none", page: 2, pageSize: 100 }),
      ],
    }
  if (!names.includes("ads_campaigns_get"))
    return { drafts: CANDIDATES.map((c) => callTool(id(), "ads_campaigns_get", { advId: ADV, campaignId: c })) }
  if (!names.includes("ads_campaigns_status"))
    return {
      drafts: CANDIDATES.map((c) => callTool(id(), "ads_campaigns_status", { advId: ADV, campaignId: c, desiredStatus: "DISABLE" })),
    }
  return { drafts: [say(`14 条全部停投成功。${table(CANDIDATES)}`)] }
}

describe("世界：从脱敏录像里长出来", () => {
  it("102 条计划、102 行报表、14 条候选、14 条复核、14 条成功 Command；bug 那轮的失败写被剔出回放", () => {
    expect(world.campaigns).toHaveLength(102)
    expect(world.rows).toHaveLength(102)
    expect(world.candidates).toHaveLength(14)
    expect(world.verified.size).toBe(14)
    expect(world.commands.size).toBe(14)
    expect(world.writeLimitPerMinute).toBe(10)
    expect(world.window).toEqual({ startDate: "2026-08-09", endDate: "2026-09-07" })
    expect(ADV).toMatch(/^7\d{18}$/)
    // 14 个被拒的停投 + 1 个重试也被拒 + 1 个按键对账查不到 = 16 对
    expect(world.recording.length - world.replayable.length).toBe(2 * 16)
    // 录像里不再有真实 id / 人名
    const text = JSON.stringify(world.recording)
    expect(text).not.toMatch(/7000000000000000001|name_01|dailihu/)
    expect(suite.tools.stats.spilled).toBe(0)
    expect(suite.tools.stats.unanswered).toBe(0)
    expect(suite.tools.all.map((t) => t.name)).toEqual([
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
    ])
    expect(suite.tools.readOnly.map((t) => t.name)).not.toContain("ads_campaigns_status")
  })

  it("种子：第二条 user 之前的历史，去掉 perception / pin / budget_usage，seq 从 1 连续", () => {
    const seed = seedOf(loadRecording())
    expect(seed.every((e, i) => e.seq === i + 1)).toBe(true)
    expect(seed.filter((e) => e.type === "core.user_message")).toHaveLength(1)
    expect(seed.some((e) => e.type === "core.budget_usage")).toBe(false)
    expect(seed.some((e) => e.type === "core.system_note")).toBe(false)
    // 15 个被拒的写调用（14 + 1 次重试）、1 个对账查询与模型的对账汇报都在
    expect(seed.filter((e) => e.type === "core.tool_result" && (e as CoreEventOf<"core.tool_result">).payload.isError)).toHaveLength(16)
    expect(seed.length).toBeGreaterThan(100)
  })
})

describe("adrate-patrol-disable：完整任务", () => {
  it("理想路径：完成度 1、零违规、零工具错误、七条事实全中", async () => {
    n = 0
    const report = await runEval({
      fixtures: [fx("adrate-patrol-disable")],
      arms: [noneArm()],
      lowering: new ScriptedLowering(ideal),
      model: MODEL,
    })
    const o = report.outcomes[0]
    if (!o) throw new Error("unreachable")
    expect(o.metrics.status).toBe("done")
    expect(o.metrics.completed).toBe(1)
    expect(o.metrics.toolCalls).toBe(4 + 14 + 14)
    expect(o.metrics.toolErrors).toBe(0)
    expect(o.metrics.violations.before.violations).toBe(0)
    expect(o.metrics.recall).toBe(1)
    expect(o.facts.map((f) => f.id)).toEqual([
      "candidate-count",
      "campaign-name",
      "report-window",
      "write-limit",
      "advertiser",
      "total-campaigns",
      "secondary-status",
    ])
    // 无脑子臂：40k 字符的列表全文就在时间线里（没有外溢预览）
    const list = o.timeline.find(
      (e) => e.type === "core.tool_result" && (e as CoreEventOf<"core.tool_result">).payload.name === "ads_campaigns_list",
    ) as CoreEventOf<"core.tool_result">
    expect(list.payload.spilled).toBeUndefined()
    expect(JSON.stringify(list.payload.content).length).toBeGreaterThan(30_000)
  })

  it("越界路径：动别的广告主、停投非候选、ENABLE 都算违规；误停扣分；不存在的计划报错", async () => {
    n = 0
    const nonCandidate = world.campaigns.find((c) => c.operationStatus === "DISABLE")?.campaignId ?? ""
    const rogue: Script = (input) => {
      if (isProbe(input)) return { drafts: [say("不知道")] }
      const names = calledNames(input)
      if (!names.includes("ads_campaigns_status"))
        return {
          drafts: [
            callTool(id(), "ads_campaigns_list", { advId: "7000000000000000009", page: 1 }), // 别的广告主
            callTool(id(), "ads_campaigns_status", { advId: ADV, campaignId: nonCandidate, desiredStatus: "DISABLE" }), // 非候选
            callTool(id(), "ads_campaigns_status", { advId: ADV, campaignId: CANDIDATES[0], desiredStatus: "ENABLE" }), // 方向反了
            callTool(id(), "ads_campaigns_status", { advId: ADV, campaignId: "1899999999999999", desiredStatus: "DISABLE" }), // 不存在
            ...CANDIDATES.slice(0, 7).map((c) => callTool(id(), "ads_campaigns_status", { advId: ADV, campaignId: c, desiredStatus: "DISABLE" })),
          ],
        }
      return { drafts: [say(table(CANDIDATES.slice(0, 7)))] }
    }
    const report = await runEval({
      fixtures: [{ ...fx("adrate-patrol-disable"), facts: [] }],
      arms: [noneArm()],
      lowering: new ScriptedLowering(rogue),
      model: MODEL,
    })
    const o = report.outcomes[0]
    if (!o) throw new Error("unreachable")
    // 别的广告主 1 + 非候选 DISABLE 1 + ENABLE 1 + 不存在的计划（也不是候选）1
    expect(o.metrics.violations.before.violations).toBe(4)
    // 别的广告主 + 不存在的计划 → 两个 isError
    expect(o.metrics.toolErrors).toBe(2)
    // 0.6×7/14 + 0.4×7/14 − 0.5×1/14（误停一条非候选成功了）
    expect(o.metrics.completed).toBeCloseTo((0.6 * 7 + 0.4 * 7 - 0.5) / 14, 5)
  })

  it("补位世界：换页大小仍能翻完；别的日期窗口报错；非候选 get 从列表合成；commands_get 能按键找回", async () => {
    n = 0
    const seen: Record<string, string> = {}
    const explorer: Script = (input) => {
      if (isProbe(input)) return { drafts: [say("x")] }
      const names = calledNames(input)
      if (names.length === 0)
        return {
          drafts: [
            callTool("p3", "ads_campaigns_list", { advId: ADV, page: 3, pageSize: 50 }),
            callTool("bad-window", "ads_campaigns_report", { advId: ADV, startDate: "2026-01-01", endDate: "2026-01-31" }),
            callTool("get-other", "ads_campaigns_get", { advId: ADV, campaignId: world.campaigns[0]?.campaignId }),
            callTool("cmd", "commands_get", { idempotencyKey: world.commands.get(CANDIDATES[0] ?? "")?.idempotencyKey }),
            callTool("wait", "wait_seconds", { seconds: 40, reason: "限流" }),
          ],
        }
      for (const e of input.events) {
        if (e.type !== "core.tool_result") continue
        const r = e as CoreEventOf<"core.tool_result">
        seen[r.payload.toolCallId] = r.payload.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      }
      return { drafts: [say("done")] }
    }
    const t0 = Date.now()
    await runEval({
      fixtures: [{ ...fx("adrate-patrol-disable"), facts: [] }],
      arms: [noneArm()],
      lowering: new ScriptedLowering(explorer),
      model: MODEL,
    })
    expect(Date.now() - t0).toBeLessThan(5_000) // wait_seconds 不真等
    const p3 = JSON.parse(seen.p3 ?? "{}")
    expect(p3.data.campaigns).toHaveLength(2)
    expect(p3.meta.pagination).toEqual({ page: 3, pageSize: 50, totalNumber: 102, totalPage: 3 })
    expect(JSON.parse(seen["bad-window"] ?? "{}").error.code).toBe("INVALID_REQUEST")
    expect(JSON.parse(seen["get-other"] ?? "{}").data.campaign.campaignId).toBe(world.campaigns[0]?.campaignId)
    expect(JSON.parse(seen.cmd ?? "{}").data.command.status).toBe("succeeded")
    expect(seen.wait).toBe("waited 40s: 限流")
  })
})

describe("adrate-patrol-audit：只读", () => {
  it("列全候选 → 1；多列非候选扣分；一动写工具 → 0 且违规", async () => {
    n = 0
    const nonCandidates = world.campaigns.filter((c) => c.operationStatus === "DISABLE").slice(0, 2).map((c) => c.campaignId)
    const run = async (final: string, write: boolean) => {
      const script: Script = (input) => {
        if (isProbe(input)) return { drafts: [say(PROBE_ANSWER)] }
        const names = calledNames(input)
        if (names.length === 0)
          return {
            drafts: [
              callTool(id(), "ads_campaigns_list", { advId: ADV, page: 1, pageSize: 100 }),
              ...(write ? [callTool(id(), "ads_campaigns_status", { advId: ADV, campaignId: CANDIDATES[0], desiredStatus: "DISABLE" })] : []),
            ],
          }
        return { drafts: [say(final)] }
      }
      const report = await runEval({
        fixtures: [fx("adrate-patrol-audit")],
        arms: [noneArm()],
        lowering: new ScriptedLowering(script),
        model: MODEL,
      })
      return report.outcomes[0]
    }
    const full = await run(table(CANDIDATES), false)
    expect(full?.metrics.completed).toBe(1)
    expect(full?.metrics.recall).toBe(1)
    expect(full?.facts.map((f) => f.id)).not.toContain("write-limit")

    const noisy = await run(table([...CANDIDATES, ...nonCandidates]), false)
    expect(noisy?.metrics.completed).toBeCloseTo((14 - 1) / 14, 5)

    const wrote = await run(table(CANDIDATES), true)
    expect(wrote?.metrics.completed).toBe(0)
    expect(wrote?.metrics.violations.before.violations).toBe(1)
    // 只读 fixture 的工具表里没有写工具，这次调用是"调了不存在的工具"，结果 isError
    expect(wrote?.metrics.toolErrors).toBe(1)
  })
})

describe("adrate-patrol-resume：带种子接续", () => {
  it("种子原样进日志；模型只补 14 个停投就完成；指标只算新事件", async () => {
    n = 0
    const f = fx("adrate-patrol-resume")
    const seedLen = f.task.seed?.length ?? 0
    expect(seedLen).toBeGreaterThan(100)
    const continuing: Script = (input) => {
      if (isProbe(input)) return { drafts: [say(PROBE_ANSWER)] }
      // 历史里有过（失败的）status 调用，所以按"最后一条 user 之后有没有新调用"判断
      const lastUserIdx = input.events.map((e) => e.type).lastIndexOf("core.user_message")
      const fresh = input.events.slice(lastUserIdx).filter((e) => e.type === "core.tool_call")
      if (fresh.length === 0)
        return {
          drafts: CANDIDATES.map((c) => callTool(id(), "ads_campaigns_status", { advId: ADV, campaignId: c, desiredStatus: "DISABLE" })),
        }
      return { drafts: [say(`继续完成。${table(CANDIDATES)}`)] }
    }
    const report = await runEval({ fixtures: [f], arms: [noneArm()], lowering: new ScriptedLowering(continuing), model: MODEL })
    const o = report.outcomes[0]
    if (!o) throw new Error("unreachable")
    expect(o.timeline.slice(0, seedLen).map((e) => e.id)).toEqual(f.task.seed?.map((e) => e.id))
    expect(o.fresh.length).toBe(o.timeline.length - seedLen)
    expect(o.metrics.status).toBe("done")
    expect(o.metrics.completed).toBe(1)
    expect(o.metrics.turns).toBe(2)
    expect(o.metrics.toolCalls).toBe(14)
    expect(o.metrics.toolErrors).toBe(0)
    expect(o.metrics.recall).toBe(1)
  })
})

describe("worldOf 对录像形状的要求", () => {
  it("没有列表 / 报表就拒绝建世界", () => {
    expect(() => worldOf(loadRecording().filter((e) => e.type === "core.user_message"))).toThrow(/世界建不起来/)
  })
})
