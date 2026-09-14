/**
 * L1：lazy-tools 的 provider 原生路径核实——Anthropic 官方 `defer_loading` + 自定义工具结果里的 `tool_reference`（GA，无 beta 头）。
 *
 * 要回答的问题（全部按产出内容判，不看状态码）：
 *   P1 只标 defer_loading、不带服务端 tool search 工具时，被延迟的工具对模型是否真不可见（我们的菜单是否必要）；
 *   P2 自定义 tool_find 的 tool_result 里放 [text, tool_reference] 混合内容，模型能否随即调用被展开的工具；
 *      取回后的第 2、3 个请求 cache_read 是否 > 0（工具表整段不变 → 前缀缓存保住）；
 *   P3 对照臂：老路子（取回后把完整定义加进 tools 块）第 2 个请求 cache_read 是否归零（复现 D1 结论）；
 *   P4 cache_control 打在 defer_loading 工具上是否 400（断点必须落在非延迟工具上）；
 *   P5 tool_reference 指向 tools[] 里没有的名字是否 400（降级层必须兜底）；
 *   P6 全部工具都 defer_loading 是否 400；
 *   P7 取回过的工具在后续轮次能否直接调用（API 在整段历史里展开引用）；
 *   P8 历史里含已移除工具的 tool_use / tool_result：(a) 工具表还有别的工具 (b) 不带 tools 两种变体官方是否接受（TASKS 里那条"未测"）；
 *      (c) 历史里 tool_reference 指向已移除工具（预期 400，与 P5 同源）。
 *   deepseek 靶子只跑 P1 / P2：看第三方 Anthropic 兼容端口对 defer_loading / tool_reference 的态度，决定能力位缺省。
 *
 * 运行：`node spikes/l1-deferred-tools/probe.mjs [haiku|opus|deepseek|all]`；配置自动从《模型API测试信息.md》读。
 * 原始请求 / 响应写 out/（gitignore）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const cfToken = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
const cfAccount = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
const cfGateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
const deepseekKey = info.match(/deepseek官方[\s\S]{0,40}?(sk-[A-Za-z0-9]{20,})/)?.[1]
if (!cfToken || !cfAccount) throw new Error("信息文件里缺 CF 令牌 / account id")

const outDir = new URL("./out/", import.meta.url)
await mkdir(outDir, { recursive: true })

const TARGETS = {
  haiku: {
    url: `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/anthropic/v1/messages`,
    headers: { "cf-aig-authorization": `Bearer ${cfToken}`, "anthropic-version": "2023-06-01" },
    model: process.env.L1_HAIKU_MODEL ?? "claude-haiku-4-5-20251001",
    /** Haiku 4.5 最小可缓存 4096 token */
    padRepeats: 1100,
    full: true,
  },
  opus: {
    url: `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/anthropic/v1/messages`,
    headers: { "cf-aig-authorization": `Bearer ${cfToken}`, "anthropic-version": "2023-06-01" },
    model: process.env.L1_OPUS_MODEL ?? "claude-opus-5",
    padRepeats: 300,
    full: true,
  },
  deepseek: {
    url: "https://api.deepseek.com/anthropic/v1/messages",
    headers: { "x-api-key": deepseekKey ?? "", "anthropic-version": "2023-06-01" },
    model: "deepseek-v4-flash",
    padRepeats: 300,
    full: false,
  },
}

const which = process.argv[2] ?? "all"
const names = which === "all" ? Object.keys(TARGETS) : [which]

// ---- 工具表：一个非延迟的 tool_find（我们自己的取回工具）+ 三件 defer_loading 的菜单工具 ----
const TOOL_FIND = {
  name: "tool_find",
  description:
    'Load tools from the on-request list so you can call them. `names` are tool names exactly as listed under "Tools available on request". The loaded tools become callable right after the result.',
  input_schema: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" }, minItems: 1 } },
    required: ["names"],
    additionalProperties: false,
  },
}
const GET_WEATHER = {
  name: "get_weather",
  description: "Get the current weather at a location",
  input_schema: {
    type: "object",
    properties: { location: { type: "string", description: "City name" } },
    required: ["location"],
  },
}
const SEARCH_FILES = {
  name: "search_files",
  description: "Search through files in the workspace by keyword",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
}
const CHECK_STOCK = {
  name: "check_stock",
  description: "Check the stock level of an item in the warehouse",
  input_schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
}
const LOOKUP_PRICE = {
  name: "lookup_price",
  description: "Look up the unit price (USD) of an item",
  input_schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
}
const MENU_TOOLS = [GET_WEATHER, SEARCH_FILES, CHECK_STOCK]
const deferred = (t) => ({ ...t, defer_loading: true })
const cc = { type: "ephemeral" }

