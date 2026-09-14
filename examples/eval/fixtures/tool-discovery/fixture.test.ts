import type { Event } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { ADRATE_DOMAIN, buildCatalog, cannedAdrate, WORLD } from "./catalog.ts"
import { completionOf, offDomainConstraint, TASKS, toolDiscoveryFixtures } from "./fixture.ts"

const ev = (type: string, payload: unknown, seq: number): Event =>
  ({ id: `e${seq}`, seq, at: seq, sessionId: "s", type, schemaVersion: 1, actor: "model", payload }) as Event
const call = (seq: number, name: string, args: unknown) => ev("core.tool_call", { toolCallId: `c${seq}`, name, args }, seq)

function draft(fresh: Event[], finalText: string) {
  return { fixtureId: "x", arm: "a", repeat: 1, sessionIds: ["s"], timelines: [fresh], timeline: fresh, fresh, result: { status: "done" as const, sessionId: "s", lastSeq: 1 }, finalText }
}

describe("tool-discovery 世界", () => {
  it("目录恰好 200 件、名字唯一且有序、全部 lazy、28 件 AdRate、含 metaads 陷阱、两次生成一致", () => {
    const a = buildCatalog()
    const b = buildCatalog()
    expect(a.tools.length).toBe(200)
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(200)
    expect(a.tools.map((t) => t.name)).toEqual([...a.tools.map((t) => t.name)].sort())
    expect(a.tools.every((t) => t.lazy === true)).toBe(true)
    expect(a.adrateNames.length).toBe(28)
    expect([...a.domainOf.values()].filter((d) => d === "metaads").length).toBe(10)
    expect(a.tools.map((t) => [t.name, t.description, t.inputSchema])).toEqual(b.tools.map((t) => [t.name, t.description, t.inputSchema]))
    // 每个任务的靶工具都在目录里且是 AdRate 的
    for (const task of TASKS) for (const t of task.targets) expect(a.domainOf.get(t)).toBe(ADRATE_DOMAIN)
  })

  it("假账户：广告主对不上回 NOT_FOUND；写返回终态 Command；报表零花费的正是三条", () => {
    const wrong = cannedAdrate("ads_campaigns_list", { advId: WORLD.otherAdvertiserId }) as { ok: boolean; error?: { code: string } }
    expect(wrong.ok).toBe(false)
    expect(wrong.error?.code).toBe("NOT_FOUND")
    const cmd = cannedAdrate("ads_campaigns_status", { advId: WORLD.advertiserId, campaignId: "1875000000000002", desiredStatus: "DISABLE" }) as { data: { isFinal: boolean; status: string } }
    expect(cmd.data.isFinal).toBe(true)
    expect(cmd.data.status).toBe("succeeded")
    const report = cannedAdrate("ads_campaigns_report", { advId: WORLD.advertiserId, startDate: "2026-09-07", endDate: "2026-09-13" }) as { data: { rows: { spend: string }[] } }
    expect(report.data.rows.filter((r) => r.spend === "0.00").length).toBe(3)
    // 工具的 execute 返回 JSON 字符串
    const tool = buildCatalog().tools.find((t) => t.name === "identity_get")
    expect(JSON.parse(String(tool?.execute?.({}, {} as never))).data.userId).toBe("u_1001")
  })

  it("完成度：靶工具调对 + 汇报提到事实 = 1；调错门每次扣 0.25；不调靶工具 = 0.4 × 汇报", () => {
    const catalog = buildCatalog()
    const task = TASKS.find((t) => t.id === "td-rule-disable")
    if (!task) throw new Error("no task")
    const completion = completionOf(task, catalog)
    const perfect = [call(1, "rules_list", {}), call(2, "rules_disable", { ruleId: "rule_101" })]
    expect(completion(draft(perfect, "Disabled rule_101."))).toBe(1)
    // 参数错（停了别的规则）：rules_disable 不算调对
    expect(completion(draft([call(1, "rules_list", {}), call(2, "rules_disable", { ruleId: "rule_102" })], "Disabled rule_101."))).toBeCloseTo(0.6 * 0.5 + 0.4)
    expect(completion(draft([...perfect, call(3, "metaads_campaigns_list", {})], "Disabled rule_101."))).toBeCloseTo(0.75)
    expect(completion(draft([], "I disabled rule_101."))).toBeCloseTo(0.4)
    expect(completion(draft([], "nothing"))).toBe(0)
    const c = offDomainConstraint(catalog)
    expect(c.violates(call(1, "crm_contacts_list", {}) as never, { timeline: [] })).toBe(true)
    expect(c.violates(call(1, "tool_find", {}) as never, { timeline: [] })).toBe(false)
    expect(c.violates(call(1, "rules_list", {}) as never, { timeline: [] })).toBe(false)
  })

  it("六个 fixture 装配：每个 200 件工具、一条约束、maxTurns 10", () => {
    const suite = toolDiscoveryFixtures()
    expect(suite.fixtures.length).toBe(6)
    for (const f of suite.fixtures) {
      expect(f.tools.length).toBe(200)
      expect(f.constraints?.length).toBe(1)
      expect(f.maxTurns).toBe(10)
      expect(f.task.systemPrompt).toContain("AdRate")
    }
  })
})
