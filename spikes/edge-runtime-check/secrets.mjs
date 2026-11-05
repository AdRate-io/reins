/**
 * 探针要用的密钥与端点，从仓库根 `.env.local` 读（经 scripts/local-env.mjs；gitignore，不进提交）。
 * 用到的变量：DEEPSEEK_API_KEY、AIREITER_API_KEY、CF_AIG_TOKEN、CF_ACCOUNT_ID、CF_GATEWAY_ID（缺省 reins-dev）。
 * 原本内嵌在 run.mjs 里，2026-09-15 抽出来给 runtime-matrix（Bun / Deno / Vercel Edge）共用——同一份读法。
 * 导出函数保持 async 签名，调用方不用动。
 */
import { cfGatewayBase, need } from "../../scripts/local-env.mjs"

/** DeepSeek 官方 Anthropic 端口的 key 与 baseUrl。选它是因为直连 https、已实测五项全 200，
 *  不经 aireiter（网关会改写请求、吞消息）也不经 Claude 中转（那个是 http 明文，会污染运行时结论）。 */
export async function readDeepSeek() {
  return {
    key: need("DEEPSEEK_API_KEY"),
    base: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
  }
}

/** aireiter 聚合网关的 key：OpenAI Responses 协议侧用它（DeepSeek 的 responses 端口未经 reins 核实）。
 *  网关对 Claude 那条路有改写请求、吞消息的问题，但这里只验运行时能否跑通 openai SDK，与语义无关。 */
export async function readGateway() {
  return { key: need("AIREITER_API_KEY"), base: "https://aireiter.com/api/v1", model: "gpt-5.5" }
}

/** CF AI Gateway 的透传基址与令牌（F0 体检过的官方靶子）；读法与 f1 / f2 / f3 spike 一致 */
export async function readCf() {
  return { token: need("CF_AIG_TOKEN"), base: cfGatewayBase() }
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
