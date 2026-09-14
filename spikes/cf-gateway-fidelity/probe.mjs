/**
 * F0 靶子体检：Cloudflare AI Gateway（Unified Billing 透传路径）对 Anthropic Messages / OpenAI Responses /
 * OpenAI Chat Completions 三条端点是否"忠实"——请求原样到厂商、响应原样回来、错误原文透传。
 *
 * 为什么要体检：aireiter 网关曾把我们的中途 system 丢掉、把伪造签名放行（spikes/aireiter-gateway-check、gateway-check），
 * 用它验出来的"通过"是假的。CF 网关要当 lowering-fetch 的官方靶子，必须先证明它不改写。
 *
 * 方法：暗号法。把暗号放在被测位置，只让模型回一行；内容到了模型才答得出。判据永远是产出内容，不是状态码。
 * 反向项（伪造签名 / 伪造 encrypted_content / 假 beta 头）要求拿到厂商**原文 400**，证明网关没有在中间吞掉再放行。
 *
 * 运行：node spikes/cf-gateway-fidelity/probe.mjs <anthropic|responses|chat|all>
 *   配置自动从仓库根《模型API测试信息.md》读（cfut_ 令牌、account id、gateway id）；原始响应落 out/（已 gitignore）。
 *   可用环境变量换模型：CF_ANTHROPIC_MODEL（缺省 claude-haiku-4-5-20251001）、CF_ANTHROPIC_MID_MODEL（缺省 claude-opus-5，
 *   中途 system 只有 Opus 5 / Fable 5 族接受）、CF_OPENAI_MODEL（缺省 gpt-5-mini，Responses 要能出 encrypted reasoning）、
 *   CF_CHAT_MODEL（缺省 gpt-4o-mini）。
 */
import { readFile, writeFile } from "node:fs/promises"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const token = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
const account = info.match(/account id：\s*([0-9a-f]{32})/)?.[1]
const gateway = info.match(/gateway id：\s*([A-Za-z0-9_-]+)/)?.[1]
if (!token || !account || !gateway) throw new Error("信息文件里缺 cfut_ 令牌 / account id / gateway id")
const BASE = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`
const AUTH = { "cf-aig-authorization": `Bearer ${token}` }

const ANTHROPIC_MODEL = process.env.CF_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001"
const ANTHROPIC_MID_MODEL = process.env.CF_ANTHROPIC_MID_MODEL ?? "claude-opus-5"
const OPENAI_MODEL = process.env.CF_OPENAI_MODEL ?? "gpt-5-mini"
const CHAT_MODEL = process.env.CF_CHAT_MODEL ?? "gpt-4o-mini"

const which = process.argv[2]
const results = []
const ok = (name, pass, note = "") => {
  results.push({ name, pass, note })
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? `  —  ${note}` : ""}`)
}
const outDir = new URL("./out/", import.meta.url)
const safeJson = (t) => {
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}
const uniq = (arr) => [...new Set(arr)]
let rateLimited = 0

/**
 * 发一次请求，原始响应落盘；SSE 时顺手解析成 events（并记录每帧 JSON 之外的多余键，如 CF 已知的 "p" 填充）。
 * 只对 502/503/504 重试，其它状态一律原样返回——错误原文正是要核对的东西。
 */
async function call(path, body, extraHeaders, label) {
  let last
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now()
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH, ...extraHeaders },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const headers = Object.fromEntries(
      [...res.headers].filter(([k]) =>
        /^(cf-|x-|retry-after|anthropic-|openai-|request-id|content-type|server)/i.test(k),
      ),
    )
    last = {
      status: res.status,
      text,
      ct: res.headers.get("content-type") ?? "",
      ms: Date.now() - started,
      headers,
    }
    if (res.status === 429 && /Wholesale Rate limited/.test(text)) {
      // CF Unified Billing 的账户级限流（code 2018），不是厂商 429；是瞬断，退避后重试，次数单独统计
      rateLimited++
      const wait = Number(res.headers.get("retry-after")) * 1000 || 4000 * attempt
      console.log(
        `  (${label} 第 ${attempt} 次 CF 限流 429，retry-after=${res.headers.get("retry-after") ?? "无"}，${wait}ms 后重试；body=${text.slice(0, 200)})`,
      )
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (![502, 503, 504].includes(res.status)) break
    console.log(`  (${label} 第 ${attempt} 次 ${res.status}，重试)`)
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
  await writeFile(
    new URL(`./${label}.txt`, outDir),
    `HTTP ${last.status} ${last.ct} ${last.ms}ms\n${JSON.stringify(last.headers, null, 1)}\n\n${last.text}`,
  )
  const events = []
  let unparsed = 0
  if (last.ct.includes("event-stream")) {
    for (const chunk of last.text.split(/\n\n+/)) {
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
      if (!data || data === "[DONE]") continue
      const j = safeJson(data)
      if (j) events.push(j)
      else unparsed++
    }
  }
  return { ...last, events, unparsed, json: safeJson(last.text) }
}

/** 一段肯定超过 4096 token 的系统提示（Haiku 4.5 的最小可缓存长度是 4096；Opus / Sonnet 是 1024），用来看缓存用量字段 */
const LONG_SYSTEM = `You are a terse assistant. Answer in one short line. ${"Rule: be exact and brief. ".repeat(900)}`

