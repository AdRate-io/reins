/**
 * 把 vercel-probe/ 部署到 Boss 账号下的 Vercel 项目（生产部署，Hobby 档生产域名缺省公开），凭证经 -e 注入。
 * 先 node build-vercel.mjs 生成 bundle.js。跑完打印生产 URL，探测由 probe-vercel.mjs 做。
 */
import { spawnSync } from "node:child_process"
import { probeEnv } from "../edge-runtime-check/secrets.mjs"

const env = await probeEnv({ fakeBase: "", mcpBase: "", live: true })
delete env.FAKE_BASE
delete env.MCP_BASE
if (process.env.REINS_OAI_MODEL) env.OAI_MODEL = process.env.REINS_OAI_MODEL
const args = ["deploy", "--prod", "--yes", "--name", "reins-runtime-probe"]
for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`)
const r = spawnSync(new URL("./node_modules/.bin/vercel", import.meta.url).pathname, args, {
  cwd: new URL("./vercel-probe/", import.meta.url).pathname,
  encoding: "utf8",
})
// 输出里不含凭证（vercel 只回显 URL 与进度）
process.stdout.write(r.stdout)
process.stderr.write(r.stderr)
process.exit(r.status ?? 1)
