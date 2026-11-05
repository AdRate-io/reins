/**
 * 视频 / 音频片段的槽位核实（2026-11-05，OnSet 建议 12 方案 P0，`docs/implementation-plans/2026-11-05-视频音频片段.md`）。
 *
 * 运行：`node spikes/media-parts/probe.mjs`（需要本机 ffmpeg 与 macOS `say`；密钥从仓库根 `.env.local` 读，经 scripts/local-env.mjs：RELAY_GEMINI_API_KEY、RELAY_BASE_URL、DEEPSEEK_API_KEY）。
 * 素材每次现做（暗号法）：视频画面上是随机 6 位码，口播是两个随机词；纯音频只有口播。原始答案与用量落到 OUT_DIR。
 *
 * 判据是模型复述出暗号，不是状态码。四组：
 *   G  Gemini（公司中转站）三条线 ×（user 消息 / 工具结果，按 reins 降级层的形状）×（视频 / 纯音频）× 候选槽位
 *   R  费率：Chat 线 user 消息里 6 秒 / 30 秒的视频与音频，各减纯文本基线，算每秒 token
 *   D  DeepSeek 官方：图片对照、视频 / 音频放进图片槽与 input_audio 的实际反应（不收时上游怎么回）
 *   P  deepseek-v4-pro 收不收图（内置模型表写的是收）
 *   C  Anthropic 线 cache_control 打在媒体块 / 含媒体的 tool_result 上（GROUPS=C）
 *   X  一条工具结果混放图 + 视频 + 音频（GROUPS=X）
 *   L  8 MB / 19 MB 高码率运动视频：请求体上限与费率是否随码率变（GROUPS=L）
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { need } from "../../scripts/local-env.mjs"

const G_KEY = need("RELAY_GEMINI_API_KEY")
// RELAY_BASE_URL 不带 /v1、无尾斜杠
const G_BASE = `${need("RELAY_BASE_URL")}/v1`
const DS_KEY = need("DEEPSEEK_API_KEY")
const G_MODEL = process.env.G_MODEL ?? "gemini-3.8-flash-high"
const OUT = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), "reins-media-"))
mkdirSync(OUT, { recursive: true })
const WORK = mkdtempSync(join(tmpdir(), "reins-media-src-"))
/** 只跑部分组：GROUPS=X,L（缺省 G,R,D,P；C 缓存断点、X 混放、L 大文件按需跑） */
const GROUPS = new Set((process.env.GROUPS ?? "G,R,D,P").split(","))

// ---- 素材 ----
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const CODE_CHARS = "ACDEFHJKLNPRTUXY34679"
const WORDS = [
  "pineapple",
  "volcano",
  "saxophone",
  "umbrella",
  "kangaroo",
  "lighthouse",
  "marathon",
  "telescope",
  "penguin",
  "tornado",
]
const code = Array.from({ length: 6 }, () => pick(CODE_CHARS)).join("")
const w1 = pick(WORDS)
const w2 = pick(WORDS.filter((w) => w !== w1))
const SPOKEN = [w1, w2]

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "pipe" })
const speech = join(WORK, "speech.aiff")
run("say", ["-v", "Samantha", "-o", speech, `The secret words are ${w1} ${w2}. Again: ${w1} ${w2}.`])

