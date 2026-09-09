/**
 * 编排器：起假端点 → 起 wrangler dev（严格档，不开 nodejs_compat）→ 依次探 /load、/fake
 * → 严格档若失败，换 compat 档重探 → 可选 --live 打真 DeepSeek。
 *
 * 运行（仓库根先 pnpm build）：
 *   node spikes/edge-runtime-check/run.mjs            # 只跑零成本的前两层
 *   node spikes/edge-runtime-check/run.mjs --live      # 追加真 API 一次
 *
 * 密钥自动从《模型API测试信息.md》读（沿用 b2-compact-live 的做法），
 * 经 .dev.vars 交给 wrangler，**跑完立即删除**；该文件也已写进 .gitignore。
 */
import { spawn } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"

const HERE = new URL("./", import.meta.url)
const live = process.argv.includes("--live")
const FAKE_PORT = 8790
const WORKER_PORT = 8791

/** 从信息文件取 DeepSeek 官方 Anthropic 端口的 key 与 baseUrl。选它是因为直连 https、已实测五项全 200，
 *  不经 aireiter（网关会改写请求、吞消息）也不经 Claude 中转（那个是 http 明文，会污染运行时结论）。 */
async function readDeepSeek() {
  const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
  const key = info.match(/deepseek官方[\s\S]*?key:\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
  // 注意：信息文件第 135 行有一句**说明文字**也含"anthropic 协议 baseurl："字样，后面紧跟反引号，
  // 只用 \S+ 会先撞上它抓到一个反引号（实测 Invalid URL string.）。所以锚定必须以 http(s):// 开头。
  const base = info.match(/anthropic 协议 baseurl：\s*(https?:\/\/\S+)/)?.[1]
  const model = info.match(/deepseek官方[\s\S]*?模型：\s*(\S+)/)?.[1]
  if (!key || !base) throw new Error("没在信息文件里找到 DeepSeek 的 key 或 baseUrl")
  return { key, base, model }
}

/** aireiter 聚合网关的 key：OpenAI Responses 协议侧用它（DeepSeek 的 responses 端口未经 reins 核实）。
 *  网关对 Claude 那条路有改写请求、吞消息的问题，但这里只验运行时能否跑通 openai SDK，与语义无关。 */
async function readGateway() {
  const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
  const key = info.match(/密钥（三种协议共用）：`(sk-[^`]+)`/)?.[1]
  if (!key) throw new Error("没在信息文件里找到网关密钥")
  return { key, base: "https://aireiter.com/api/v1", model: "gpt-5.5" }
}

function sh(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: new URL(".", HERE).pathname, ...opts })
  let out = ""
  let err = ""
  p.stdout?.on("data", (c) => (out += c))
  p.stderr?.on("data", (c) => (err += c))
  return {
    p,
    get out() {
      return out
    },
    get err() {
      return err
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到端口回应或超时。wrangler 首次会下载 workerd，所以给到 180 秒。 */
async function waitReady(url, timeoutMs, proc, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return true
    } catch {}
    if (proc?.p.exitCode !== null && proc?.p.exitCode !== undefined) {
      throw new Error(
        `${label} 提前退出（码 ${proc.p.exitCode}）\n--- stdout ---\n${proc.out}\n--- stderr ---\n${proc.err}`,
      )
    }
    await sleep(700)
  }
  throw new Error(`${label} 等待超时\n--- stdout ---\n${proc?.out}\n--- stderr ---\n${proc?.err}`)
}

async function probe(path) {
  const r = await fetch(`http://127.0.0.1:${WORKER_PORT}${path}`, { signal: AbortSignal.timeout(60_000) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** 跑一档 wrangler 配置，返回该档下 /load 与 /fake 的结果。 */
async function runArch(configFile, label, vars) {
  console.log(`\n${"=".repeat(70)}\n【${label}】config=${configFile}\n${"=".repeat(70)}`)
  const dev取值 = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
  await writeFile(new URL("./.dev.vars", HERE), `${dev取值}\n`)
  const w = sh(
    "npx",
    [
      "--yes",
      "wrangler@4",
      "dev",
      "--config",
      configFile,
      "--port",
      String(WORKER_PORT),
      "--ip",
      "127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    },
  )
  const result = { label, load: null, fake: null, live: null, liveOpenai: null, 启动失败: null }
  try {
    await waitReady(`http://127.0.0.1:${WORKER_PORT}/`, 180_000, w, `wrangler dev(${label})`)
    console.log("worker 就绪，开始探测")
    result.load = await probe("/load")
    console.log(`  /load  → HTTP ${result.load.status}`)
    if (result.load.status === 200) {
      result.fake = await probe("/fake")
      console.log(`  /fake  → HTTP ${result.fake.status}`)
      if (live && result.fake.status === 200) {
        result.live = await probe("/live")
        console.log(`  /live         → HTTP ${result.live.status}`)
        result.liveOpenai = await probe("/live-openai")
        console.log(`  /live-openai  → HTTP ${result.liveOpenai.status}`)
      }
    }
  } catch (e) {
    result.启动失败 = String(e.message)
    console.log(`  !! ${e.message.slice(0, 3000)}`)
  } finally {
    w.p.kill("SIGTERM")
    await sleep(1200)
    w.p.kill("SIGKILL")
    await rm(new URL("./.dev.vars", HERE), { force: true })
  }
  return result
}

// ---- 主流程 ----
const ds = live ? await readDeepSeek() : null
const gw = live ? await readGateway() : null
if (live)
  console.log(
    `真 API 档位：Anthropic 协议 → DeepSeek ${ds.base}（${ds.model ?? "deepseek-v4-flash"}）；OpenAI Responses 协议 → ${gw.base}（${gw.model}）。两个 key 已读入，不回显`,
  )

console.log("起本地假 Anthropic 端点…")
const fake = sh("node", ["fake-upstream.mjs"], { env: { ...process.env, FAKE_PORT: String(FAKE_PORT) } })
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("假端点启动超时")), 10_000)
  const iv = setInterval(() => {
    if (fake.out.includes("FAKE_READY")) {
      clearInterval(iv)
      clearTimeout(t)
      res()
    }
  }, 100)
})
console.log(`  假端点就绪 http://127.0.0.1:${FAKE_PORT}`)

