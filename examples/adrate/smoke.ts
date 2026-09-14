/** 不经模型直接调用生成的工具，核对子进程与信封解析：node examples/adrate/smoke.ts */
import { InMemoryEventLog } from "@reinsjs/agent"
import { advertiserId, smokeCampaignId } from "./local.ts"
import { adrateTools } from "./tools.ts"

const tools = adrateTools()
const ctx = { sessionId: "smoke", toolCallId: "toolu_smoke_01", log: new InMemoryEventLog(), emit() {} }
type R = { content: { text: string }[]; isError: boolean }
const get = tools.find((t) => t.name === "ads_campaigns_get")
if (!get?.execute) throw new Error("no tool")
const r = (await get.execute({ advId: advertiserId(), campaignId: smokeCampaignId() }, ctx as never)) as R
const env = JSON.parse(r.content[0]?.text ?? "{}")
console.log("get ok", env.ok, "isError", r.isError, "exit", env.exitCode, env.data?.campaign?.campaignName, env.data?.campaign?.operationStatus)
const bad = (await get.execute({ advId: advertiserId(), campaignId: "nope" }, ctx as never)) as R
const benv = JSON.parse(bad.content[0]?.text ?? "{}")
console.log("bad ok", benv.ok, "isError", bad.isError, "exit", benv.exitCode, "code", benv.error?.code)
const wait = tools.find((t) => t.name === "wait_seconds")
if (!wait?.execute || !wait.validate) throw new Error("no wait")
try {
  wait.validate({ seconds: 0 })
} catch (e) {
  console.log("validate rejects:", (e as Error).message)
}
console.log("wait:", await wait.execute({ seconds: 1 }, ctx as never))