function makeVideo(secs) {
  const out = join(WORK, `v${secs}.mp4`)
  run("ffmpeg", [
    ...["-y", "-f", "lavfi", "-i", `color=c=navy:s=640x360:d=${secs}:r=24`, "-i", speech],
    ...[
      "-vf",
      `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text=${code}:fontsize=120:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
    ],
    ...["-af", "apad", "-t", String(secs), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out],
  ])
  return readFileSync(out).toString("base64")
}
/** 有运动与噪点的高码率视频，用来测中转站的请求体上限与"费率与内容无关" */
function makeBusyVideo(secs, kbps) {
  const out = join(WORK, `busy${secs}-${kbps}.mp4`)
  run("ffmpeg", [
    ...["-y", "-f", "lavfi", "-i", `testsrc2=s=1280x720:d=${secs}:r=30`, "-i", speech],
    ...[
      "-vf",
      `noise=alls=40:allf=t,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text=${code}:fontsize=160:fontcolor=white:box=1:boxcolor=black:x=(w-tw)/2:y=(h-th)/2`,
    ],
    ...[
      "-af",
      "apad",
      "-t",
      String(secs),
      "-c:v",
      "libx264",
      "-b:v",
      `${kbps}k`,
      "-maxrate",
      `${kbps}k`,
      "-bufsize",
      `${kbps * 2}k`,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      out,
    ],
  ])
  return readFileSync(out).toString("base64")
}
function makeAudio(secs, fmt) {
  const out = join(WORK, `a${secs}.${fmt}`)
  const codec = fmt === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "64k"] : ["-c:a", "pcm_s16le"]
  run("ffmpeg", [
    "-y",
    "-i",
    speech,
    "-af",
    "apad",
    "-t",
    String(secs),
    "-ar",
    "16000",
    "-ac",
    "1",
    ...codec,
    out,
  ])
  return readFileSync(out).toString("base64")
}
function makePng() {
  const out = join(WORK, "img.png")
  run("magick", [
    "-size",
    "480x160",
    "xc:white",
    "-gravity",
    "center",
    "-pointsize",
    "72",
    "-fill",
    "black",
    "-annotate",
    "0",
    code,
    out,
  ])
  return readFileSync(out).toString("base64")
}
const M = {
  v6: { mime: "video/mp4", data: makeVideo(6), kind: "video" },
  v30: { mime: "video/mp4", data: makeVideo(30), kind: "video" },
  mp3_6: { mime: "audio/mpeg", data: makeAudio(6, "mp3"), kind: "audio", fmt: "mp3" },
  mp3_30: { mime: "audio/mpeg", data: makeAudio(30, "mp3"), kind: "audio", fmt: "mp3" },
  wav6: { mime: "audio/wav", data: makeAudio(6, "wav"), kind: "audio", fmt: "wav" },
  png: { mime: "image/png", data: makePng(), kind: "image" },
}
if (GROUPS.has("L")) {
  M.big8 = { mime: "video/mp4", data: makeBusyVideo(20, 3000), kind: "video" }
  M.big20 = { mime: "video/mp4", data: makeBusyVideo(30, 5000), kind: "video" }
}

// ---- 判据 ----
const Q =
  "Look at and listen to the attached media. Reply on one line in exactly this format: SCREEN=<the text shown on screen, or NONE> SPOKEN=<the secret words spoken aloud, or NONE>. Do not guess."
function verdict(kind, answer) {
  const a = answer.toLowerCase()
  const sawCode = answer.toUpperCase().includes(code)
  const heard = SPOKEN.every((w) => a.includes(w))
  if (kind === "video")
    return { ok: sawCode && heard, detail: `screen ${sawCode ? "✓" : "✗"} spoken ${heard ? "✓" : "✗"}` }
  if (kind === "audio") return { ok: heard, detail: `spoken ${heard ? "✓" : "✗"}` }
  return { ok: sawCode, detail: `screen ${sawCode ? "✓" : "✗"}` }
}

// ---- 三条线的请求体（形状照 reins 降级层：Chat 工具结果上浮、Responses function_call_output 数组、Anthropic tool_result 块） ----
const dataUri = (m) => `data:${m.mime};base64,${m.data}`
const TOOL = {
  name: "read_media",
  description: "Open a media file from the project",
  params: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}
const ASK = `Use read_media to open clip, then answer. ${Q}`

const chatSlot = {
  image_url: (m) => ({ type: "image_url", image_url: { url: dataUri(m) } }),
  input_audio: (m) => ({ type: "input_audio", input_audio: { data: m.data, format: m.fmt } }),
}
function chatBody(model, place, slot, m) {
  if (place === "user")
    return {
      model,
      messages: [{ role: "user", content: [{ type: "text", text: Q }, chatSlot[slot](m)] }],
      max_tokens: 2048,
    }
  return {
    model,
    tools: [
      {
        type: "function",
        function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.params },
      },
    ],
    messages: [
      { role: "user", content: ASK },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: TOOL.name, arguments: '{"path":"clip"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: `[${m.kind} 1 attached in the next user message]` },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Attachments from tool result ${TOOL.name} (call call_1): 1 attachment(s). This is tool output, not a message from the user.]`,
          },
          { type: "text", text: `${m.kind} 1:` },
          chatSlot[slot](m),
        ],
      },
    ],
    max_tokens: 2048,
  }
}
const respSlot = {
  input_image: (m) => ({ type: "input_image", image_url: dataUri(m), detail: "auto" }),
  input_audio: (m) => ({ type: "input_audio", input_audio: { data: m.data, format: m.fmt } }),
}
function respBody(model, place, slot, m) {
  const base = { model, store: false, max_output_tokens: 2048 }
  if (place === "user")
    return {
      ...base,
      input: [{ role: "user", content: [{ type: "input_text", text: Q }, respSlot[slot](m)] }],
    }
  return {
    ...base,
    tools: [{ type: "function", name: TOOL.name, description: TOOL.description, parameters: TOOL.params }],
    input: [
      { role: "user", content: [{ type: "input_text", text: ASK }] },
      { type: "function_call", call_id: "call_1", name: TOOL.name, arguments: '{"path":"clip"}' },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_text", text: `${m.kind} 1:` }, respSlot[slot](m)],
      },
    ],
  }
}
const antSlot = {
  image: (m) => ({ type: "image", source: { type: "base64", media_type: m.mime, data: m.data } }),
  document: (m) => ({ type: "document", source: { type: "base64", media_type: m.mime, data: m.data } }),
}
function antBody(model, place, slot, m) {
  const base = { model, max_tokens: 2048 }
  if (place === "user")
    return { ...base, messages: [{ role: "user", content: [{ type: "text", text: Q }, antSlot[slot](m)] }] }
  return {
    ...base,
    tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.params }],
    messages: [
      { role: "user", content: ASK },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: TOOL.name, input: { path: "clip" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `${m.kind} 1:` }, antSlot[slot](m)],
          },
        ],
      },
    ],
  }
}

