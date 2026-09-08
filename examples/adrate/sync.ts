/**
 * 从 AdRate 服务端拉最新的能力清单与每个能力的操作 schema，存成 capabilities.json。
 * 工具定义（tools.ts）从这个文件生成，而不是手抄 CLI 帮助 —— 服务端改了参数，重跑一次就同步。
 *
 *   node examples/adrate/sync.ts
 */
import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { promisify } from "node:util"

const run = promisify(execFile)
const env = { ...process.env, ADRATE_NO_SKILLS_NOTIFIER: "1" }

async function adrate<T>(args: string[]): Promise<T> {
  const { stdout } = await run("adrate", [...args, "--json", "--no-input"], { env })
  const envelope = JSON.parse(stdout) as { ok: boolean; data: T; error?: { code: string; message: string } }
  if (!envelope.ok) throw new Error(`${args.join(" ")} 失败：${envelope.error?.code} ${envelope.error?.message}`)
  return envelope.data
}

const status = await adrate<{ issuerOrigin: string | null; status: string }>(["auth", "status"])
if (status.status !== "active") throw new Error(`CLI 未登录（${status.status}），先 adrate auth login`)
const list = await adrate<{ capabilityId: string }[] | { capabilities?: { capabilityId: string }[]; items?: { capabilityId: string }[] }>([
  "capabilities",
])
const ids = (Array.isArray(list) ? list : (list.capabilities ?? list.items ?? [])).map((c) => c.capabilityId)
const capabilities = []
for (const id of ids) capabilities.push(await adrate(["schema", id]))
const { stdout: version } = await run("adrate", ["--version"])
const out = new URL("./capabilities.json", import.meta.url)
await writeFile(
  out,
  `${JSON.stringify(
    { fetchedAt: new Date().toISOString().slice(0, 10), issuer: status.issuerOrigin, cliVersion: version.trim(), capabilities },
    null,
    2,
  )}\n`,
)
console.log(`✓ ${capabilities.length} 个能力 → ${out.pathname}`)
