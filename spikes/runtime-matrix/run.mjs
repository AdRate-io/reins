/**
 * 四环境验证编排器：Bun / Deno / Vercel Edge（edge-runtime）各托管一遍 edge-runtime-check 的同一个 fetch 探针，
 * 打各包 **dist**，探同一组路由，用同一份内容核对（fetch-verdict.mjs）给结论——与 workerd 那份结论可比。
 *
 * 运行（仓库根先 pnpm build；本目录先 pnpm i --ignore-workspace 装三个运行时）：
 *   NO_PROXY=127.0.0.1,localhost node spikes/runtime-matrix/run.mjs             # 不出外网
 *   NO_PROXY=127.0.0.1,localhost node spikes/runtime-matrix/run.mjs --live      # 追加五格真模型
 *   node spikes/runtime-matrix/run.mjs --only bun,edge                          # 只跑某几个宿主
 *
 * 六个臂：
 *   node       Node 22 对照臂（node:http 手工翻译），矩阵的基准线
 *   bun        Bun.serve 直接 import dist（Bun 自己的解析器 + node_modules）
 *   deno-min   Deno.serve，只给 --allow-net --allow-env（最小权限，量"谁在偷读系统信息"）
 *   deno-sys   在 deno-min 基础上加 --allow-sys=osRelease（pi-ai 的 UA 读 os.release()，见 README）
 *   edge       esbuild 打成单个 IIFE 塞进 edge-runtime 的裸 vm（Vercel 官方本地 Edge 运行时，禁 eval、无 node:*、无 process）
 *   edge-process  同上，但往 vm 里放一个只有 env 的 process（Vercel 文档对线上 Edge 承诺的最小面）
 *
 * 密钥自动从《模型API测试信息.md》读，只经子进程环境变量传递，不落盘。
 */
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { FETCH_CELLS, fetchChecksOf, PI_CELLS, piChecksOf } from "../edge-runtime-check/fetch-verdict.mjs"
import { probeEnv } from "../edge-runtime-check/secrets.mjs"

const HERE = new URL("./", import.meta.url)
const SIBLING = new URL("../edge-runtime-check/", import.meta.url)
const live = process.argv.includes("--live")
const onlyArg = process.argv[process.argv.indexOf("--only") + 1]
const only = process.argv.includes("--only") ? new Set(onlyArg.split(",")) : null

const FAKE_PORT = 8790
const MCP_PORT = 8792
const HOST_PORT = 8801
const BIN = (name) => new URL(`./node_modules/.bin/${name}`, HERE).pathname

const noProxy = { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }

function sh(cmd, args, opts = {}) {
  // detached：让子进程自成进程组。.bin/bun、.bin/deno 是 npm 包的包装脚本，只杀包装会留下真二进制继续占端口
  const p = spawn(cmd, args, { cwd: HERE.pathname, detached: true, ...opts })
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

/** 按进程组 kill（负 pid），包装脚本与它拉起的真二进制一起收掉 */
function killTree(proc, signal) {
  try {
    process.kill(-proc.p.pid, signal)
  } catch {}
  try {
    proc.p.kill(signal)
  } catch {}
}

/** 等宿主端口真正释放再起下一臂，否则下一臂必撞 EADDRINUSE */
async function waitPortFree(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    } catch {
      return
    }
    await sleep(200)
  }
  throw new Error(`端口 ${port} ${timeoutMs}ms 内未释放`)
}

/** 等子进程 stdout 出现标记；子进程先退出或超时都算失败并带出两路输出 */
const waitFor = (proc, marker, label, timeoutMs = 60_000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => {
      clearInterval(iv)
      rej(new Error(`${label} 启动超时\n--- stdout ---\n${proc.out}\n--- stderr ---\n${proc.err}`))
    }, timeoutMs)
    const iv = setInterval(() => {
      if (proc.out.includes(marker)) {
        clearInterval(iv)
        clearTimeout(t)
        res()
      } else if (proc.p.exitCode !== null) {
        clearInterval(iv)
        clearTimeout(t)
        rej(
          new Error(
            `${label} 提前退出（码 ${proc.p.exitCode}）\n--- stdout ---\n${proc.out}\n--- stderr ---\n${proc.err}`,
          ),
        )
      }
    }, 100)
  })

