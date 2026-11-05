/**
 * 视频 / 音频片段端到端（2026-11-05，`docs/implementation-plans/2026-11-05-视频音频片段.md` 第 6 步）。
 *
 * 运行：仓库根先 `pnpm build`，然后 `node spikes/media-parts/e2e.mjs`（需要本机 ffmpeg、macOS `say` 与 ImageMagick `magick`；
 * 密钥自动从《模型API测试信息.md》读）。原始请求体（媒体 data 截断）与落点落到 OUT_DIR（缺省系统临时目录）。
 *
 * 判据是产出内容不是状态码（暗号法）：视频画面上是随机 6 位码，音频口播两个随机词。读片工具 `read_clip` 返回带时长的
 * VideoPart / AudioPart（v4-pro 臂返回图片）。
 *   relay-<线>   中转站 Gemini，宿主声明 video / audio 为真：最终答案含画面码与口播词；工具结果落点 exact；
 *                媒体那一步的真实输入增量与估算增量之比在 [0.9, 1.3]（估算宁高勿低）
 *   ds-flash     DeepSeek 官方 deepseek-flash，能力位缺省：视频 / 音频落占位、run 正常结束（不再 400）、落点 lossy 且在矩阵声明内
 *   ds-v4-pro    DeepSeek 官方 deepseek-v4-pro（BUG-261105-1 修正后 images 假）：图片落占位、记 lossy
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contextTokensOf, defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import {
  anthropicMessages,
  chatCompletions,
  declaredLandings,
  deepseek,
  openaiResponses,
} from "../../packages/lowering-fetch/dist/index.js"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const gBlock = info.slice(info.lastIndexOf("Gemini中转"))
const G_KEY = gBlock.match(/key[：:]\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
const G_BASE = `${gBlock.match(/baseurl[：:]\s*(\S+)/)?.[1]?.replace(/\/+$/, "")}/v1`
const DS_KEY = info.slice(info.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
if (!G_KEY || !DS_KEY) throw new Error("信息文件里缺 Gemini中转 或 deepseek官方 的 key")
const G_MODEL = process.env.G_MODEL ?? "gemini-3.8-flash-high"
const OUT = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), "reins-media-e2e-"))
mkdirSync(OUT, { recursive: true })
const WORK = mkdtempSync(join(tmpdir(), "reins-media-e2e-src-"))

// ---- 素材（每次现做） ----
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const code = Array.from({ length: 6 }, () => pick("ACDEFHJKLNPRTUXY34679")).join("")
const WORDS = [
  "pineapple",
  "volcano",
  "saxophone",
  "umbrella",
  "kangaroo",
  "lighthouse",
  "marathon",
  "telescope",
]
const w1 = pick(WORDS)
const w2 = pick(WORDS.filter((w) => w !== w1))
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "pipe" })
const speech = join(WORK, "speech.aiff")
run("say", ["-v", "Samantha", "-o", speech, `The secret words are ${w1} ${w2}. Again: ${w1} ${w2}.`])
// 视频带音轨（真实片子都有，P0 的 91 token/秒也含音轨），音轨里是另一对词，判据只看画面码与纯音频里的词
const v1 = pick(WORDS.filter((w) => w !== w1 && w !== w2))
const v2 = pick(WORDS.filter((w) => w !== w1 && w !== w2 && w !== v1))
const videoSpeech = join(WORK, "video-speech.aiff")
run("say", ["-v", "Samantha", "-o", videoSpeech, `This is the video soundtrack: ${v1} ${v2}.`])
const SECS = 10
const videoFile = join(WORK, "v.mp4")
run("ffmpeg", [
  ...["-y", "-f", "lavfi", "-i", `color=c=navy:s=640x360:d=${SECS}:r=24`, "-i", videoSpeech],
  ...[
    "-vf",
    `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text=${code}:fontsize=120:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
  ],
  ...["-af", "apad", "-t", String(SECS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", videoFile],
])
const audioFile = join(WORK, "a.mp3")
run(
  "ffmpeg",
  ["-y", "-i", speech, "-af", "apad", "-t", String(SECS), "-ar", "16000", "-ac", "1"].concat([
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    audioFile,
  ]),
)
const pngFile = join(WORK, "i.png")
run(
  "magick",
  ["-size", "480x160", "xc:white", "-gravity", "center", "-pointsize", "72", "-fill", "black"].concat([
    "-annotate",
    "0",
    code,
    pngFile,
  ]),
)
const b64 = (f) => readFileSync(f).toString("base64")
const PARTS = {
  video: { type: "video", mime: "video/mp4", data: b64(videoFile), durationSec: SECS },
  audio: { type: "audio", mime: "audio/mpeg", data: b64(audioFile), durationSec: SECS },
  image: { type: "image", mime: "image/png", data: b64(pngFile) },
}

const readClip = defineTool({
  name: "read_clip",
  description: "Open a media clip from the project. name is one of: video, audio, image.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", enum: ["video", "audio", "image"] } },
    required: ["name"],
  },
  risk: "low",
  execute: ({ name }) => [{ type: "text", text: `clip ${name}:` }, PARTS[name]],
})

const ASK_AV =
  "Use read_clip to open the video and then the audio (call it twice, one name each). Then reply on one line exactly: " +
  "SCREEN=<the text shown in the video, or NONE> SPOKEN=<the secret words spoken in the audio clip (not the video soundtrack), or NONE>. Do not guess."
const ASK_IMG =
  "Use read_clip to open the image, then reply on one line exactly: SCREEN=<the text in the image, or NONE>. Do not guess."

/** 中转站 Gemini：宿主对自己的中转站模型声明收图、视频、音频（内置表一律不开） */
function relay(line, fetch) {
  const common = {
    provider: "gemini-relay",
    baseUrl: G_BASE,
    apiKey: G_KEY,
    reasoning: true,
    images: true,
    video: true,
    audio: true,
    fetch,
  }
  if (line === "chat") return chatCompletions(G_MODEL, { ...common, requestOptions: { max_tokens: 4096 } })
  if (line === "anthropic")
    return anthropicMessages(G_MODEL, { ...common, requestOptions: { max_tokens: 4096 } })
  return openaiResponses(G_MODEL, { ...common, requestOptions: { max_output_tokens: 4096 } })
}

