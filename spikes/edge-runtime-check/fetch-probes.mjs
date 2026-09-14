/**
 * fetch 版降级层（@reinsjs/lowering-fetch）的 workerd 探针 —— F4 收口追加（2026-09-15）。
 *
 * 与 pi 版探针共用同一组事件、工具与本地假 Anthropic 端点，三条线协议各走一遍，一律打 dist。
 * 这个包的卖点之一是"零依赖、只用 fetch，Node / Workers / Deno / Bun 同一份代码"，README 已经这么写了，
 * 所以必须在最严档 workerd（无 process / Buffer、node:* 一律 import 失败）上实证，不能只凭静态 import 链干净。
 *
 * 路由（由 worker.mjs 分派）：
 *   /fetch-load            三条线各构造一次请求体，不出网；顺带列出有损矩阵覆盖的协议与非 exact 落点
 *   /fetch-fake            Anthropic 线打本地假端点：fetch → 自写 SSE 解析 → 事件草稿，压 UTF-8 乱切与 input_json_delta 拼装
 *   /fetch-live-chat       Chat Completions 线打 DeepSeek 直连
 *   /fetch-live-anthropic  Anthropic Messages 线经 CF 网关打官方 Haiku 4.5
 *   /fetch-live-responses  OpenAI Responses 线经 CF 网关打官方 gpt-5-mini
 */
import {
  anthropicMessages,
  chatCompletions,
  deepseek,
  LOSS_MATRIX,
  openaiResponses,
} from "../../packages/lowering-fetch/dist/index.js"

/** CF 网关自带凭证头，走 `auth: "none"`（带 Bearer 会失败，F0 实测） */
const gatewayAuth = (token) => ({
  apiKey: "",
  auth: "none",
  headers: { "cf-aig-authorization": `Bearer ${token}` },
})

/** 按路由与环境变量造 BoundModel；缺配置返回 null 让调用方回 400 */
export function fetchTargetFor(route, env) {
  switch (route) {
    case "fake":
      if (!env.FAKE_BASE) return null
      // 假端点监听含 "messages" 的路径；fetch 版在 baseUrl 后接 /messages，所以 baseUrl 要带 /v1
      return anthropicMessages("fake-model", {
        provider: "probe",
        baseUrl: `${env.FAKE_BASE}/v1`,
        apiKey: "sk-test",
        reasoning: true,
        midConversationSystem: true,
      })
    case "live-chat":
      if (!env.FETCH_DS_KEY) return null
      return deepseek(env.FETCH_DS_MODEL ?? "deepseek-flash", { apiKey: env.FETCH_DS_KEY })
    case "live-anthropic":
      if (!env.FETCH_CF_BASE || !env.FETCH_CF_TOKEN) return null
      return anthropicMessages(env.FETCH_CF_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001", {
        provider: "anthropic",
        baseUrl: `${env.FETCH_CF_BASE}/anthropic/v1`,
        ...gatewayAuth(env.FETCH_CF_TOKEN),
        requestOptions: { max_tokens: 1024 },
      })
    case "live-responses":
      if (!env.FETCH_CF_BASE || !env.FETCH_CF_TOKEN) return null
      return openaiResponses(env.FETCH_CF_RESPONSES_MODEL ?? "gpt-5-mini", {
        provider: "openai",
        baseUrl: `${env.FETCH_CF_BASE}/openai/v1`,
        ...gatewayAuth(env.FETCH_CF_TOKEN),
        reasoning: true,
        requestOptions: { reasoning: { effort: "low" } },
      })
    default:
      return null
  }
}

/** 第 1 层：三条线各构造一次请求体，全程不出网。baseUrl 随便给，toRequest 不会碰网络 */
export function fetchProbeLoad({ events, tools, systemPrompt }) {
  const targets = {
    "openai-chat": chatCompletions("probe-chat", {
      provider: "probe",
      baseUrl: "https://example.invalid/v1",
      apiKey: "x",
    }),
    "anthropic-messages": anthropicMessages("probe-anthropic", {
      provider: "probe",
      baseUrl: "https://example.invalid/v1",
      apiKey: "x",
      midConversationSystem: true,
    }),
    "openai-responses": openaiResponses("probe-responses", {
      provider: "probe",
      baseUrl: "https://example.invalid/v1",
      apiKey: "x",
      reasoning: true,
    }),
  }
  const 三条线 = {}
  for (const [api, bound] of Object.entries(targets)) {
    const req = bound.lowering.toRequest({ events, tools, model: bound.model, systemPrompt })
    const body = req.payload.body
    三条线[api] = {
      payloadApi: req.payload.api,
      消息数: Array.isArray(body.messages)
        ? body.messages.length
        : Array.isArray(body.input)
          ? body.input.length
          : null,
      工具数: Array.isArray(body.tools) ? body.tools.length : null,
      非exact落点: req.landings.filter((l) => l.kind !== "exact"),
    }
  }
  return { ok: true, 模块加载: "成功", 有损矩阵覆盖的协议: Object.keys(LOSS_MATRIX), 三条线 }
}

/** 第 2、3 层：真发一次请求，把流式产出的事件草稿全收下来。tool_call 的 payload 原样带回，供编排器核对入参 */
export async function fetchProbeStream(bound, { events, tools, systemPrompt }) {
  const req = bound.lowering.toRequest({ events, tools, model: bound.model, systemPrompt })
  const drafts = []
  const gen = bound.lowering.stream(req, {})
  let r = await gen.next()
  while (!r.done) {
    const d = r.value
    drafts.push({
      type: d.type,
      payload: d.type === "core.tool_call" ? d.payload : undefined,
      payload摘要: JSON.stringify(d.payload).slice(0, 200),
      thinking签名长度: d.replay?.thinkingSignature ? String(d.replay.thinkingSignature).length : null,
    })
    r = await gen.next()
  }
  return {
    ok: true,
    api: req.payload.api,
    请求体消息数: Array.isArray(req.payload.body.messages)
      ? req.payload.body.messages.length
      : Array.isArray(req.payload.body.input)
        ? req.payload.body.input.length
        : null,
    事件草稿数: drafts.length,
    草稿: drafts,
    收尾: r.value,
  }
}