async function probe(path) {
  const r = await fetch(`http://127.0.0.1:${HOST_PORT}${path}`, { signal: AbortSignal.timeout(90_000) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** 四个臂的启动配方。env 里已含假端点地址与（--live 时）真模型凭证。 */
const ARMS = {
  node: (env) => ({
    label: `Node ${process.version} 对照臂（node:http 手工翻译）`,
    proc: sh("node", ["host-node.mjs"], {
      env: { ...process.env, ...noProxy, ...env, PORT: String(HOST_PORT) },
    }),
  }),
  bun: (env) => ({
    label: "Bun 1.4.2（Bun.serve，直接 import dist）",
    proc: sh(BIN("bun"), ["host-bun.mjs"], {
      env: { ...process.env, ...noProxy, ...env, PORT: String(HOST_PORT) },
    }),
  }),
  "deno-min": (env) => ({
    label: "Deno 2.9.6 最小权限（--allow-net --allow-env）",
    proc: sh(BIN("deno"), ["run", "--allow-net", "--allow-env", "host-deno.mjs"], {
      env: { ...process.env, ...noProxy, ...env, PORT: String(HOST_PORT) },
    }),
  }),
  "deno-sys": (env) => ({
    label: "Deno 2.9.6 加 --allow-sys=osRelease",
    proc: sh(BIN("deno"), ["run", "--allow-net", "--allow-env", "--allow-sys=osRelease", "host-deno.mjs"], {
      env: { ...process.env, ...noProxy, ...env, PORT: String(HOST_PORT) },
    }),
  }),
  edge: (env) => ({
    label: "Vercel Edge（edge-runtime 4.0.1 裸 vm，esbuild 单文件 IIFE）",
    proc: sh("node", ["host-edge.mjs"], {
      env: { ...process.env, ...noProxy, PORT: String(HOST_PORT), REINS_ENV_JSON: JSON.stringify(env) },
    }),
  }),
  "edge-process": (env) => ({
    label: "Vercel Edge + 只有 env 的 process 垫片（Vercel 文档承诺的最小面）",
    proc: sh("node", ["host-edge.mjs"], {
      env: {
        ...process.env,
        ...noProxy,
        PORT: String(HOST_PORT),
        REINS_ENV_JSON: JSON.stringify(env),
        REINS_EDGE_PROCESS_SHIM: "1",
      },
    }),
  }),
}

async function runArm(name, env) {
  const { label, proc } = ARMS[name](env)
  console.log(`\n${"=".repeat(70)}\n【${name}】${label}\n${"=".repeat(70)}`)
  const result = {
    name,
    label,
    load: null,
    mcp: null,
    fake: null,
    live: null,
    liveOpenai: null,
    fetchLoad: null,
    fetchFake: null,
    fetchLiveChat: null,
    fetchLiveAnthropic: null,
    fetchLiveResponses: null,
    宿主自报: null,
    启动失败: null,
  }
  try {
    await waitFor(proc, "HOST_READY", name)
    result.宿主自报 = proc.out
      .split("\n")
      .filter((l) => l.includes("HOST_READY") || l.includes("bundle-warning"))
      .join("\n")
    console.log(`  ${result.宿主自报.replace(/\n/g, "\n  ")}`)
    const step = async (key, path) => {
      result[key] = await probe(path)
      console.log(`  ${path.padEnd(24)} → HTTP ${result[key].status}`)
    }
    // pi 版：加载 → MCP → 假端点 → （--live）两条协议真往返
    await step("load", "/load")
    await step("mcp", "/mcp")
    await step("fake", "/fake")
    if (live) {
      await step("live", "/live")
      await step("liveOpenai", "/live-openai")
    }
    // fetch 版：与 pi 版互不依赖
    await step("fetchLoad", "/fetch-load")
    await step("fetchFake", "/fetch-fake")
    if (live) {
      await step("fetchLiveChat", "/fetch-live-chat")
      await step("fetchLiveAnthropic", "/fetch-live-anthropic")
      await step("fetchLiveResponses", "/fetch-live-responses")
    }
  } catch (e) {
    // 探测中途失败多半是宿主进程崩了：把它的退出码与两路输出尾巴一起带出来，别只剩一句 "fetch failed"
    const tail = (t) => t.split("\n").slice(-25).join("\n")
    result.启动失败 = `${e.message}\n宿主退出码=${proc.p.exitCode}\n--- stdout 尾 ---\n${tail(proc.out)}\n--- stderr 尾 ---\n${tail(proc.err)}`
    console.log(`  !! ${result.启动失败.slice(0, 4000)}`)
  } finally {
    killTree(proc, "SIGTERM")
    await sleep(500)
    killTree(proc, "SIGKILL")
    await waitPortFree(HOST_PORT)
  }
  return result
}

// ---- 主流程 ----
console.log("起本地假 Anthropic 端点与假 MCP 服务器（都跑在 Node 里，与被测宿主无关）…")
const fake = sh("node", ["fake-upstream.mjs"], {
  cwd: SIBLING.pathname,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT) },
})
await waitFor(fake, "FAKE_READY", "假端点", 15_000)
const mcp = sh("node", ["fake-mcp.mjs"], {
  cwd: SIBLING.pathname,
  env: { ...process.env, MCP_PORT: String(MCP_PORT) },
})
await waitFor(mcp, "MCP_READY", "假 MCP", 15_000)
console.log(`  假端点 http://127.0.0.1:${FAKE_PORT}，假 MCP http://127.0.0.1:${MCP_PORT}/mcp`)

const env = await probeEnv({
  fakeBase: `http://127.0.0.1:${FAKE_PORT}`,
  mcpBase: `http://127.0.0.1:${MCP_PORT}`,
  live,
})
// pi 版 OpenAI Responses 只有 aireiter 这一个 Responses 端点；它的 gpt-5.5 过载时可用 REINS_OAI_MODEL 换一个模型（同网关）
if (live && process.env.REINS_OAI_MODEL) env.OAI_MODEL = process.env.REINS_OAI_MODEL
if (live)
  console.log(
    "真模型档位：pi 版 → DeepSeek Anthropic 端口 + aireiter gpt-5.5；fetch 版 → DeepSeek 直连 + CF 网关 Haiku 4.5 / gpt-5-mini（凭证不回显）",
  )

const results = []
for (const name of Object.keys(ARMS)) {
  if (only && !only.has(name)) continue
  results.push(await runArm(name, env))
}
killTree(fake, "SIGTERM")
killTree(mcp, "SIGTERM")

// ---- 结论：每格都是内容核对，不是状态码 ----
const mark = (c) => (c.通过 === null ? "跳过" : c.通过 ? "通过" : "✗")
console.log(`\n${"#".repeat(70)}\n# 结论（每格 = 内容核对）\n${"#".repeat(70)}`)
for (const r of results) {
  console.log(`\n【${r.name}】${r.label}`)
  if (r.启动失败) {
    console.log("  启动/等待失败")
    continue
  }
  const pi = piChecksOf(r)
  const fe = fetchChecksOf(r)
  console.log(`  lowering-pi    : ${PI_CELLS.map(([k]) => `${k}=${mark(pi[k])}`).join("  ")}`)
  console.log(`  lowering-fetch : ${FETCH_CELLS.map(([k]) => `${k}=${mark(fe[k])}`).join("  ")}`)
  for (const [k, c] of [
    ...Object.entries(pi).map(([k, c]) => [`pi/${k}`, c]),
    ...Object.entries(fe).map(([k, c]) => [`fetch/${k}`, c]),
  ])
    if (c.通过 === false) console.log(`      ✗ ${k}: ${c.说明}`)
  const 自述 = r.load?.body?.运行时自述
  if (自述)
    console.log(
      `  运行时面: ua=${自述.navigatorUserAgent} process=${自述.process} Buffer=${自述.Buffer} setImmediate=${自述.setImmediate} node:fs=${JSON.stringify(自述.能否import_node_fs)} node:crypto=${JSON.stringify(自述.能否import_node_crypto)}`,
    )
}

await writeFile(
  new URL("./out.json", HERE),
  JSON.stringify(
    {
      跑于: new Date().toISOString(),
      打了真API: live,
      核对: Object.fromEntries(
        results.map((r) => [r.name, r.启动失败 ? null : { pi: piChecksOf(r), fetch: fetchChecksOf(r) }]),
      ),
      结果: results,
    },
    null,
    2,
  ),
)
console.log("\n完整结果落盘：spikes/runtime-matrix/out.json")

// 失败细节直接打出来
for (const r of results)
  for (const [k, v] of Object.entries(r))
    if (v && typeof v === "object" && "status" in v && v.status !== 200)
      console.log(`\n【${r.name} ${k} 失败详情】\n${JSON.stringify(v.body, null, 2).slice(0, 2000)}`)

// 假端点 / 宿主都已 kill，但残留的 keep-alive 连接与管道可能拖住事件循环，显式退出
process.exit(0)