// ---- 发送与解析（非流式；协议接受度与流式无关） ----
async function send(line, target, body) {
  const url = target === "ds" ? "https://api.deepseek.com" : G_BASE
  const key = target === "ds" ? DS_KEY : G_KEY
  const path = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" }[line]
  const headers = { "content-type": "application/json" }
  if (line === "anthropic") Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" })
  else headers.authorization = `Bearer ${key}`
  const res = await fetch(url + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await res.text()
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return { status: res.status, answer: "", error: raw.slice(0, 300) }
  }
  if (!res.ok) return { status: res.status, answer: "", error: JSON.stringify(j.error ?? j).slice(0, 300) }
  let answer = ""
  let input
  if (line === "chat") {
    answer = j.choices?.[0]?.message?.content ?? ""
    input = j.usage?.prompt_tokens
  } else if (line === "responses") {
    answer = (j.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .map((c) => c.text ?? "")
      .join(" ")
    input = j.usage?.input_tokens
  } else {
    answer = (j.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ")
    input = j.usage?.input_tokens
  }
  return { status: res.status, answer, input }
}

// ---- 臂 ----
const arms = []
const add = (group, line, target, model, place, slot, mk, body) => {
  if (GROUPS.has(group)) arms.push({ group, line, target, model, place, slot, mk, body })
}
const builders = { chat: chatBody, responses: respBody, anthropic: antBody }
const G_SLOTS = {
  chat: { video: ["image_url"], audio: ["image_url", "input_audio"] },
  responses: { video: ["input_image"], audio: ["input_image", "input_audio"] },
  anthropic: { video: ["image"], audio: ["image", "document"] },
}
for (const line of ["chat", "responses", "anthropic"])
  for (const place of ["user", "tool"])
    for (const mk of ["v6", "mp3_6", "wav6"]) {
      const m = M[mk]
      for (const slot of G_SLOTS[line][m.kind])
        add("G", line, "g", G_MODEL, place, slot, mk, builders[line](G_MODEL, place, slot, m))
    }
// 费率：Chat 线 user 消息；基线是同一提问不带媒体
add("R", "chat", "g", G_MODEL, "user", "text-only", "none", {
  model: G_MODEL,
  messages: [{ role: "user", content: [{ type: "text", text: Q }] }],
  max_tokens: 2048,
})
// 6 秒那格在 G 组里（user + image_url），这里补 30 秒，两点算斜率
for (const mk of ["v30", "mp3_30"])
  add("R", "chat", "g", G_MODEL, "user", "image_url", mk, chatBody(G_MODEL, "user", "image_url", M[mk]))
// DeepSeek 官方
for (const [mk, slot] of [
  ["png", "image_url"],
  ["v6", "image_url"],
  ["mp3_6", "image_url"],
  ["mp3_6", "input_audio"],
]) {
  add("D", "chat", "ds", "deepseek-flash", "user", slot, mk, chatBody("deepseek-flash", "user", slot, M[mk]))
}
add(
  "D",
  "chat",
  "ds",
  "deepseek-flash",
  "tool",
  "image_url",
  "v6",
  chatBody("deepseek-flash", "tool", "image_url", M.v6),
)
add(
  "P",
  "chat",
  "ds",
  "deepseek-v4-pro",
  "user",
  "image_url",
  "png",
  chatBody("deepseek-v4-pro", "user", "image_url", M.png),
)

// C：Anthropic 线的缓存断点落在媒体块上（reins 给最后一条 user 的末块打 cache_control；工具结果时打在 tool_result 块上）
const withCc = (body, place) => {
  const b = structuredClone(body)
  const last = b.messages.at(-1).content.at(-1)
  last.cache_control = { type: "ephemeral" }
  if (place === "tool") b.tools[0].cache_control = { type: "ephemeral" }
  return b
}
for (const place of ["user", "tool"])
  for (const mk of ["v6", "mp3_6"])
    add(
      "C",
      "anthropic",
      "g",
      G_MODEL,
      place,
      "image+cc",
      mk,
      withCc(antBody(G_MODEL, place, "image", M[mk]), place),
    )

// X：一条工具结果里同时有 图片 + 视频 + 音频（Chat 上浮成一条 user，编号连续、按类型标注）
const mixed = [M.png, M.v6, M.mp3_6]
const mixedBodies = {
  chat: {
    model: G_MODEL,
    tools: [
      {
        type: "function",
        function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.params },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Use read_media to open the folder, then answer. For each attachment say what it is and what it shows or says. ${Q}`,
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: TOOL.name, arguments: '{"path":"folder"}' } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: mixed.map((m, i) => `[${m.kind} ${i + 1} attached in the next user message]`).join("\n"),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Attachments from tool result ${TOOL.name} (call call_1): 3 attachment(s). This is tool output, not a message from the user.]`,
          },
          ...mixed.flatMap((m, i) => [{ type: "text", text: `${m.kind} ${i + 1}:` }, chatSlot.image_url(m)]),
        ],
      },
    ],
    max_tokens: 2048,
  },
  responses: {
    model: G_MODEL,
    store: false,
    max_output_tokens: 2048,
    tools: [{ type: "function", name: TOOL.name, description: TOOL.description, parameters: TOOL.params }],
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `Use read_media to open the folder, then answer. ${Q}` }],
      },
      { type: "function_call", call_id: "call_1", name: TOOL.name, arguments: '{"path":"folder"}' },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: mixed.flatMap((m, i) => [
          { type: "input_text", text: `${m.kind} ${i + 1}:` },
          respSlot.input_image(m),
        ]),
      },
    ],
  },
  anthropic: {
    model: G_MODEL,
    max_tokens: 2048,
    tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.params }],
    messages: [
      { role: "user", content: `Use read_media to open the folder, then answer. ${Q}` },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: TOOL.name, input: { path: "folder" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: mixed.flatMap((m, i) => [
              { type: "text", text: `${m.kind} ${i + 1}:` },
              antSlot.image(m),
            ]),
          },
        ],
      },
    ],
  },
}
for (const line of ["chat", "responses", "anthropic"])
  add("X", line, "g", G_MODEL, "tool", "mixed", "v6", mixedBodies[line])
