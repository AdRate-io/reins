/**
 * 库路径真模型冒烟：`deepseek("deepseek-flash")` + core runLoop，工具返回一张写着随机码的图（只有看图才知道的信息）。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/chat-tool-images/smoke.mjs`（需要 ImageMagick）。
 * 两臂：
 *   lift   缺省（liftToolImages 开）：模型答出码；末次请求里 tool 之后紧跟带 image_url 的 user；落点 tool+lifted-images
 *   off    chat.liftToolImages: false：退回占位文本，模型不该答出码（反向对照，证明答对靠的是上浮）
 * 另跑一臂 multi：一次调用两张图（a / b 各一码），模型按顺序答出两码。
 * 随机码字符集刻意去掉易混字形（B/8、M/W、S/5、Z/2、O/0、I/1）：首轮用全字母表时 multi 臂 5 遍错 1 遍是识字错（W→M、8→B），图到了、顺序也对。
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { deepseek } from "../../packages/lowering-fetch/dist/index.js"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const dsKey = info.slice(info.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
if (!dsKey) throw new Error("信息文件里缺 DeepSeek key")

const dir = mkdtempSync(join(tmpdir(), "reins-img-"))
const randCode = () =>
  Array.from({ length: 6 }, () => "ACDEFHJKLNPRTUXY34679"[Math.floor(Math.random() * 21)]).join("")
function pngBase64(code) {
  const out = join(dir, `${code}.png`)
  execFileSync("magick", [
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

async function arm(name, { chat, codes, question }) {
  const tool = defineTool({
    name: "read_image",
    description: "Read an image file from the project and return its pixels",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    risk: "low",
    execute: () => ({
      content: [
        { type: "text", text: `${codes.length} image(s) loaded` },
        ...codes.map((c) => ({ type: "image", mime: "image/png", data: pngBase64(c) })),
      ],
    }),
  })
  const bound = deepseek(process.env.MODEL ?? "deepseek-flash", { apiKey: dsKey, ...(chat ? { chat } : {}) })
  const requests = []
  const events = []
  const gen = runLoop({
    sessionId: `img-${name}-${Date.now()}`,
    log: new InMemoryEventLog(),
    lowering: bound.lowering,
    model: bound.model,
    tools: [tool],
    systemPrompt: "You are a terse assistant. Always use read_image to look at files; never guess.",
    input: question,
    onLandings: (losses, req) => requests.push({ losses, body: req.payload.body }),
  })
  let result
  while (true) {
    const step = await gen.next()
    if (step.done) {
      result = step.value
      break
    }
    events.push(step.value)
  }
  const finalText =
    events
      .filter((e) => e.type === "core.model_text")
      .map((e) => e.payload.text)
      .at(-1) ?? ""
  const errors = events.filter((e) => e.type === "core.error").map((e) => e.payload.message)
  const toolResultSent = events.find((e) => e.type === "core.tool_result")
  const last = requests.at(-1)?.body?.messages ?? []
  const toolIdx = last.findIndex((m) => m.role === "tool")
  const after = last[toolIdx + 1]
  const liftedShape =
    after?.role === "user" &&
    Array.isArray(after.content) &&
    after.content.some((p) => p.type === "image_url")
  const toolResultResult = (toolResultSent?.payload?.content ?? []).filter((p) => p.type === "image").length
  return {
    name,
    status: result?.status,
    errors,
    finalText,
    liftedShape,
    toolResultResult,
    toolContent: last[toolIdx]?.content,
  }
}

const checks = []
const c1 = randCode()
const lift = await arm("lift", {
  codes: [c1],
  question: "Read badge.png and tell me the code written on it. Reply with the code only.",
})
checks.push(["lift: run done", lift.status === "done", `${lift.status} ${lift.errors.join(" | ")}`])
checks.push([
  "lift: 末次请求 tool 之后紧跟带 image_url 的 user",
  lift.liftedShape,
  String(lift.toolContent).slice(0, 120),
])
checks.push([`lift: 答出码 ${c1}`, lift.finalText.includes(c1), lift.finalText.slice(0, 120)])

const c2 = randCode()
const off = await arm("off", {
  chat: { liftToolImages: false },
  codes: [c2],
  question: "Read badge.png and tell me the code written on it. Reply with the code only.",
})
checks.push(["off: run done", off.status === "done", `${off.status} ${off.errors.join(" | ")}`])
checks.push(["off: 不出附件消息", !off.liftedShape, String(off.toolContent).slice(0, 120)])
checks.push([
  `off: 答不出码 ${c2}（反向对照）`,
  !off.finalText.includes(c2),
  off.finalText.replace(/\s+/g, " ").slice(0, 120),
])

const m1 = randCode()
const m2 = randCode()
const multi = await arm("multi", {
  codes: [m1, m2],
  question: "Read pair.png (it returns two images). Reply exactly: first=<code> second=<code>",
})
checks.push(["multi: run done", multi.status === "done", `${multi.status} ${multi.errors.join(" | ")}`])
checks.push([
  `multi: 按顺序答出 ${m1} / ${m2}`,
  multi.finalText.includes(`first=${m1}`) && multi.finalText.includes(`second=${m2}`),
  multi.finalText.slice(0, 120),
])

for (const [label, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${label} — ${detail}`)
console.log(`${checks.filter((c) => c[1]).length}/${checks.length}`)
