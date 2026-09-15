/**
 * P9 补充探针：defer_loading 的定义在取回之前是否计费（2026-09-15 首测，2026-09-15 重做）。
 *
 * 官方文档只有方向性表述："Internally, the API excludes deferred tools from the system-prompt prefix"。
 * 本探针用真模型的缓存用量把它量出来。取回之后的计费由 probe.mjs 的 P2 覆盖，这里只管取回之前。
 *
 * ## 实验设计
 *
 * 基座复用 probe.mjs 写下的 `out/haiku-p2-req1.json`（tool_find[断点] + 三件 defer_loading 菜单工具；
 * 长 system 一块[断点]；一条 user[断点]）。三个断点的位置不动，只换 tools 数组与 system 里的 run 盐。
 *
 * 盐的放法是这次的关键修正：首测把盐追加成 system 的**新块**，落在断点之后，既不进缓存前缀也就起不到
 * 隔离作用。这里改成替换 system 第 0 块（断点块）文本里的 `run-xxxx`，盐真正进前缀：
 *   - 同一组内各臂**共用**同一个盐 → 臂与臂之间仍可互相命中，命中与否才是判据；
 *   - 每次运行换新盐 → 与上一次运行、与 probe.mjs 留下的前缀完全隔离（Anthropic 缓存 5 分钟 TTL 且命中续期）。
 *
 * 第一组（盐 S1，顺序执行）：
 *   A_deferred  原样：tool_find + 三件 defer_loading
 *   C_removed   删件：只留 tool_find，三件整个不发
 *   D_altered   换料：三件仍 defer_loading，但 description 各换成明显不同且更长的文本（system 菜单不动）
 *   B_no_flag   去标：同样四件，去掉 defer_loading（三件变成实发）
 * 第二组（盐 S2，把第一组的顺序反过来，验证命中不是单向巧合）：
 *   C2_first    只留 tool_find 先跑
 *   A2_second   原样后跑
 *
 * ## 判读（全部看 usage 数字，不看状态码）
 *   自检 A_deferred / C2_first 必须 read = 0（本组首请求），否则说明盐没隔住，本次数据作废；
 *   ①  C_removed 命中 A_deferred 写的前缀        → 带三件 deferred 与完全没有这三件，计费前缀逐字相同；
 *   ②  D_altered 命中量与 C_removed 相同          → 连定义内容都不进前缀（否则换料必然改变前缀）；
 *   ③  B_no_flag 不命中，且写入量比 A 多 Δ        → 同样三件一旦实发就进前缀，Δ 即三件定义的 token；
 *   ④  A2_second 命中 C2_first 写的前缀           → 方向反过来同样成立。
 *
 * 运行：`node spikes/l1-deferred-tools/billing-deferred.mjs`
 * 前置：先跑过 `node spikes/l1-deferred-tools/probe.mjs haiku`（基座取自它写的 out/haiku-p2-req1.json，out/ 不入库）。
 */
import { readFile, writeFile } from "node:fs/promises"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const cfToken = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
const cfAccount = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
const cfGateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
if (!cfToken || !cfAccount) throw new Error("信息文件里缺 CF 令牌 / account id")

const baseUrl = new URL("./out/haiku-p2-req1.json", import.meta.url)
const base = await readFile(baseUrl, "utf8").catch(() => {
  throw new Error("缺 out/haiku-p2-req1.json：先跑 `node spikes/l1-deferred-tools/probe.mjs haiku`")
})
const original = JSON.parse(base).body

/** 三件换料后的描述：与原文完全不同且更长，用来检验定义内容是否进前缀 */
const ALTERED = {
  get_weather:
    "Retrieve a detailed meteorological report for the requested place, including temperature, wind and precipitation outlook for the next several hours.",
  search_files:
    "Run a keyword query across every indexed document in the current workspace and return the matching paths together with a short excerpt of each hit.",
  check_stock:
    "Look up how many units of a given article are currently held in the warehouse and report the figure together with the last inventory timestamp.",
}

/** 造一臂：换 run 盐（在 system 第 0 块 = 断点内），按 shape 改 tools */
function arm(salt, shape) {
  const body = structuredClone(original)
  body.system[0].text = body.system[0].text.replace(/run-[a-z0-9]+/, salt)
  if (shape === "removed") body.tools = body.tools.filter((t) => t.defer_loading !== true)
  if (shape === "no_flag") for (const t of body.tools) delete t.defer_loading
  if (shape === "altered") for (const t of body.tools) if (t.defer_loading) t.description = ALTERED[t.name]
  body.model = process.env.L1_HAIKU_MODEL ?? "claude-haiku-4-5-20251001"
  body.max_tokens = 16 // 只看 input 侧用量，输出截断无所谓
  return body
}

