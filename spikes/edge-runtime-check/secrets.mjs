/**
 * 从根目录《模型API测试信息.md》读探针要用的密钥与端点（gitignore，不进提交）。
 * 原本内嵌在 run.mjs 里，2026-09-15 抽出来给 runtime-matrix（Bun / Deno / Vercel Edge）共用——同一份读法，
 * 免得两处正则各改各的又撞上"说明文字也含 baseurl 字样"那类坑。
 */
import { readFile } from "node:fs/promises"

const INFO_URL = new URL("../../模型API测试信息.md", import.meta.url)

/** DeepSeek 官方 Anthropic 端口的 key 与 baseUrl。选它是因为直连 https、已实测五项全 200，
 *  不经 aireiter（网关会改写请求、吞消息）也不经 Claude 中转（那个是 http 明文，会污染运行时结论）。 */
export async function readDeepSeek() {
  const info = await readFile(INFO_URL, "utf8")
  const key = info.match(/deepseek官方[\s\S]*?key:\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
  // 注意：信息文件里有一句**说明文字**也含"anthropic 协议 baseurl："字样，后面紧跟反引号，
  // 只用 \S+ 会先撞上它抓到一个反引号（实测 Invalid URL string.）。所以锚定必须以 http(s):// 开头。
  const base = info.match(/anthropic 协议 baseurl：\s*(https?:\/\/\S+)/)?.[1]
  const model = info.match(/deepseek官方[\s\S]*?模型：\s*(\S+)/)?.[1]
  if (!key || !base) throw new Error("没在信息文件里找到 DeepSeek 的 key 或 baseUrl")
  return { key, base, model }
}

/** aireiter 聚合网关的 key：OpenAI Responses 协议侧用它（DeepSeek 的 responses 端口未经 reins 核实）。
 *  网关对 Claude 那条路有改写请求、吞消息的问题，但这里只验运行时能否跑通 openai SDK，与语义无关。 */
export async function readGateway() {
  const info = await readFile(INFO_URL, "utf8")
  const key = info.match(/密钥（三种协议共用）：`(sk-[^`]+)`/)?.[1]
  if (!key) throw new Error("没在信息文件里找到网关密钥")
  return { key, base: "https://aireiter.com/api/v1", model: "gpt-5.5" }
}

/** CF AI Gateway 的透传基址与令牌（F0 体检过的官方靶子）；读法与 f1 / f2 / f3 spike 一致 */
export async function readCf() {
  const info = await readFile(INFO_URL, "utf8")
  const token = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
  const account = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
  const gateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
  if (!token || !account) throw new Error("信息文件里缺 CF 令牌 / account id")
  return { token, base: `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}` }
}

/** 探针宿主要的一整套环境变量：假端点地址 + （--live 时）三家真模型的凭证。两个编排器共用同一张表。 */
export async function probeEnv({ fakeBase, mcpBase, live }) {
  const vars = { FAKE_BASE: fakeBase, MCP_BASE: mcpBase }
  if (!live) return vars
  const [ds, gw, cf] = await Promise.all([readDeepSeek(), readGateway(), readCf()])
  return {
    ...vars,
    LIVE_KEY: ds.key,
    LIVE_BASE: ds.base,
    LIVE_MODEL: ds.model ?? "deepseek-v4-flash",
    OAI_KEY: gw.key,
    OAI_BASE: gw.base,
    OAI_MODEL: gw.model,
    FETCH_DS_KEY: ds.key,
    FETCH_CF_BASE: cf.base,
    FETCH_CF_TOKEN: cf.token,
  }
}