const vars = {
  FAKE_BASE: `http://127.0.0.1:${FAKE_PORT}`,
  ...(live
    ? {
        LIVE_KEY: ds.key,
        LIVE_BASE: ds.base,
        LIVE_MODEL: ds.model ?? "deepseek-v4-flash",
        OAI_KEY: gw.key,
        OAI_BASE: gw.base,
        OAI_MODEL: gw.model,
      }
    : {}),
}

// 三档全跑（不因前一档通过就跳过）：我们要的是"从最严到最宽，边界在哪"的完整画像，
// 而不是一个"能跑"的二值结论。最严档退回 2023 compat date，剥掉 Workers 后来默认给的 Node 内建。
const old = await runArch("wrangler-old.toml", "最严档：2023 compat date，无 nodejs_compat", vars)
const strict = await runArch("wrangler.toml", "严格档：2026 compat date，无 nodejs_compat", vars)
const compat = await runArch("wrangler-compat.toml", "宽松档：nodejs_compat 开", vars)

fake.p.kill("SIGTERM")

// ---- 结论 ----
const verdict = (r) => {
  if (!r) return "未跑"
  if (r.启动失败) return `启动/等待失败`
  const s = (x) => (x === null ? "跳过" : x.status === 200 ? "通过" : `HTTP ${x.status}`)
  return `load=${s(r.load)} fake=${s(r.fake)} live-anthropic=${s(r.live)} live-openai=${s(r.liveOpenai)}`
}
console.log(`\n${"#".repeat(70)}\n# 结论\n${"#".repeat(70)}`)
console.log(`最严档 2023，无 compat  : ${verdict(old)}`)
console.log(`严格档 2026，无 compat  : ${verdict(strict)}`)
console.log(`宽松档 nodejs_compat 开 : ${verdict(compat)}`)
for (const [名, r] of [
  ["最严档", old],
  ["严格档", strict],
  ["宽松档", compat],
]) {
  const 自述 = r?.load?.body?.运行时自述
  if (自述)
    console.log(
      `  ${名}运行时面: process=${自述.process} Buffer=${自述.Buffer} node:fs=${JSON.stringify(自述.能否import_node_fs)} node:crypto=${JSON.stringify(自述.能否import_node_crypto)}`,
    )
}
console.log(`\n完整结果落盘：out.json`)
await writeFile(
  new URL("./out.json", HERE),
  JSON.stringify(
    { 跑于: new Date().toISOString(), 打了真API: live, 最严档: old, 严格档: strict, 宽松档: compat },
    null,
    2,
  ),
)

// 失败细节直接打出来，省得再翻文件
for (const r of [old, strict, compat]) {
  if (!r) continue
  for (const [k, v] of Object.entries({
    load: r.load,
    fake: r.fake,
    live: r.live,
    liveOpenai: r.liveOpenai,
  })) {
    if (v && v.status !== 200)
      console.log(`\n【${r.label} ${k} 失败详情】\n${JSON.stringify(v.body, null, 2).slice(0, 2500)}`)
  }
}