/** 截断请求体里的 base64，原始交换只为看形状 */
const shrink = (s) => s.replace(/[A-Za-z0-9+/=]{400,}/g, (m) => `<${m.length} b64 chars>`)

async function arm(label, bound, ask) {
  const bodies = []
  const recorder = async (url, init) => {
    bodies.push(shrink(String(init.body)))
    return fetch(url, init)
  }
  const b = bound(recorder)
  const landings = []
  const gen = runLoop({
    sessionId: `media-e2e-${label}-${Date.now()}`,
    log: new InMemoryEventLog(),
    lowering: b.lowering,
    model: b.model,
    tools: [readClip],
    systemPrompt: "You are a terse assistant. Use the tools; never guess values.",
    input: ask,
    onLandings: (_losses, request) => landings.push(request.landings),
  })
  const events = []
  let result
  while (true) {
    const s = await gen.next()
    if (s.done) {
      result = s.value
      break
    }
    events.push(s.value)
  }
  writeFileSync(
    join(OUT, `${label}.json`),
    JSON.stringify(
      {
        bodies,
        landings: landings.at(-1),
        events: events.map((e) => ({
          seq: e.seq,
          type: e.type,
          payload: shrink(JSON.stringify(e.payload)).slice(0, 600),
        })),
      },
      null,
      1,
    ),
  )
  const final = events.filter((e) => e.type === "core.model_text").at(-1)?.payload.text ?? ""
  const errors = events.filter((e) => e.type === "core.error").map((e) => e.payload.message?.slice(0, 300))
  // 最后一次请求里工具结果的落点（覆盖整段历史）
  const api = b.lowering.capabilities(b.model).api
  const toolLandings = (landings.at(-1) ?? []).filter((l) => l.type === "core.tool_result")
  const undeclared = toolLandings.filter(
    (l) => !declaredLandings(api, l.type).some((d) => d.kind === l.kind && d.landing === l.landing),
  )
  // 估算对照：相邻两次请求的真实上下文增量 vs 估算增量，取增量最大的那一步（媒体进上下文的那一步）
  const usage = events.filter(
    (e) => e.type === "core.budget_usage" && e.payload.contextEstimate !== undefined,
  )
  let step
  for (let i = 1; i < usage.length; i++) {
    const real = contextTokensOf(usage[i].payload.tokens) - contextTokensOf(usage[i - 1].payload.tokens)
    const est = usage[i].payload.contextEstimate - usage[i - 1].payload.contextEstimate
    if (!step || real > step.real) step = { real, est }
  }
  return {
    label,
    status: result?.status,
    final,
    errors,
    toolLandings,
    undeclared,
    step,
    requests: bodies.length,
  }
}