const url = `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/anthropic/v1/messages`
const headers = {
  "content-type": "application/json",
  "cf-aig-authorization": `Bearer ${cfToken}`,
  "anthropic-version": "2023-06-01",
}

async function call(body) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
    const text = await res.text()
    if ((res.status === 429 && /Rate limited/i.test(text)) || res.status === 529) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 4000 * attempt
      console.log(`  （第 ${attempt} 次 ${res.status}，${wait}ms 后重试）`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, json, text }
  }
  throw new Error("重试耗尽")
}

const salt1 = `run-${Date.now().toString(36)}a`
const salt2 = `run-${Date.now().toString(36)}b`
const plan = [
  ["A_deferred", salt1, "original", "原样：tool_find + 三件 defer_loading"],
  ["C_removed", salt1, "removed", "删件：只留 tool_find"],
  ["D_altered", salt1, "altered", "换料：三件仍 deferred，描述换成不同且更长的文本"],
  ["B_no_flag", salt1, "no_flag", "去标：四件全实发"],
  ["C2_first", salt2, "removed", "第二组先手：只留 tool_find"],
  ["A2_second", salt2, "original", "第二组后手：原样带三件 deferred"],
]

const results = {}
for (const [label, salt, shape, note] of plan) {
  const body = arm(salt, shape)
  const r = await call(body)
  const u = r.json?.usage ?? {}
  results[label] = {
    note,
    salt,
    status: r.status,
    n_tools: body.tools.length,
    input: u.input_tokens,
    write: u.cache_creation_input_tokens,
    read: u.cache_read_input_tokens,
    billed_total:
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    error: r.status !== 200 ? r.text.slice(0, 300) : undefined,
  }
  console.log(
    `${label.padEnd(11)} status=${r.status} tools=${body.tools.length} input=${u.input_tokens} write=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens}`,
  )
  await new Promise((r) => setTimeout(r, 1500)) // 让上一臂的缓存写入稳定生效
}

// ---- 判读：先自检，再逐条 ----
const g = (k) => results[k]
const bad = Object.entries(results).filter(([, v]) => v.status !== 200)
const checks = []
const say = (ok, name, detail) => checks.push({ ok, name, detail })

if (bad.length) {
  say(false, "自检 全部 200", `非 200：${bad.map(([k, v]) => `${k}=${v.status}`).join(", ")}`)
} else {
  say(g("A_deferred").read === 0, "自检 A 是本组首请求（read=0）", `A.read=${g("A_deferred").read}`)
  say(g("C2_first").read === 0, "自检 C2 是本组首请求（read=0）", `C2.read=${g("C2_first").read}`)
  say(
    g("C_removed").read > 0,
    "① 删件臂命中带标臂写的前缀",
    `C.read=${g("C_removed").read}，A.write=${g("A_deferred").write}，C.read+C.write=${g("C_removed").read + g("C_removed").write}`,
  )
  say(
    g("D_altered").read === g("C_removed").read,
    "② 换料臂命中量与删件臂相同（定义内容不进前缀）",
    `D.read=${g("D_altered").read} vs C.read=${g("C_removed").read}`,
  )
  say(
    g("B_no_flag").read === 0 && g("B_no_flag").write > g("A_deferred").write,
    "③ 去标臂不命中且写入更多（实发即进前缀）",
    `B.read=${g("B_no_flag").read}，B.write-A.write=${g("B_no_flag").write - g("A_deferred").write}`,
  )
  say(
    g("A2_second").read > 0,
    "④ 反序同样成立（带标臂命中删件臂写的前缀）",
    `A2.read=${g("A2_second").read}，C2.write=${g("C2_first").write}`,
  )
}

console.log("\n判读：")
for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} —— ${c.detail}`)
const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} 通过`)

await writeFile(
  new URL("./out/billing-deferred.json", import.meta.url),
  JSON.stringify(
    {
      basis: "同组共用一次性 run 盐（进 system 断点内）；判据 cache_read 命中与 cache_creation 差值",
      results,
      checks,
    },
    null,
    1,
  ),
)
console.log("结果已写 out/billing-deferred.json")
