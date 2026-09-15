/**
 * 补充探针：defer_loading 的计费核实（2026-09-15，Boss 问"取回之前被延迟的定义按多少 token 扣"）。
 *
 * 官方文档："Internally, the API excludes deferred tools from the system-prompt prefix"；取回展开后
 * "count as input tokens like any other tool definition"。取回后那段 spike 已实证；本探针补取回之前：
 *
 * 三臂同基座 system（各自等长盐值，防 5 分钟 TTL 内互读对方缓存）、同 messages、Haiku 4.5 各一次调用：
 *   A 原样：tool_find + 三件 defer_loading 菜单工具（p2-req1 形态）
 *   B 去标：同样四件工具，去掉 defer_loading
 *   C 删件：只留 tool_find，三件菜单工具整个删掉
 * 判读：A≈C 且 B-A≈deferred 定义量 → 排除成立（取回之前 deferred 定义不进前缀、不计费）；
 *       A≈B → 不排除（请求里发了就计费）。判据全部是 usage 数字，不看状态码。
 *
 * 运行：`node spikes/l1-deferred-tools/billing-deferred.mjs`
 */
import { readFile, writeFile } from "node:fs/promises"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const cfToken = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
const cfAccount = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
const cfGateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
if (!cfToken || !cfAccount) throw new Error("信息文件里缺 CF 令牌 / account id")

const base = JSON.parse(await readFile(new URL("./out/haiku-p2-req1.json", import.meta.url), "utf8"))
const original = base.body

// 三臂：基座复用 p2-req1 的 system，盐值追加在末尾、各臂不同但等长（token 数一致）
const salts = { A_deferred: "salt-billing-A", B_no_flag: "salt-billing-B", C_removed: "salt-billing-C" }
const armB = structuredClone(original)
for (const t of armB.tools) delete t.defer_loading
const armC = structuredClone(original)
armC.tools = armC.tools.filter((t) => t.defer_loading !== true)
for (const t of armC.tools) delete t.defer_loading
const arms = { A_deferred: original, B_no_flag: armB, C_removed: armC }
// 原始 body 的 model 与 max_tokens 换成最省的形态：只看 usage，不要输出内容
for (const body of Object.values(arms)) {
  body.model = process.env.L1_HAIKU_MODEL ?? "claude-haiku-4-5-20251001"
  body.max_tokens = 16
  delete body.temperature
}

const url = `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/anthropic/v1/messages`
const headers = { "content-type": "application/json", "cf-aig-authorization": `Bearer ${cfToken}`, "anthropic-version": "2023-06-01" }

async function call(body, salt) {
  body.system = [...body.system, { type: "text", text: `${salt}.` }]
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
    const text = await res.text()
    if ((res.status === 429 && /Rate limited/i.test(text)) || res.status === 529) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 4000 * attempt
      console.log(`  (第 ${attempt} 次 ${status}，${wait}ms 后重试)`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: res.status, json, text }
  }
  throw new Error("重试耗尽")
}

const out = { basis: "三臂同基座 system（p2-req1）+ 等长盐值；判据 cache_creation 差值" }
for (const [label, body] of Object.entries(arms)) {
  const r = await call(body, salts[label])
  const u = r.json?.usage ?? {}
  out[label] = {
    status: r.status,
    n_tools: body.tools.length,
    input: u.input_tokens,
    cache_creation: u.cache_creation_input_tokens,
    cache_read: u.cache_read_input_tokens,
    billed_total: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    error: r.status !== 200 ? r.text.slice(0, 200) : undefined,
  }
  console.log(`${label}: status=${r.status} tools=${body.tools.length} input=${u.input_tokens} write=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens}`)
}
await writeFile(new URL("./out/billing-deferred.json", import.meta.url), JSON.stringify(out, null, 1))
console.log("结果已写 out/billing-deferred.json")