const MENU = `## Tools available on request
The tools listed below are bound to this session but not loaded yet: only a name and a one-line summary are shown, and they cannot be called until loaded.
- Before starting work that needs one of them, call \`tool_find({ names: [...] })\` with every listed tool the task will need, in one call. Each loaded tool then appears in your tool list.
- Do not guess a listed tool's parameters from its summary; load it first.

Available on request:
- check_stock: Check the stock level of an item in the warehouse
- get_weather: Get the current weather at a location
- search_files: Search through files in the workspace by keyword`

const SALT = `run-${Date.now().toString(36)}`
const pad = (n) => `You are a terse assistant (session ${SALT}).\n${"Rule: be exact and brief. ".repeat(n)}\n`

// ---- HTTP：CF 账户级 429 / 厂商 529 退避重试；其余原样返回 { status, json, text } ----
async function post(target, body, label) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...target.headers },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if ((res.status === 429 && /Rate limited/i.test(text)) || res.status === 529) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 4000 * attempt
      console.log(`  (${label} 第 ${attempt} 次 ${res.status}，${wait}ms 后重试)`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    await writeFile(
      new URL(`./${label}.json`, outDir),
      JSON.stringify({ body, status: res.status, json: json ?? text }, null, 1),
    )
    return { status: res.status, json, text }
  }
  throw new Error(`${label}：重试耗尽`)
}

