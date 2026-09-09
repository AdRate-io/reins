/**
 * Workers（workerd）运行时兼容性探针 —— 在真 edge 运行时里加载并驱动 @reins/lowering-pi 的**打包产物**。
 *
 * 为什么要有：PRD 把"跑在任何 Web 标准运行时"当卖点，但降级层 lowering-pi 经 pi-ai 间接牵进
 * @anthropic-ai/sdk 与 openai 两个 SDK，二者的 exports 没有 worker / edge 条件导出（只有
 * require / types / default），靠运行时探测打 shim。静态 import 链实测零 node: 内置，
 * 但"能不能真在 workerd 里跑起来"此前从未实证。
 *
 * 为什么打 dist 而不打源码：B11 的教训 —— @reins/store-sqlite 的 node:sqlite 被 tsup 缺省
 * removeNodeProtocol 剥成 sqlite，运行时 ERR_MODULE_NOT_FOUND，就因为只跑过源码与 vitest 路径。
 * 这里一律 import 各包 dist/index.js，验的是用户真正装到的东西。
 *
 * 三层路由，成本由低到高：
 *   /load —— 只加载模块 + 构造请求体，不出网。最可能爆的一层（模块解析、shim 探测、CJS 互操作）。
 *   /fake —— 打本地假 Anthropic 端点，真跑 fetch + SSE 流式解析 + 产出事件。零成本走完整链路。
 *   /live —— 打真 DeepSeek Anthropic 端口，确认 header / TLS / 真实流没有意外。
 */
import { createCoreEvent, createCoreRegistry } from "../../packages/core/dist/index.js"
import { LOSS_MATRIX, PiAiLowering } from "../../packages/lowering-pi/dist/index.js"

const registry = createCoreRegistry()

/** 一组固定事件：用户提问 → （第二轮会补）工具结果 + 中途 system_note。与 t7-live-roundtrip 同形。 */
function buildEvents(sessionId) {
  let seq = 0
  const events = []
  const push = (draft) => {
    seq += 1
    const e = createCoreEvent(registry, { ...draft, sessionId, seq })
    events.push(e)
    return e
  }
  push({
    type: "core.user_message",
    actor: "user",
    payload: { content: [{ type: "text", text: "上海现在天气怎么样？" }] },
  })
  return { events, push }
}