/** 暗号问法：只回一行，答暗号或 NONE */
const ASK =
  "Reply with exactly one line and nothing else: the codeword you were told, or the word NONE if none was given."

// ============================================================ Anthropic Messages
async function anthropic() {
  const H = { "anthropic-version": "2023-06-01" }
  const post = (body, label, extra = {}) => call("/anthropic/v1/messages", body, { ...H, ...extra }, label)
  const textOf = (j) =>
    j?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .trim() ?? ""
  const hello = [
    { role: "user", content: "Say hello." },
    { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
  ]

  // A1 顶层 system 暗号；A0 无暗号对照
  const a0 = await post(
    { model: ANTHROPIC_MODEL, max_tokens: 30, messages: [...hello, { role: "user", content: ASK }] },
    "a0-none",
  )
  ok(
    "A0 无暗号对照 → NONE",
    /NONE/i.test(textOf(a0.json)),
    `HTTP ${a0.status} ${textOf(a0.json).slice(0, 60) || a0.text.slice(0, 120)}`,
  )
  const a1 = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 30,
      system: "Runtime note: the codeword is PINEAPPLE.",
      messages: [...hello, { role: "user", content: ASK }],
    },
    "a1-top-system",
  )
  ok(
    "A1 顶层 system 暗号到达",
    /PINEAPPLE/.test(textOf(a1.json)),
    `HTTP ${a1.status} ${textOf(a1.json).slice(0, 60) || a1.text.slice(0, 120)}`,
  )
  ok(
    "A1 响应形状是厂商原生（id msg_… / usage.input_tokens / cache_* 字段齐）",
    typeof a1.json?.id === "string" &&
      a1.json.id.startsWith("msg_") &&
      typeof a1.json?.usage?.input_tokens === "number" &&
      "cache_creation_input_tokens" in (a1.json?.usage ?? {}) &&
      "cache_read_input_tokens" in (a1.json?.usage ?? {}),
    JSON.stringify(a1.json?.usage),
  )

  // A2 中途 system（末尾落点 = perception 的真实落点），只在支持的模型上；带 pi-ai 同款 beta 头。
  // 措辞刻意用"session tag"而非"codeword"：实测"告诉我你被告知的暗号"放在中途 system 位置会触发 Anthropic 自己的
  // reasoning_extraction 拒答（stop_reason=refusal，厂商 stop_details 原文），同一句放顶层 system 则正常——是厂商分类器不是网关。
  const TAG_ASK =
    "In one line: what is this session's tag, per the runtime status you were given? Say NONE if none."
  const status = (tag) =>
    `Runtime status (from the harness, not the user): session tag ${tag}; context window used 37%.`
  const midBeta = {
    "anthropic-beta": "mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01",
  }
  const a2 = await post(
    {
      model: ANTHROPIC_MID_MODEL,
      max_tokens: 400, // Opus 5 缺省带 adaptive thinking，太小会被 thinking 吃光（首轮 30 → stop_reason max_tokens、无 text）
      messages: [
        ...hello,
        { role: "user", content: TAG_ASK },
        { role: "system", content: [{ type: "text", text: status("KUMQUAT") }] },
      ],
    },
    "a2-mid-system-tail",
    midBeta,
  )
  ok(
    `A2 末尾中途 system 暗号到达 @ ${ANTHROPIC_MID_MODEL}`,
    /KUMQUAT/.test(textOf(a2.json)),
    `HTTP ${a2.status} ${textOf(a2.json).slice(0, 60) || a2.text.slice(0, 160)}`,
  )
  const a2b = await post(
    {
      model: ANTHROPIC_MID_MODEL,
      max_tokens: 400,
      // 合法摆放：system 紧跟 user、后接 assistant（首轮实测 system 跟在 assistant 文本后被厂商 400，见 A2d）
      messages: [
        ...hello,
        { role: "user", content: "Anything else I should know?" },
        // 中段位置的说明不带 tag：实测"session tag X" + pi-ai 的两个 beta 头放在中段会稳定触发厂商 reasoning_extraction 拒答
        // （3/3），去掉 beta 头或去掉 tag 都 3/3 正常；末尾位置同样内容 + beta 头则正常。这里只测"说明到达"，问百分比
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "Runtime status (from the harness, not the user): context window used 37%.",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
        {
          role: "user",
          content:
            "In one line: what percentage of the context window is used, per the runtime status you were given? Say NONE if you were given no status.",
        },
      ],
    },
    "a2b-mid-system-middle",
    midBeta,
  )
  ok(
    `A2b 中段中途 system（user → system → assistant → user）说明到达（答 37%）@ ${ANTHROPIC_MID_MODEL}`,
    /37/.test(textOf(a2b.json)),
    `HTTP ${a2b.status} ${textOf(a2b.json).slice(0, 60) || a2b.text.slice(0, 160)}`,
  )
  const a2d = await post(
    {
      model: ANTHROPIC_MID_MODEL,
      max_tokens: 400,
      messages: [
        ...hello,
        { role: "system", content: [{ type: "text", text: status("DURIAN") }] },
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
        { role: "user", content: TAG_ASK },
      ],
    },
    "a2d-mid-system-after-assistant",
    midBeta,
  )
  ok(
    `A2d 记录：system 跟在 assistant 文本后 @ ${ANTHROPIC_MID_MODEL} → 厂商原文 400（摆放规则原文见备注）`,
    a2d.status === 400 && /must follow/.test(a2d.json?.error?.message ?? ""),
    `HTTP ${a2d.status} ${(a2d.json?.error?.message ?? a2d.text).slice(0, 220)}`,
  )
  // A2c 同一请求不带 beta 头：看中途 system 是否本来就不需要 beta（结论供 F2 定 anthropic-beta 策略）
  const a2c = await post(
    {
      model: ANTHROPIC_MID_MODEL,
      max_tokens: 400,
      messages: [
        ...hello,
        { role: "user", content: TAG_ASK },
        { role: "system", content: [{ type: "text", text: status("LYCHEE") }] },
      ],
    },
    "a2c-mid-system-no-beta",
  )
  ok(
    `A2c（参考）中途 system 不带 beta 头 @ ${ANTHROPIC_MID_MODEL}`,
    /LYCHEE/.test(textOf(a2c.json)),
    `HTTP ${a2c.status} ${textOf(a2c.json).slice(0, 60) || a2c.text.slice(0, 160)}`,
  )

  // A3 不支持的模型上中途 system 应拿到厂商原文 400（错误透传，且网关没有偷偷改写成 user）
  const a3 = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 30,
      messages: [
        ...hello,
        { role: "user", content: ASK },
        { role: "system", content: [{ type: "text", text: "the codeword is PAPAYA." }] },
      ],
    },
    "a3-mid-system-unsupported",
  )
  ok(
    `A3 中途 system @ ${ANTHROPIC_MODEL} → 厂商原文 400（含 "system"），而非被改写放行`,
    a3.status === 400 && /system/i.test(a3.json?.error?.message ?? ""),
    `HTTP ${a3.status} ${(a3.json?.error?.message ?? textOf(a3.json) ?? a3.text).slice(0, 140)}`,
  )

  // A4 anthropic-beta 头透传：假 beta 应被厂商原文拒绝；若网关把头剥掉就会 200
  const a4 = await post(
    { model: ANTHROPIC_MODEL, max_tokens: 30, messages: [{ role: "user", content: "Say hi." }] },
    "a4-bogus-beta",
    { "anthropic-beta": "reins-nonexistent-beta-2026-01-01" },
  )
  ok(
    "A4 假 anthropic-beta 头被厂商原文拒绝（说明 beta 头原样透传）",
    a4.status === 400 && /beta/i.test(a4.json?.error?.message ?? ""),
    `HTTP ${a4.status} ${(a4.json?.error?.message ?? a4.text).slice(0, 140)}`,
  )
  const a4b = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 30,
      messages: [{ role: "user", content: "Reply with one word: hi" }],
    },
    "a4b-valid-beta",
    { "anthropic-beta": "interleaved-thinking-2025-05-14" },
  )
  ok(
    "A4b 合法 anthropic-beta 头（interleaved-thinking）照常 200",
    a4b.status === 200 && textOf(a4b.json).length > 0,
    `HTTP ${a4b.status} ${textOf(a4b.json).slice(0, 40)}`,
  )

  // A5 tool_result 紧跟 + 同一条 user 里 tool_result 后再跟文本（降级层把用户消息并进同一条的形状）
  const weather = [
    {
      name: "get_weather",
      description: "Current weather of a city",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  ]
  const a5a = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 200,
      tools: weather,
      tool_choice: { type: "tool", name: "get_weather" },
      messages: [{ role: "user", content: "What is the weather in Shanghai?" }],
    },
    "a5a-forced-tool",
  )
  const tu = a5a.json?.content?.find((c) => c.type === "tool_use")
  ok(
    "A5a 强制 tool_choice 得到 tool_use（id toolu_…，input 是对象）",
    Boolean(tu?.id?.startsWith("toolu_")) && typeof tu?.input === "object",
    JSON.stringify(tu).slice(0, 120) || a5a.text.slice(0, 120),
  )
  if (tu) {
    const a5b = await post(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 60,
        tools: weather,
        messages: [
          { role: "user", content: "What is the weather in Shanghai?" },
          { role: "assistant", content: a5a.json.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: tu.id, content: "Sunny, 28°C" },
              {
                type: "text",
                text: "Harness note: the codeword is MANGO. Reply in one line with the temperature and the codeword.",
              },
            ],
          },
        ],
      },
      "a5b-tool-result-then-text",
    )
    const t5 = textOf(a5b.json)
    ok(
      "A5b tool_result 紧跟 + 同条 user 后续文本都到达（答里有 28 与 MANGO）",
      /28/.test(t5) && /MANGO/.test(t5),
      `HTTP ${a5b.status} ${t5.slice(0, 80) || a5b.text.slice(0, 140)}`,
    )
  }

  // A6 cache_control：块级断点两次同前缀 → 第一次 creation>0、第二次 read>0；再看顶层 cache_control
  const cacheBody = (q) => ({
    model: ANTHROPIC_MODEL,
    max_tokens: 20,
    system: [{ type: "text", text: LONG_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: q }],
  })
  const a6a = await post(cacheBody("Say hi."), "a6a-cache-write")
  const a6b = await post(cacheBody("Say hi again."), "a6b-cache-read")
  const u6a = a6a.json?.usage ?? {}
  const u6b = a6b.json?.usage ?? {}
  ok(
    "A6 块级 cache_control 生效：首发 cache_creation>0（或 read>0），复发 cache_read>0",
    (u6a.cache_creation_input_tokens > 0 || u6a.cache_read_input_tokens > 0) &&
      u6b.cache_read_input_tokens > 0,
    `首发 ${JSON.stringify(u6a)} → 复发 ${JSON.stringify(u6b)}`,
  )
  ok(
    "A6 用量含 cache_creation.ephemeral_5m_input_tokens 明细（厂商原生字段未被剪）",
    typeof u6a.cache_creation?.ephemeral_5m_input_tokens === "number" ||
      typeof u6b.cache_creation?.ephemeral_5m_input_tokens === "number",
    JSON.stringify(u6a.cache_creation ?? u6b.cache_creation),
  )
  const a6c = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 20,
      cache_control: { type: "ephemeral" },
      system: `${LONG_SYSTEM} Variant-for-top-level.`,
      messages: [{ role: "user", content: "Say hi a third time." }],
    },
    "a6c-top-level-cache-control",
  )
  ok(
    "A6c（参考）顶层 cache_control（pi-ai automatic 模式补的字段）被接受且产生缓存用量",
    a6c.status === 200 &&
      ((a6c.json?.usage?.cache_creation_input_tokens ?? 0) > 0 ||
        (a6c.json?.usage?.cache_read_input_tokens ?? 0) > 0),
    `HTTP ${a6c.status} ${JSON.stringify(a6c.json?.usage ?? a6c.json?.error?.message ?? a6c.text.slice(0, 120))}`,
  )

  // A7 流式 + thinking + 工具：事件形状、"p" 填充、签名；然后回放签名（应接受）与伪造签名（应厂商原文 400）
  const a7 = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1024 },
      tools: weather,
      system: "You are a weather assistant. Always call get_weather before answering.",
      messages: [{ role: "user", content: "Weather in Shanghai now?" }],
    },
    "a7-stream-thinking-tool",
  )
  const types = uniq(a7.events.map((e) => e.type))
  ok(
    "A7 流式 SSE 事件序列完整（message_start … message_stop），每帧 JSON 可解析",
    a7.ct.includes("event-stream") &&
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ].every((t) => types.includes(t)) &&
      a7.unparsed === 0,
    `HTTP ${a7.status} ${types.join(",")} 未解析 ${a7.unparsed}`,
  )
  const extraKeys = uniq(
    a7.events.flatMap((e) =>
      Object.keys(e).filter(
        (k) => !["type", "message", "index", "content_block", "delta", "usage"].includes(k),
      ),
    ),
  )
  ok(
    'A7 记录：事件里厂商标准键之外的多余键（已知 Anthropic 自带 "p" 填充）',
    true,
    extraKeys.join(",") || "无",
  )
  const starts = a7.events.filter((e) => e.type === "content_block_start").map((e) => e.content_block)
  const sig = a7.events.find((e) => e.delta?.type === "signature_delta")?.delta?.signature
  const thinkingText = a7.events
    .filter((e) => e.delta?.type === "thinking_delta")
    .map((e) => e.delta.thinking)
    .join("")
  const toolStart = starts.find((b) => b?.type === "tool_use")
  const argJson = a7.events
    .filter((e) => e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json)
    .join("")
  ok(
    "A7 出现 thinking 块 + signature_delta + tool_use（input_json_delta 可拼 JSON）",
    Boolean(sig) && Boolean(toolStart) && Boolean(safeJson(argJson)),
    `签名 ${sig?.length ?? 0} 字符，blocks: ${starts.map((b) => b?.type).join(",")}`,
  )
  const md = a7.events.find((e) => e.type === "message_delta")
  ok(
    "A7 message_delta 带 stop_reason=tool_use 与 usage",
    md?.delta?.stop_reason === "tool_use" && typeof md?.usage?.output_tokens === "number",
    JSON.stringify({ stop: md?.delta?.stop_reason, usage: md?.usage }),
  )
  if (sig && toolStart) {
    const replay = (signature, label, maxTokens) =>
      post(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          thinking: { type: "enabled", budget_tokens: 1024 },
          tools: weather,
          system: "You are a weather assistant. Always call get_weather before answering.",
          messages: [
            { role: "user", content: "Weather in Shanghai now?" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: thinkingText, signature },
                { type: "tool_use", id: toolStart.id, name: "get_weather", input: safeJson(argJson) ?? {} },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolStart.id,
                  content: "Sunny, 28°C. Harness codeword: GUAVA. Mention the codeword in your reply.",
                },
              ],
            },
          ],
        },
        label,
      )
    const a7b = await replay(sig, "a7b-replay-signed", 1500)
    const t7 = textOf(a7b.json)
    ok(
      "A7b 回放带签名 thinking + tool_result 被接受且按结果作答（含 28；tool_result 里的暗号指令模型可忽略，只记录）",
      a7b.status === 200 && /28/.test(t7),
      `HTTP ${a7b.status} stop=${a7b.json?.stop_reason} 提到 GUAVA=${/GUAVA/.test(t7)} ${t7.slice(0, 80) || a7b.text.slice(0, 140)}`,
    )
    const a7c = await replay("bad-signature", "a7c-replay-tampered", 1500)
    ok(
      "A7c 伪造签名 → 厂商原文 400（说明签名真被校验，网关没吞掉 thinking 块）",
      a7c.status === 400 && /signature|thinking/i.test(a7c.json?.error?.message ?? ""),
      `HTTP ${a7c.status} ${(a7c.json?.error?.message ?? a7c.text).slice(0, 140)}`,
    )
  }

  // A8 多轮工具调用的密钥注入（GitHub cloudflare/ai#408 报偶发失效）：同一会话连做 6 轮工具往返 + 4 个并发请求
  const addOne = [
    {
      name: "add_one",
      description: "Add one to n",
      input_schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    },
  ]
  const history = [
    {
      role: "user",
      content:
        "Start from 0. Call add_one repeatedly as instructed; when finally asked, reply with the last result and the codeword STARFRUIT in one line.",
    },
  ]
  let n = 0
  let authFailures = 0
  let roundsOk = 0
  for (let round = 1; round <= 6; round++) {
    const stream = round % 2 === 0
    const r = await post(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 200,
        stream,
        tools: addOne,
        tool_choice: { type: "tool", name: "add_one" },
        messages: history,
      },
      `a8-round${round}${stream ? "-stream" : ""}`,
    )
    if (r.status === 401 || r.status === 403) authFailures++
    let content
    if (stream) {
      // 从流里拼回 assistant content（只需要 tool_use 块）
      const start = r.events.find(
        (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use",
      )?.content_block
      const args = r.events
        .filter((e) => e.delta?.type === "input_json_delta")
        .map((e) => e.delta.partial_json)
        .join("")
      content = start
        ? [{ type: "tool_use", id: start.id, name: start.name, input: safeJson(args) ?? {} }]
        : undefined
    } else {
      content = r.json?.content
    }
    const call1 = content?.find((c) => c.type === "tool_use")
    if (r.status !== 200 || !call1) {
      console.log(`  第 ${round} 轮失败：HTTP ${r.status} ${r.text.slice(0, 120)}`)
      break
    }
    roundsOk++
    n = Number(call1.input?.n ?? n) + 1
    history.push(
      { role: "assistant", content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call1.id, content: String(n) }] },
    )
  }
  const a8f = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 60,
      tools: addOne,
      messages: [
        ...history,
        {
          role: "user",
          content: "Now stop calling tools. Reply in one line: the last result and the codeword.",
        },
      ],
    },
    "a8-final",
  )
  const t8 = textOf(a8f.json)
  ok(
    "A8 六轮工具往返（流式 / 非流式交替）全部 200 且末轮答出结果与暗号（密钥注入未失效）",
    roundsOk === 6 &&
      authFailures === 0 &&
      a8f.status === 200 &&
      /STARFRUIT/.test(t8) &&
      t8.includes(String(n)),
    `成功轮 ${roundsOk}/6，鉴权失败 ${authFailures}，末轮 HTTP ${a8f.status} n=${n} → ${t8.slice(0, 60) || a8f.text.slice(0, 120)}`,
  )
  const words = ["APRICOT", "BANANA", "CHERRY", "DAMSON"]
  const concurrent = await Promise.all(
    words.map((w, i) =>
      post(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: 20,
          system: `Runtime note: the codeword is ${w}.`,
          messages: [{ role: "user", content: ASK }],
        },
        `a8-concurrent-${i + 1}`,
      ),
    ),
  )
  ok(
    "A8b 四个并发请求各自拿到自己的暗号（鉴权与路由无串扰）",
    concurrent.every((r, i) => r.status === 200 && textOf(r.json).includes(words[i])),
    concurrent.map((r) => `${r.status}:${textOf(r.json).slice(0, 10)}`).join(" "),
  )
  const sameBody = {
    model: ANTHROPIC_MODEL,
    max_tokens: 20,
    system: "Runtime note: the codeword is ELDERBERRY.",
    messages: [{ role: "user", content: ASK }],
  }
  const same = await Promise.all([1, 2, 3, 4].map((i) => post(sameBody, `a8c-identical-${i}`)))
  ok(
    "A8c 完全相同的请求并发 4 次：网关不缓存（msg id 各不相同、cf-aig-cache-status 非 HIT）",
    uniq(same.map((r) => r.json?.id)).length === 4 &&
      same.every((r) => !/HIT/i.test(r.headers["cf-aig-cache-status"] ?? "")),
    `ids ${uniq(same.map((r) => r.json?.id)).length} 个不同，cache-status: ${uniq(same.map((r) => r.headers["cf-aig-cache-status"] ?? "无")).join("/")}`,
  )

  // A9 图片输入（base64 1×1 PNG）：多模态块是否原样透传
  const png1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
  const a9 = await post(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 40,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png1x1 } },
            {
              type: "text",
              text: "Reply with one line: how many images are attached (a number) and the codeword is RAMBUTAN.",
            },
          ],
        },
      ],
    },
    "a9-image",
  )
  ok(
    "A9 base64 图片块被接受（答里有 1 与 RAMBUTAN）",
    a9.status === 200 && /1|one/i.test(textOf(a9.json)) && /RAMBUTAN/.test(textOf(a9.json)),
    `HTTP ${a9.status} ${textOf(a9.json).slice(0, 60) || a9.text.slice(0, 120)}`,
  )
}