const textOf = (msg) =>
  (msg?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
const toolUses = (msg) => (msg?.content ?? []).filter((b) => b.type === "tool_use")
const usage = (msg) => ({
  input: msg?.usage?.input_tokens ?? 0,
  cacheRead: msg?.usage?.cache_read_input_tokens ?? 0,
  cacheWrite: msg?.usage?.cache_creation_input_tokens ?? 0,
})
const errMsg = (r) => r.json?.error?.message ?? r.text.slice(0, 200)
/** 与降级层同一规则：块级断点只打在最后一条 user 的末块上；追加新 user 前把历史 user 块上的断点摘掉 */
const clearUserBreakpoints = (messages) => {
  for (const m of messages) if (m.role === "user") for (const b of m.content) delete b.cache_control
}

async function run(name) {
  const t = TARGETS[name]
  const checks = []
  const check = (label, ok, detail) => checks.push([label, ok, detail])
  const base = { model: t.model, max_tokens: 1024 }
  const tag = (s) => `${name}-${s}`

  // ---- P1 可见性：无菜单的短 system，问模型此刻能调哪些工具 ----
  {
    const r = await post(
      t,
      {
        ...base,
        system: "You are a terse assistant.",
        tools: [TOOL_FIND, ...MENU_TOOLS.map(deferred)],
        messages: [
          {
            role: "user",
            content:
              "List the exact names of every tool in your tool definitions right now, comma-separated, nothing else. Do not call any tool.",
          },
        ],
      },
      tag("p1-visibility"),
    )
    const txt = textOf(r.json)
    const seesHidden = MENU_TOOLS.some((m) => txt.includes(m.name))
    check(
      "P1 defer_loading 被接受（200），且被延迟的三件工具对模型不可见、只看见 tool_find",
      r.status === 200 && txt.includes("tool_find") && !seesHidden,
      `status=${r.status} text=${JSON.stringify(txt.slice(0, 160))} ${r.status !== 200 ? errMsg(r) : ""}`,
    )
  }

  // ---- P2 原生臂：菜单 + tool_find → tool_result 带 tool_reference → 调用被展开的工具；量三次请求的缓存 ----
  const systemLong = [{ type: "text", text: `${pad(t.padRepeats)}\n${MENU}`, cache_control: cc }]
  const nativeTools = [{ ...TOOL_FIND, cache_control: cc }, ...MENU_TOOLS.map(deferred)]
  let nativeHistory = null
  const nativeUsages = []
  {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is the weather in Paris right now? Use the tools.", cache_control: cc },
        ],
      },
    ]
    const r1 = await post(t, { ...base, system: systemLong, tools: nativeTools, messages }, tag("p2-req1"))
    const u1 = toolUses(r1.json)
    const findCall = u1.find((u) => u.name === "tool_find")
    check(
      "P2.1 模型先调 tool_find 且 names 含 get_weather",
      r1.status === 200 && !!findCall && (findCall.input.names ?? []).includes("get_weather"),
      `status=${r1.status} uses=${JSON.stringify(u1.map((u) => [u.name, u.input]))} ${r1.status !== 200 ? errMsg(r1) : ""}`,
    )
    nativeUsages.push(usage(r1.json))
    if (findCall) {
      messages.push({ role: "assistant", content: r1.json.content })
      const loaded = (findCall.input.names ?? []).filter((n) => MENU_TOOLS.some((m) => m.name === n))
      const mixed = [
        { type: "text", text: `Loaded ${loaded.length} tool(s); callable from now on.` },
        ...loaded.map((n) => ({ type: "tool_reference", tool_name: n })),
      ]
      // 三种形态依次试，记录各自态度：A 混合内容 + 块级断点；B 纯引用 + 块级断点；C 纯引用块 + 同条 user 里跟一段文本
      const refs = loaded.map((n) => ({ type: "tool_reference", tool_name: n }))
      const noteText = `[tool_find] Loaded ${loaded.length} tool(s); callable from now on. Not on the on-request list: none.`
      const shapes = [
        [
          "A 混合（text+ref）+ 断点",
          [{ type: "tool_result", tool_use_id: findCall.id, content: mixed, cache_control: cc }],
        ],
        [
          "B 纯引用 + 断点",
          [{ type: "tool_result", tool_use_id: findCall.id, content: refs, cache_control: cc }],
        ],
        [
          "C 纯引用块后、同条 user 里跟一段说明文本",
          [
            { type: "tool_result", tool_use_id: findCall.id, content: refs },
            { type: "text", text: noteText, cache_control: cc },
          ],
        ],
        [
          "D 说明文本夹在两个 tool_result 之间（并行调用时的真实形状）",
          [
            { type: "tool_result", tool_use_id: findCall.id, content: refs },
            { type: "text", text: noteText },
            {
              type: "tool_result",
              tool_use_id: "toolu_l1_fake_parallel",
              content: [{ type: "text", text: "ok" }],
              cache_control: cc,
            },
          ],
        ],
      ]
      const shapeNotes = []
      const outcomes = []
      for (const [label, blocks] of shapes) {
        // D 需要历史里真有第二个 tool_use，临时补一条并行调用再发
        const msgs = structuredClone(messages)
        if (label.startsWith("D")) {
          msgs[msgs.length - 1] = {
            role: "assistant",
            content: [
              ...r1.json.content,
              {
                type: "tool_use",
                id: "toolu_l1_fake_parallel",
                name: "tool_find",
                input: { names: ["search_files"] },
              },
            ],
          }
        }
        msgs.push({ role: "user", content: blocks })
        const r = await post(
          t,
          { ...base, system: systemLong, tools: nativeTools, messages: msgs },
          tag(`p2-req2-${label[0]}`),
        )
        shapeNotes.push(`${label} → ${r.status}${r.status === 200 ? "" : ` ${errMsg(r)}`}`)
        outcomes.push([label, r, msgs])
      }
      // 继续用 B（纯引用 + 断点）：它是降级层的缺省形状
      const chosen =
        outcomes.find(([label, r]) => label.startsWith("B") && r.status === 200) ??
        outcomes.find(([, r]) => r.status === 200)
      const r2 = chosen?.[1] ?? outcomes[0][1]
      if (chosen) {
        messages.length = 0
        messages.push(...chosen[2])
      }
      const mixedNote = shapeNotes.join("；")
      const u2 = toolUses(r2.json)
      const weatherCall = u2.find((u) => u.name === "get_weather")
      check(
        "P2.2 取回后模型随即调用被展开的 get_weather（入参含 Paris）",
        r2.status === 200 && !!weatherCall && /paris/i.test(JSON.stringify(weatherCall.input)),
        `status=${r2.status} uses=${JSON.stringify(u2.map((u) => [u.name, u.input]))} text=${JSON.stringify(textOf(r2.json).slice(0, 120))} ${r2.status !== 200 ? errMsg(r2) : ""}`,
      )
      check(
        "P2.2b 取回结果的四种形态（预期 A 被拒；B / C / D 的态度决定降级层落法）",
        r2.status === 200,
        mixedNote,
      )
      nativeUsages.push(usage(r2.json))
      if (weatherCall) {
        messages.push({ role: "assistant", content: r2.json.content })
        clearUserBreakpoints(messages)
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: weatherCall.id,
              content: [{ type: "text", text: "22°C, sunny, light wind" }],
              cache_control: cc,
            },
          ],
        })
        const r3 = await post(
          t,
          { ...base, system: systemLong, tools: nativeTools, messages },
          tag("p2-req3"),
        )
        check(
          "P2.3 最终答案含 22",
          r3.status === 200 && /22/.test(textOf(r3.json)),
          `status=${r3.status} text=${JSON.stringify(textOf(r3.json).slice(0, 120))} ${r3.status !== 200 ? errMsg(r3) : ""}`,
        )
        nativeUsages.push(usage(r3.json))
        if (r3.status === 200) {
          messages.push({ role: "assistant", content: r3.json.content })
          nativeHistory = messages
        }
      }
    }
    check(
      "P2.4 取回后的第 2、3 个请求 cache_read > 0（工具表整段不变，前缀缓存保住）",
      nativeUsages.length >= 3 && nativeUsages.slice(1).every((u) => u.cacheRead > 0),
      JSON.stringify(nativeUsages),
    )
  }

  if (!t.full) {
    report(name, t, checks)
    return
  }

  // ---- P3 对照臂（老路子）：tools 起初只有 tool_find，取回后把 get_weather 完整定义加进 tools 块 ----
  {
    const legacyUsages = []
    const tools1 = [{ ...TOOL_FIND, cache_control: cc }]
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is the weather in Paris right now? Use the tools.", cache_control: cc },
        ],
      },
    ]
    const r1 = await post(t, { ...base, system: systemLong, tools: tools1, messages }, tag("p3-req1"))
    legacyUsages.push(usage(r1.json))
    const findCall = toolUses(r1.json).find((u) => u.name === "tool_find")
    if (findCall) {
      messages.push({ role: "assistant", content: r1.json.content })
      clearUserBreakpoints(messages)
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: findCall.id,
            content: [
              {
                type: "text",
                text: `Loaded 1 tool; callable from your next turn on.\n\n### get_weather\n${GET_WEATHER.description}\nInput schema: ${JSON.stringify(GET_WEATHER.input_schema)}`,
              },
            ],
            cache_control: cc,
          },
        ],
      })
      const tools2 = [TOOL_FIND, { ...GET_WEATHER, cache_control: cc }]
      const r2 = await post(t, { ...base, system: systemLong, tools: tools2, messages }, tag("p3-req2"))
      legacyUsages.push(usage(r2.json))
      const weatherCall = toolUses(r2.json).find((u) => u.name === "get_weather")
      if (weatherCall) {
        messages.push({ role: "assistant", content: r2.json.content })
        clearUserBreakpoints(messages)
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: weatherCall.id,
              content: [{ type: "text", text: "22°C, sunny" }],
              cache_control: cc,
            },
          ],
        })
        const r3 = await post(t, { ...base, system: systemLong, tools: tools2, messages }, tag("p3-req3"))
        legacyUsages.push(usage(r3.json))
      }
    }
    const nativeR2 = nativeUsages[1]
    const legacyR2 = legacyUsages[1]
    check(
      "P3 对照：老路子取回后第 2 个请求 cache_read 归零（工具表变了整段重写），原生臂同一位置 cache_read > 0",
      !!nativeR2 && !!legacyR2 && legacyR2.cacheRead === 0 && nativeR2.cacheRead > 0,
      `native=${JSON.stringify(nativeUsages)} legacy=${JSON.stringify(legacyUsages)}`,
    )
  }

  // ---- P4 cache_control 打在 defer_loading 工具上 ----
  {
    const r = await post(
      t,
      {
        ...base,
        tools: [TOOL_FIND, { ...deferred(GET_WEATHER), cache_control: cc }],
        messages: [{ role: "user", content: "Say hi." }],
      },
      tag("p4-cc-on-deferred"),
    )
    check(
      "P4 cache_control 打在 defer_loading 工具上 → 400",
      r.status === 400,
      `status=${r.status} ${errMsg(r)}`,
    )
  }

  // ---- P5 tool_reference 指向 tools[] 里没有的名字 ----
  {
    const r = await post(
      t,
      {
        ...base,
        tools: [TOOL_FIND, deferred(GET_WEATHER)],
        messages: [
          { role: "user", content: "Check stock of item A." },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_l1_01", name: "tool_find", input: { names: ["check_stock"] } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_l1_01",
                content: [{ type: "tool_reference", tool_name: "check_stock" }],
              },
            ],
          },
        ],
      },
      tag("p5-unbound-ref"),
    )
    check(
      "P5 tool_reference 指向不在 tools[] 的名字 → 400（降级层须兜底成文本）",
      r.status === 400,
      `status=${r.status} ${errMsg(r)}`,
    )
  }

  // ---- P6 全部 defer_loading ----
  {
    const r = await post(
      t,
      { ...base, tools: MENU_TOOLS.map(deferred), messages: [{ role: "user", content: "Say hi." }] },
      tag("p6-all-deferred"),
    )
    check("P6 全部工具 defer_loading → 400", r.status === 400, `status=${r.status} ${errMsg(r)}`)
  }

  // ---- P7 后续轮次直接调用取回过的工具 ----
  if (nativeHistory) {
    const messages = structuredClone(nativeHistory)
    clearUserBreakpoints(messages)
    messages.push({ role: "user", content: [{ type: "text", text: "And in Tokyo?", cache_control: cc }] })
    const r = await post(t, { ...base, system: systemLong, tools: nativeTools, messages }, tag("p7-reuse"))
    const u = toolUses(r.json)
    check(
      "P7 新一轮直接调用 get_weather（不再 tool_find；API 在整段历史里展开引用）且 cache_read > 0",
      r.status === 200 &&
        u.some((x) => x.name === "get_weather" && /tokyo/i.test(JSON.stringify(x.input))) &&
        usage(r.json).cacheRead > 0,
      `status=${r.status} uses=${JSON.stringify(u.map((x) => [x.name, x.input]))} usage=${JSON.stringify(usage(r.json))} ${r.status !== 200 ? errMsg(r) : ""}`,
    )
  }

  // ---- P8 历史含已移除工具 ----
  {
    const history = [
      { role: "user", content: "How many units of item A are in stock?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_l1_11", name: "check_stock", input: { item: "A" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_l1_11",
            content: [{ type: "text", text: '{"item":"A","stock":3}' }],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Item A has 3 units in stock." }] },
    ]
    const ra = await post(
      t,
      {
        ...base,
        tools: [LOOKUP_PRICE],
        messages: [
          ...history,
          { role: "user", content: "Now look up the unit price of item B with the tool." },
        ],
      },
      tag("p8a-removed-other-tools"),
    )
    check(
      "P8a 历史含已移除工具 check_stock、工具表只剩 lookup_price → 接受，且模型调 lookup_price",
      ra.status === 200 && toolUses(ra.json).some((u) => u.name === "lookup_price"),
      `status=${ra.status} uses=${JSON.stringify(toolUses(ra.json).map((u) => u.name))} text=${JSON.stringify(textOf(ra.json).slice(0, 100))} ${ra.status !== 200 ? errMsg(ra) : ""}`,
    )
    const rb = await post(
      t,
      {
        ...base,
        messages: [
          ...history,
          { role: "user", content: "How many units of item A did we find? Answer with the number only." },
        ],
      },
      tag("p8b-removed-no-tools"),
    )
    check(
      "P8b 历史含已移除工具、请求不带 tools → 接受且答出 3",
      rb.status === 200 && /3/.test(textOf(rb.json)),
      `status=${rb.status} text=${JSON.stringify(textOf(rb.json).slice(0, 100))} ${rb.status !== 200 ? errMsg(rb) : ""}`,
    )
    const rc = await post(
      t,
      {
        ...base,
        tools: [TOOL_FIND, deferred(GET_WEATHER)],
        messages: [
          { role: "user", content: "How many units of item A are in stock?" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_l1_21", name: "tool_find", input: { names: ["check_stock"] } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_l1_21",
                content: [{ type: "tool_reference", tool_name: "check_stock" }],
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_l1_22", name: "check_stock", input: { item: "A" } }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_l1_22",
                content: [{ type: "text", text: '{"item":"A","stock":3}' }],
              },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "Item A has 3 units in stock." }] },
          { role: "user", content: "How many units of item A did we find? Answer with the number only." },
        ],
      },
      tag("p8c-removed-ref"),
    )
    check(
      "P8c 历史里 tool_reference 指向已移除工具 → 400（历史里的引用也会被校验，降级层兜底要覆盖历史）",
      rc.status === 400,
      `status=${rc.status} ${rc.status === 400 ? errMsg(rc) : JSON.stringify(textOf(rc.json).slice(0, 80))}`,
    )
  }

  report(name, t, checks)
}

function report(name, t, checks) {
  console.log(`\n=== ${name} (${t.model}) ===`)
  let pass = 0
  for (const [label, ok, detail] of checks) {
    pass += ok ? 1 : 0
    console.log(`${ok ? "✓" : "✗"} ${label}\n    ${detail}`)
  }
  console.log(`—— ${pass}/${checks.length}`)
}

for (const n of names) {
  if (!TARGETS[n]) throw new Error(`未知靶子 ${n}`)
  await run(n)
}