const TOOLS = [
  {
    name: "get_weather",
    description: "查询城市当前天气",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
]

/** 造一个指向给定 baseUrl 的 Anthropic 协议模型定义。midConversationSystem 显式声明，与 DeepSeek 实测一致。 */
function modelDef(baseUrl, id, api = "anthropic-messages") {
  return {
    provider: "probe",
    id,
    api,
    baseUrl,
    reasoning: true,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    midConversationSystem: true,
  }
}

function loweringFor(baseUrl, id, apiKey, api = "anthropic-messages") {
  return new PiAiLowering({
    apiKey: () => apiKey,
    models: [modelDef(baseUrl, id, api)],
    // 两家的"要思考"开关不同名：Anthropic 是 thinkingEnabled，OpenAI Responses 是 reasoningEffort
    requestOptions: () =>
      api === "openai-responses" ? { reasoningEffort: "medium" } : { thinkingEnabled: true },
  })
}

/** 试着动态 import 一个 Node 内置模块，返回 true / 错误码。用来量这一档的 Node 兼容面。 */
async function canImport(spec) {
  try {
    await import(spec)
    return true
  } catch (e) {
    return e?.code ?? e?.name ?? String(e?.message ?? e).slice(0, 60)
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/** 第 1 层：模块加载 + 请求体构造，全程不出网。 */
async function probeLoad() {
  const { events } = buildEvents("probe-load")
  const lowering = loweringFor("https://example.invalid", "probe-model", "sk-not-used")
  const req = lowering.toRequest({
    events,
    tools: TOOLS,
    model: { provider: "probe", id: "probe-model" },
    systemPrompt: "你是天气助手，必须先调用 get_weather 再回答。",
  })
  return {
    ok: true,
    模块加载: "成功",
    有损矩阵覆盖的协议: Object.keys(LOSS_MATRIX),
    构造出的消息数: req.payload?.context?.messages?.length ?? null,
    工具数: req.payload?.context?.tools?.length ?? null,
    落点: req.landings,
    非exact落点: req.landings.filter((l) => l.kind !== "exact"),
    // 运行时自述：用来判断"这一档到底有多严格"。Workers 较新的 compatibility_date 会默认带上
    // 一部分 Node 内建（process / Buffer 等），所以只看"跑通了"会高估结论，必须把实际可用面记下来。
    运行时自述: {
      navigatorUserAgent: typeof navigator !== "undefined" ? navigator.userAgent : "(无 navigator)",
      process: typeof process,
      processVersions: typeof process !== "undefined" ? Boolean(process?.versions?.node) : false,
      Buffer: typeof Buffer,
      setImmediate: typeof setImmediate,
      // 真正的 Node 内置模块能不能 require/import 到，是区分"有 shim 全局量"与"有完整 nodejs_compat"的关键
      能否import_node_fs: await canImport("node:fs"),
      能否import_node_crypto: await canImport("node:crypto"),
    },
  }
}

/** 第 2、3 层：真发一次请求，把流式产出的事件草稿全收下来。 */
async function probeStream(baseUrl, id, apiKey, label, api = "anthropic-messages") {
  const { events } = buildEvents(`probe-${label}`)
  const lowering = loweringFor(baseUrl, id, apiKey, api)
  const req = lowering.toRequest({
    events,
    tools: TOOLS,
    model: { provider: "probe", id },
    systemPrompt: "你是天气助手，必须先调用 get_weather 再回答。",
  })
  const drafts = []
  const gen = lowering.stream(req, {})
  let r = await gen.next()
  while (!r.done) {
    const d = r.value
    drafts.push({
      type: d.type,
      payload摘要: JSON.stringify(d.payload).slice(0, 200),
      thinking签名长度: d.replay?.thinkingSignature ? String(d.replay.thinkingSignature).length : null,
    })
    r = await gen.next()
  }
  return { ok: true, 事件草稿数: drafts.length, 草稿: drafts, 收尾: r.value }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/load") return json(await probeLoad())
      if (url.pathname === "/fake") {
        if (!env.FAKE_BASE) return json({ ok: false, 原因: "未设 FAKE_BASE" }, 400)
        return json(await probeStream(env.FAKE_BASE, "fake-model", "sk-test", "fake"))
      }
      if (url.pathname === "/live") {
        if (!env.LIVE_KEY) return json({ ok: false, 原因: "未设 LIVE_KEY" }, 400)
        return json(
          await probeStream(env.LIVE_BASE, env.LIVE_MODEL ?? "deepseek-v4-flash", env.LIVE_KEY, "live"),
        )
      }
      if (url.pathname === "/live-openai") {
        // 单独一条：openai-responses 协议走 openai SDK，和 Anthropic 那条路的 shim 探测各自独立，
        // 只验一条就宣布"降级层能在 edge 跑"是不完整的。
        if (!env.OAI_KEY) return json({ ok: false, 原因: "未设 OAI_KEY" }, 400)
        return json(
          await probeStream(
            env.OAI_BASE,
            env.OAI_MODEL ?? "gpt-5.5",
            env.OAI_KEY,
            "live-openai",
            "openai-responses",
          ),
        )
      }
      return json({ ok: true, 路由: ["/load", "/fake", "/live", "/live-openai"] })
    } catch (e) {
      // 兼容性问题基本都在这里现形：把 name / message / stack 全带回去，便于判断是哪一层炸的
      return json(
        {
          ok: false,
          错误名: e?.name,
          错误码: e?.code,
          消息: String(e?.message ?? e),
          栈: String(e?.stack ?? "")
            .split("\n")
            .slice(0, 12),
        },
        500,
      )
    }
  },
}
