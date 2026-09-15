/**
 * fetch 版探针产出的**自动内容核对**（F4）：HTTP 200 从不等于探测通过，逐项对产出。
 * 原本内嵌在 run.mjs 里，2026-09-15 抽出来给 runtime-matrix 共用——判据只有一份，各运行时的结论才可比。
 */

/** 一条 tool_call 草稿是否是"调 get_weather 查上海"：入参里 city 含"上海"或 Shanghai（模型可能翻译城市名） */
export const weatherCall = (body) =>
  (body?.草稿 ?? []).find(
    (d) =>
      d.type === "core.tool_call" &&
      d.payload?.name === "get_weather" &&
      /上海|shanghai/i.test(String(d.payload?.args?.city ?? "")),
  )

/** 返回 { 通过, 说明 }；x 为 null 表示这一格没跑（跳过），HTTP 非 200 直接判不过 */
export function checkFetch(kind, x) {
  if (x === null || x === undefined) return { 通过: null, 说明: "跳过" }
  if (x.status !== 200) return { 通过: false, 说明: `HTTP ${x.status}` }
  const b = x.body ?? {}
  const fails = []
  if (kind === "load") {
    const apis = b.有损矩阵覆盖的协议 ?? []
    for (const api of ["openai-chat", "anthropic-messages", "openai-responses"]) {
      if (!apis.includes(api)) fails.push(`矩阵缺 ${api}`)
      const line = b.三条线?.[api]
      if (line?.工具数 !== 1) fails.push(`${api} 工具数 ${line?.工具数}`)
      if (line?.非exact落点?.length) fails.push(`${api} 有非 exact 落点`)
    }
  } else {
    const call = weatherCall(b)
    if (!call) fails.push("没有 get_weather(上海) 的 tool_call 草稿")
    if (b.收尾?.stopReason !== "toolUse")
      fails.push(`stopReason=${b.收尾?.stopReason}${b.收尾?.errorMessage ? ` (${b.收尾.errorMessage})` : ""}`)
    if (!(b.收尾?.usage?.output > 0)) fails.push(`output 用量 ${b.收尾?.usage?.output}`)
    if (kind === "fake") {
      // 假端点给的定值：签名 base64 40 字符、usage 123 / 42、入参切成两段 input_json_delta 且含中文
      const thinking = (b.草稿 ?? []).find((d) => d.type === "core.model_thinking")
      if (thinking?.thinking签名长度 !== 40) fails.push(`thinking 签名长度 ${thinking?.thinking签名长度}`)
      if (call && call.payload.args.city !== "上海")
        fails.push(`入参 city=${JSON.stringify(call.payload.args.city)}（UTF-8 乱切重组失败）`)
      if (b.收尾?.usage?.input !== 123 || b.收尾?.usage?.output !== 42)
        fails.push(`usage ${JSON.stringify(b.收尾?.usage)}`)
    }
    if (kind === "live-responses") {
      // 推理模型缺省带 include，reasoning 项应带 encrypted_content → 草稿里有带签名的 thinking
      const thinking = (b.草稿 ?? []).find((d) => d.type === "core.model_thinking" && d.thinking签名长度 > 0)
      if (!thinking) fails.push("没有带 encrypted_content 的 reasoning 草稿")
    }
  }
  return fails.length ? { 通过: false, 说明: fails.join("；") } : { 通过: true, 说明: "通过" }
}

/** [核对种类, 结果对象里的键]；两个编排器都按这张表存与判 */
export const FETCH_CELLS = [
  ["load", "fetchLoad"],
  ["fake", "fetchFake"],
  ["live-chat", "fetchLiveChat"],
  ["live-anthropic", "fetchLiveAnthropic"],
  ["live-responses", "fetchLiveResponses"],
]

export const fetchChecksOf = (r) =>
  Object.fromEntries(FETCH_CELLS.map(([kind, key]) => [kind, checkFetch(kind, r[key])]))

/**
 * pi 版探针的内容核对（2026-09-15 runtime-matrix 追加；workerd 编排器此前只看状态码，那边保留原样）。
 * /load：模块加载 + 两协议矩阵 + 无非 exact 落点；/mcp：echo 工具真跑一次；/fake、/live*：与 fetch 版同一套判据。
 */
export function checkPi(kind, x) {
  if (x === null || x === undefined) return { 通过: null, 说明: "跳过" }
  if (x.status !== 200) return { 通过: false, 说明: `HTTP ${x.status}` }
  const b = x.body ?? {}
  const fails = []
  if (kind === "load") {
    if (b.模块加载 !== "成功") fails.push("模块加载")
    for (const api of ["anthropic-messages", "openai-responses"])
      if (!(b.有损矩阵覆盖的协议 ?? []).includes(api)) fails.push(`矩阵缺 ${api}`)
    if (b.工具数 !== 1) fails.push(`工具数 ${b.工具数}`)
    if (b.非exact落点?.length) fails.push("有非 exact 落点")
    return fails.length ? { 通过: false, 说明: fails.join("；") } : { 通过: true, 说明: "通过" }
  }
  if (kind === "mcp") {
    const names = (b.工具 ?? []).map((t) => t.name)
    if (!names.includes("echo") || !names.includes("drop_table")) fails.push(`工具表 ${names.join(",")}`)
    if (b.echo结果?.content?.[0]?.text !== "echo:from-workerd" || b.echo结果?.isError)
      fails.push(`echo 结果 ${JSON.stringify(b.echo结果).slice(0, 120)}`)
    return fails.length ? { 通过: false, 说明: fails.join("；") } : { 通过: true, 说明: "通过" }
  }
  // fake / live-anthropic / live-openai：草稿与收尾形状与 fetch 版一致，直接复用
  const base = checkFetch(kind === "fake" ? "fake" : "live", x)
  if (kind === "live-openai" && base.通过) {
    // aireiter 的 gpt-5.5 是否吐 reasoning 项由模型定（2026-09-15 实测同一时刻 Node / Bun / Deno 都没吐、output 18 token），
    // 这里只记录不判定；encrypted_content 的硬判据放在 fetch 版 live-responses（CF 网关官方 gpt-5-mini 稳定产出）
    const thinking = (b.草稿 ?? []).find((d) => d.type === "core.model_thinking" && d.thinking签名长度 > 0)
    return {
      通过: true,
      说明: thinking
        ? `通过（reasoning 签名 ${thinking.thinking签名长度} 字符）`
        : "通过（本次模型未产出 reasoning 项）",
    }
  }
  return base
}

export const PI_CELLS = [
  ["load", "load"],
  ["mcp", "mcp"],
  ["fake", "fake"],
  ["live-anthropic", "live"],
  ["live-openai", "liveOpenai"],
]

export const piChecksOf = (r) =>
  Object.fromEntries(PI_CELLS.map(([kind, key]) => [kind, checkPi(kind, r[key])]))