const relayArm = (line) => arm(`relay-${line}`, (f) => relay(line, f), ASK_AV)

const results = await Promise.all([
  relayArm("chat"),
  relayArm("anthropic"),
  relayArm("responses"),
  arm("ds-flash", (f) => deepseek("deepseek-flash", { apiKey: DS_KEY, fetch: f }), ASK_AV),
  arm("ds-v4-pro", (f) => deepseek("deepseek-v4-pro", { apiKey: DS_KEY, fetch: f }), ASK_IMG),
])

console.log(`暗号：SCREEN=${code} SPOKEN=${w1} ${w2}\n`)
let allOk = true
for (const r of results) {
  const relayLine = r.label.startsWith("relay")
  const sawCode = r.final.toUpperCase().includes(code)
  const heard = [w1, w2].every((w) => r.final.toLowerCase().includes(w))
  const kinds = r.toolLandings.map((l) => `${l.kind}/${l.landing}`)
  let ok
  let detail
  if (relayLine) {
    const ratio = r.step ? r.step.est / r.step.real : Number.NaN
    const exact =
      r.toolLandings.length >= 2 &&
      r.toolLandings.every((l) => l.kind === "exact" || l.landing === "tool+lifted-images")
    ok =
      r.status === "done" &&
      sawCode &&
      heard &&
      exact &&
      ratio >= 0.9 &&
      ratio <= 1.3 &&
      r.undeclared.length === 0
    detail = `画面 ${sawCode ? "✓" : "✗"} 口播 ${heard ? "✓" : "✗"}  落点 [${kinds.join(", ")}]  媒体步 真实 +${r.step?.real} 估算 +${r.step?.est} 比 ${ratio.toFixed(2)}`
  } else {
    const lossy = r.toolLandings.length > 0 && r.toolLandings.every((l) => l.kind === "lossy")
    const notes = r.toolLandings.map((l) => l.note ?? "").join(" | ")
    ok = r.status === "done" && r.errors.length === 0 && lossy && r.undeclared.length === 0
    detail = `落点 [${kinds.join(", ")}]  note: ${notes.slice(0, 160)}`
  }
  allOk &&= ok
  console.log(`${ok ? "✓" : "✗"} ${r.label.padEnd(15)} ${r.status}  请求 ${r.requests}  ${detail}`)
  if (r.undeclared.length) console.log(`    矩阵未声明：${JSON.stringify(r.undeclared)}`)
  if (r.errors.length) console.log(`    错误：${r.errors.join(" | ")}`)
  console.log(`    答案：${r.final.slice(0, 140)}`)
}
console.log(`\n原始交换：${OUT}`)
process.exit(allOk ? 0 : 1)