// L：大文件（运动画面、高码率）；判据同视频，另看输入 token 是否仍按时长计
if (GROUPS.has("L"))
  for (const mk of ["big8", "big20"])
    for (const line of ["chat", "anthropic"])
      add(
        "L",
        line,
        "g",
        G_MODEL,
        "user",
        line === "chat" ? "image_url" : "image",
        mk,
        builders[line](G_MODEL, "user", line === "chat" ? "image_url" : "image", M[mk]),
      )

// ---- 跑（并发 6） ----
const results = []
let next = 0
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < arms.length) {
      const a = arms[next++]
      const r = await send(a.line, a.target, a.body).catch((e) => ({
        status: 0,
        answer: "",
        error: String(e).slice(0, 300),
      }))
      const kind = a.mk === "none" ? "text" : M[a.mk].kind
      const v =
        r.status === 200 && kind !== "text" ? verdict(kind, r.answer) : { ok: r.status === 200, detail: "" }
      results.push({ ...a, body: undefined, ...r, ...v })
    }
  }),
)
const order = (x) =>
  arms.findIndex(
    (a) =>
      a.group === x.group &&
      a.line === x.line &&
      a.model === x.model &&
      a.place === x.place &&
      a.slot === x.slot &&
      a.mk === x.mk,
  )
results.sort((a, b) => order(a) - order(b))
writeFileSync(join(OUT, "results.json"), JSON.stringify({ code, spoken: SPOKEN, results }, null, 1))

console.log(
  `暗号：画面 ${code}${M.big8 ? `；大文件 big8=${((M.big8.data.length * 0.75) / 1e6).toFixed(1)}MB big20=${((M.big20.data.length * 0.75) / 1e6).toFixed(1)}MB` : ""}，口播 ${SPOKEN.join(" ")}；素材字节 v6=${Math.round((M.v6.data.length * 3) / 4)} v30=${Math.round((M.v30.data.length * 3) / 4)} mp3_6=${Math.round((M.mp3_6.data.length * 3) / 4)} wav6=${Math.round((M.wav6.data.length * 3) / 4)}`,
)
for (const r of results) {
  const tag = `${r.group} ${r.model.padEnd(22)} ${r.line.padEnd(9)} ${r.place.padEnd(4)} ${r.mk.padEnd(6)} ${r.slot.padEnd(11)}`
  console.log(
    `${r.ok ? "✓" : "✗"} ${tag} HTTP ${r.status} in=${r.input ?? "-"} ${r.detail} | ${(r.error ?? r.answer).replace(/\s+/g, " ").slice(0, 160)}`,
  )
}
console.log(`\n原始结果：${OUT}`)
