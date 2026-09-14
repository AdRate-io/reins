/** 写路径冒烟（只对测试广告主）：对一条已经 DISABLE 的计划再发一次 DISABLE，核对 --set 小写映射与幂等键透传。node examples/adrate/smoke-write.ts */
import { InMemoryEventLog } from "reins"
import { advertiserId, smokeCampaignId } from "./local.ts"
import { adrateTools } from "./tools.ts"

const tool = adrateTools().find((t) => t.name === "ads_campaigns_status")
if (!tool?.execute) throw new Error("no tool")
const ctx = { sessionId: "smoke", toolCallId: `smoke_${Date.now()}`, log: new InMemoryEventLog(), emit() {} }
const r = (await tool.execute(
  { advId: advertiserId(), campaignId: smokeCampaignId(), desiredStatus: "DISABLE" },
  ctx as never,
)) as { content: { text: string }[]; isError: boolean }
const env = JSON.parse(r.content[0]?.text ?? "{}")
console.log("ok", env.ok, "exit", env.exitCode, "key", env.idempotencyKey, "command", env.data?.command?.status, env.data?.command?.isFinal, env.error?.code, env.error?.message)