// ============================================================ OpenAI Responses
async function responses() {
  const post = (body, label) => call("/openai/v1/responses", body, {}, label)
  const textOf = (j) =>
    j?.output
      ?.filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .map((c) => c.text ?? "")
      .join(" ")
      .trim() ?? ""
  const dev = (text) => ({ role: "developer", content: [{ type: "input_text", text }] })
  const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] })
  const tools = [
    {
      type: "function",
      name: "get_weather",
      description: "Current weather of a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      strict: false,
    },
  ]

  // R1 顶层 developer 暗号 + 对照；响应形状
  const r0 = await post({ model: OPENAI_MODEL, store: false, input: [user(ASK)] }, "r0-none")
  ok(
    "R0 无暗号对照 → NONE",
    /NONE/i.test(textOf(r0.json)),
    `HTTP ${r0.status} ${textOf(r0.json).slice(0, 60) || r0.text.slice(0, 160)}`,
  )
  const r1 = await post(
    {
      model: OPENAI_MODEL,
      store: false,
      input: [dev("Runtime note: the codeword is PINEAPPLE."), user(ASK)],
    },
    "r1-developer-top",
  )
  ok(
    "R1 顶层 developer 暗号到达",
    /PINEAPPLE/.test(textOf(r1.json)),
    `HTTP ${r1.status} ${textOf(r1.json).slice(0, 60) || r1.text.slice(0, 160)}`,
  )
  ok(
    "R1 响应形状是厂商原生（id resp_… / status / usage.input_tokens_details.cached_tokens）",
    typeof r1.json?.id === "string" &&
      r1.json.id.startsWith("resp_") &&
      r1.json?.status === "completed" &&
      typeof r1.json?.usage?.input_tokens_details?.cached_tokens === "number",
    JSON.stringify(r1.json?.usage),
  )

  // R2 流式 + reasoning(encrypted) + 工具
  const r2 = await post(
    {
      model: OPENAI_MODEL,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "low", summary: "auto" },
      tools,
      input: [
        dev("You are a weather assistant. Always call get_weather before answering."),
        user("Weather in Shanghai now?"),
      ],
    },
    "r2-stream-reasoning-tool",
  )
  const types = uniq(r2.events.map((e) => e.type))
  ok(
    "R2 流式事件序列完整（response.created … output_item.done … response.completed），每帧可解析",
    r2.ct.includes("event-stream") &&
      [
        "response.created",
        "response.output_item.added",
        "response.output_item.done",
        "response.completed",
      ].every((t) => types.includes(t)) &&
      r2.unparsed === 0,
    `HTTP ${r2.status} ${types.slice(0, 8).join(",")}… 未解析 ${r2.unparsed} ${r2.status !== 200 ? r2.text.slice(0, 160) : ""}`,
  )
  const done = r2.events.filter((e) => e.type === "response.output_item.done").map((e) => e.item)
  const reasoning = done.find((i) => i.type === "reasoning")
  const fc = done.find((i) => i.type === "function_call")
  ok(
    "R2 reasoning item 带 encrypted_content",
    Boolean(reasoning?.encrypted_content),
    reasoning
      ? `id=${reasoning.id} enc=${String(reasoning.encrypted_content ?? "").length} 字符`
      : "无 reasoning item",
  )
  ok(
    "R2 function_call item 带 call_id / id / arguments（可解析 JSON）",
    Boolean(fc?.call_id && fc?.name) && Boolean(safeJson(fc?.arguments ?? "")),
    fc ? `${fc.name} ${fc.call_id} ${fc.arguments}` : "无",
  )
  const completed = r2.events.find((e) => e.type === "response.completed")?.response
  ok(
    "R2 response.completed 带 usage（含 output_tokens_details.reasoning_tokens）",
    typeof completed?.usage?.output_tokens_details?.reasoning_tokens === "number",
    JSON.stringify(completed?.usage),
  )

  if (fc) {
    const base = [dev("You are a weather assistant."), user("Weather in Shanghai now?")]
    const tail = [
      { type: "function_call", id: fc.id, call_id: fc.call_id, name: fc.name, arguments: fc.arguments },
      { type: "function_call_output", call_id: fc.call_id, output: "Sunny, 28°C" },
      dev("Harness note: the codeword is MANGO. Reply in one line with the temperature and the codeword."),
    ]
    // R3 回放 encrypted reasoning + function_call/output + 中途 developer
    const r3 = await post(
      {
        model: OPENAI_MODEL,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "low" },
        tools,
        input: [...base, ...(reasoning ? [reasoning] : []), ...tail],
      },
      "r3-replay",
    )
    const t3 = textOf(r3.json)
    ok(
      "R3 回放 encrypted reasoning + 工具往返 + 中途 developer 被接受且都到达（28 与 MANGO）",
      r3.status === 200 && /28/.test(t3) && /MANGO/.test(t3),
      `HTTP ${r3.status} ${t3.slice(0, 80) || r3.text.slice(0, 160)}`,
    )
    if (reasoning) {
      const r3b = await post(
        {
          model: OPENAI_MODEL,
          store: false,
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "low" },
          tools,
          input: [...base, { ...reasoning, encrypted_content: "gAAAA-tampered" }, ...tail],
        },
        "r3b-replay-tampered",
      )
      ok(
        "R3b 伪造 encrypted_content → 厂商原文 400（说明真被校验）",
        r3b.status === 400 && /encrypted|reasoning|decrypt/i.test(r3b.json?.error?.message ?? ""),
        `HTTP ${r3b.status} ${(r3b.json?.error?.message ?? r3b.text).slice(0, 140)}`,
      )
    }
  }

  // R4 缓存用量：>1024 token 同前缀两次，第二次 cached_tokens 应 >0（OpenAI 自动缓存）
  const r4a = await post(
    { model: OPENAI_MODEL, store: false, input: [dev(LONG_SYSTEM), user("Say hi.")] },
    "r4a-cache-first",
  )
  const r4b = await post(
    { model: OPENAI_MODEL, store: false, input: [dev(LONG_SYSTEM), user("Say hi again.")] },
    "r4b-cache-second",
  )
  ok(
    "R4 自动缓存用量透传：第二次 input_tokens_details.cached_tokens > 0",
    (r4b.json?.usage?.input_tokens_details?.cached_tokens ?? 0) > 0,
    `首发 ${JSON.stringify(r4a.json?.usage?.input_tokens_details)} → 复发 ${JSON.stringify(r4b.json?.usage?.input_tokens_details)}`,
  )

  // R5 多轮工具往返的密钥注入（同 A8）
  const addOne = [
    {
      type: "function",
      name: "add_one",
      description: "Add one to n",
      parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      strict: false,
    },
  ]
  const history = [
    user(
      "Start from 0. Call add_one repeatedly as instructed; when finally asked, reply with the last result and the codeword STARFRUIT in one line.",
    ),
  ]
  let n = 0
  let roundsOk = 0
  let authFailures = 0
  for (let round = 1; round <= 6; round++) {
    const stream = round % 2 === 0
    const r = await post(
      {
        model: OPENAI_MODEL,
        store: false,
        stream,
        tools: addOne,
        tool_choice: { type: "function", name: "add_one" },
        input: history,
      },
      `r5-round${round}${stream ? "-stream" : ""}`,
    )
    if (r.status === 401 || r.status === 403) authFailures++
    const items = stream
      ? r.events.filter((e) => e.type === "response.output_item.done").map((e) => e.item)
      : (r.json?.output ?? [])
    const c = items.find((i) => i.type === "function_call")
    if (r.status !== 200 || !c) {
      console.log(`  第 ${round} 轮失败：HTTP ${r.status} ${r.text.slice(0, 120)}`)
      break
    }
    roundsOk++
    n = Number(safeJson(c.arguments)?.n ?? n) + 1
    history.push(
      { type: "function_call", id: c.id, call_id: c.call_id, name: c.name, arguments: c.arguments },
      { type: "function_call_output", call_id: c.call_id, output: String(n) },
    )
  }
  const r5f = await post(
    {
      model: OPENAI_MODEL,
      store: false,
      tools: addOne,
      input: [
        ...history,
        user("Now stop calling tools. Reply in one line: the last result and the codeword."),
      ],
    },
    "r5-final",
  )
  const t5 = textOf(r5f.json)
  ok(
    "R5 六轮工具往返（流式 / 非流式交替）全部 200 且末轮答出结果与暗号",
    roundsOk === 6 &&
      authFailures === 0 &&
      r5f.status === 200 &&
      /STARFRUIT/.test(t5) &&
      t5.includes(String(n)),
    `成功轮 ${roundsOk}/6，鉴权失败 ${authFailures}，末轮 HTTP ${r5f.status} n=${n} → ${t5.slice(0, 60) || r5f.text.slice(0, 120)}`,
  )

  // R6 图片输入
  const png1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
  const r6 = await post(
    {
      model: OPENAI_MODEL,
      store: false,
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/png;base64,${png1x1}`, detail: "low" },
            {
              type: "input_text",
              text: "Reply with one line: how many images are attached (a number) and the codeword is RAMBUTAN.",
            },
          ],
        },
      ],
    },
    "r6-image",
  )
  ok(
    "R6 data: URL 图片被接受（答里有 1 与 RAMBUTAN）",
    r6.status === 200 && /1|one/i.test(textOf(r6.json)) && /RAMBUTAN/.test(textOf(r6.json)),
    `HTTP ${r6.status} ${textOf(r6.json).slice(0, 60) || r6.text.slice(0, 120)}`,
  )

  // R7 错误原文透传：不存在的模型
  const r7 = await post({ model: "gpt-reins-nonexistent", store: false, input: "hi" }, "r7-bad-model")
  ok(
    "R7 记录：不存在的模型 → 厂商原文错误透传（实测是 401 Missing bearer：网关只对认识的模型注入密钥）",
    r7.status >= 400 && typeof r7.json?.error?.message === "string",
    `HTTP ${r7.status} ${JSON.stringify(r7.json?.error ?? r7.text.slice(0, 120)).slice(0, 140)}`,
  )
}

// ============================================================ OpenAI Chat Completions
async function chat() {
  const post = (body, label) => call("/openai/v1/chat/completions", body, {}, label)
  const textOf = (j) => (j?.choices?.[0]?.message?.content ?? "").trim()
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Current weather of a city",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ]

  const c1 = await post(
    {
      model: CHAT_MODEL,
      max_tokens: 30,
      messages: [
        { role: "system", content: "Runtime note: the codeword is PINEAPPLE." },
        { role: "user", content: ASK },
      ],
    },
    "c1-system",
  )
  ok(
    "C1 system 暗号到达",
    /PINEAPPLE/.test(textOf(c1.json)),
    `HTTP ${c1.status} ${textOf(c1.json).slice(0, 60) || c1.text.slice(0, 160)}`,
  )
  ok(
    "C1 响应形状是厂商原生（id chatcmpl-… / usage.prompt_tokens）",
    typeof c1.json?.id === "string" &&
      c1.json.id.startsWith("chatcmpl") &&
      typeof c1.json?.usage?.prompt_tokens === "number",
    JSON.stringify(c1.json?.usage),
  )

  const c2 = await post(
    {
      model: CHAT_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      tools,
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [{ role: "user", content: "Weather in Shanghai now?" }],
    },
    "c2-stream-tool",
  )
  const chunks = c2.events.filter((e) => e.object === "chat.completion.chunk")
  const tc = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  const first = tc.find((t) => t.id)
  const args = tc.map((t) => t.function?.arguments ?? "").join("")
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).find(Boolean)
  const usage = chunks.find((c) => c.usage)?.usage
  ok(
    "C2 流式 chunk + delta.tool_calls 分片可拼 JSON + finish_reason（强制 tool_choice 时官方回 stop 而非 tool_calls）+ 末尾 usage chunk，每帧可解析",
    c2.ct.includes("event-stream") &&
      Boolean(first?.id && first?.function?.name) &&
      Boolean(safeJson(args)) &&
      ["tool_calls", "stop"].includes(finish) &&
      typeof usage?.prompt_tokens === "number" &&
      c2.unparsed === 0,
    `HTTP ${c2.status} ${first?.function?.name} ${args.slice(0, 40)} finish=${finish} usage=${JSON.stringify(usage)} 未解析 ${c2.unparsed} ${c2.status !== 200 ? c2.text.slice(0, 120) : ""}`,
  )
  if (first) {
    const c3 = await post(
      {
        model: CHAT_MODEL,
        max_tokens: 60,
        tools,
        messages: [
          { role: "user", content: "Weather in Shanghai now?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: first.id, type: "function", function: { name: "get_weather", arguments: args } },
            ],
          },
          { role: "tool", tool_call_id: first.id, content: "Sunny, 28°C" },
          {
            role: "system",
            content:
              "Harness note: the codeword is MANGO. Reply in one line with the temperature and the codeword.",
          },
        ],
      },
      "c3-tool-role-then-mid-system",
    )
    const t3 = textOf(c3.json)
    ok(
      "C3 tool 角色回传 + 末尾中途 system 都到达（28 与 MANGO）",
      c3.status === 200 && /28/.test(t3) && /MANGO/.test(t3),
      `HTTP ${c3.status} ${t3.slice(0, 80) || c3.text.slice(0, 160)}`,
    )
  }
  const c4 = await post(
    { model: CHAT_MODEL, max_tokens: 30, messages: [{ role: "user", content: "hi" }], bogus_param_reins: 1 },
    "c4-unknown-param",
  )
  ok(
    "C4 未知参数 → 厂商原文 400（错误透传）",
    c4.status === 400 && /bogus_param_reins/.test(c4.json?.error?.message ?? ""),
    `HTTP ${c4.status} ${(c4.json?.error?.message ?? c4.text).slice(0, 140)}`,
  )
}

const suites = { anthropic, responses, chat }
const picked = which === "all" ? Object.keys(suites) : suites[which] ? [which] : null
if (!picked) {
  console.error("用法：node spikes/cf-gateway-fidelity/probe.mjs <anthropic|responses|chat|all>")
  process.exit(2)
}
for (const name of picked) {
  console.log(`\n=== ${name} ===`)
  const before = results.length
  try {
    await suites[name]()
  } catch (e) {
    ok(`${name} 套件异常中止`, false, String(e?.message ?? e).slice(0, 200))
  }
  const part = results.slice(before)
  console.log(`${name}: ${part.filter((r) => r.pass).length}/${part.length} 通过`)
}
const fails = results.filter((r) => !r.pass)
console.log(
  `\n合计 ${results.length - fails.length}/${results.length} 通过；途中撞 CF 账户级限流 ${rateLimited} 次`,
)
if (fails.length) process.exitCode = 1
