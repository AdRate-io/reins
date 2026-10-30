/**
 * 整理请求文案对照（OPT-261030-3 第二步，2026-10-31）：在真实长会话的三个现场，各换一种措辞发一次请求，看模型下一步是不是 compact。
 *
 * 起因：onset-pause force 臂 18 格里请了 4 次、模型 4 次都没理（思考里一字未提），而短文本探针 9/9 照做——
 * 30 万 token 的上下文里，末尾一条系统说明进不了模型的决策。这里只测"措辞能不能让它当回事"，身份统一 system，
 * 一律放在最后一条（感知说明之后）。
 *
 * 现场取自 force 臂的录像（examples/eval/out/onset-force/cells/，只在本地）：截到模型收到请求之前，去掉原请求与其后的一切，
 * 装配同 run.ts 的 force 臂（缺省规则、spill、perception、budget，compact 不自己发请求），maxTurns 1 只走一步。
 *
 * 运行：node examples/eval/fixtures/onset-pause/wording.ts [--scenes new,mid,wrapup] [--variants A,B,C,D,E,F] [--repeats 3]
 * 密钥同 run.ts 的 onset-relay（"Claude中转"段）。结果写 examples/eval/out/onset-wording/results.jsonl。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { budget, COMPACT_RULES, COMPACT_TOOL_NAME, compact, perception, renderCompactRequest, spill } from "@reinsjs/brain"
import { contextOverheadOf, type Event, InMemoryEventLog, runLoop, type Socket } from "@reinsjs/core"
import { parseEventsJsonl } from "@reinsjs/eval"
import { deepseek } from "@reinsjs/lowering-fetch"
import { loadOnsetWorld, ONSET_CONTEXT_WINDOW, onsetTools } from "./fixture.ts"

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

// ---- 现场 ----
const CELLS = new URL("../../out/onset-force/cells/", import.meta.url)
interface Scene {
  id: string
  label: string
  cell: string
  /** 截到这个 seq 之前（不含） */
  before: number
  /** 额外剔除的 seq（原先那条被无视的请求） */
  drop?: readonly number[]
}
const SCENES: readonly Scene[] = [
  { id: "new", label: "刚接到新任务", cell: "onset-pause-work__force__1", before: 576 },
  { id: "mid", label: "任务做到一半", cell: "onset-pause-work__force__3", before: 596, drop: [576] },
  { id: "wrapup", label: "准备收尾", cell: "onset-pause-wrapup__force__2", before: 576 },
]

// ---- 文案 ----
type Render = (usage: string) => string
const CANARY = `CHECK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
const VARIANTS: Record<string, Render> = {
  // 现行缺省
  A: (usage) => renderCompactRequest({ usage, autoFoldAt: "85%" }),
  // 讲后果
  B: (usage) =>
    `IMPORTANT: the context window is ${usage} full. In a few more steps the harness will mechanically cut the oldest part of this conversation, ` +
    "and the decisions you made, why you made them, and what comes next will be lost, leaving only a rough list. " +
    `Call \`${COMPACT_TOOL_NAME}\` now and write your own summary to keep them. This must be your very next action, before any reply or any other tool.`,
  // 本轮必做的一步
  C: (usage) =>
    `[Action required by the harness] This is a required step of the current run, not a suggestion: your next tool call must be \`${COMPACT_TOOL_NAME}\`. ` +
    `The context window is ${usage} full. Compact first, then handle the task at hand.`,
  // 短促命令
  D: (usage) =>
    `Stop. Call \`${COMPACT_TOOL_NAME}\` first. Context is at ${usage}; at 85% it gets truncated mechanically and your notes are lost. Continue after compacting.`,
  // B 的中文版
  E: (usage) =>
    `重要：上下文已用 ${usage}。再过几步，框架会把这段对话最早的部分机械地剪掉，你定下的决定、原因和下一步都会丢失，只剩一张粗糙的清单。` +
    `现在就调用 \`${COMPACT_TOOL_NAME}\`，自己写总结把它们留下来。这必须是你的下一个动作，先于回复和任何其他工具。`,
  // 暗号对照：与整理无关的指令，分开"没注意到"与"注意到了但不想整理"
  Z: () => `Runtime check from the harness: start your next output with the exact text ${CANARY} before anything else.`,
  // Boss 的说法
  F: () =>
    "Warning: the context is about to overflow. Once it does, the loop will be interrupted. " +
    `Immediately use \`${COMPACT_TOOL_NAME}\` to summarize and compress the current context first, then continue the task.`,
}

// ---- 模型（同 run.ts onset-relay） ----
const INFO = readFileSync(new URL("../../../../模型API测试信息.md", import.meta.url), "utf8")
const relay = INFO.slice(INFO.lastIndexOf("Claude中转"))
const apiKey = relay.match(/key[：:]\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
const base = relay.match(/baseurl[：:]\s*(\S+)/)?.[1]?.replace(/\/+$/, "")
if (!apiKey || !base) throw new Error("没在 模型API测试信息.md 的 Claude中转 段找到 key / baseurl")
// --direct：DeepSeek 官方直连（短文本探针用的就是它，型号 deepseek-v4-flash），用来分开"中转站 / 型号"这一变量
const direct = process.argv.includes("--direct")
const dsKey = INFO.slice(INFO.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
const model = direct
  ? deepseek(process.env.MODEL ?? "deepseek-v4-flash", { apiKey: dsKey ?? "", contextWindow: ONSET_CONTEXT_WINDOW, maxOutputTokens: 384_000 })
  : deepseek(process.env.MODEL ?? "deepseek-v4.1-flash", {
      apiKey,
      // --no-mid-system：声明上游不收中途 system，说明改以 user 身份 + <system_note> 标签发出（lowering-fetch 的有损落点）
      ...(process.argv.includes("--no-mid-system") ? { midConversationSystem: false } : {}),
      baseUrl: `${base}/v1`,
      contextWindow: ONSET_CONTEXT_WINDOW,
      maxOutputTokens: 384_000,
    })

const world = loadOnsetWorld()
const tools = onsetTools(world)
const limits = { contextTokens: ONSET_CONTEXT_WINDOW }

/**
 * 换型号名测同一段录像时（如中转站的 deepseek-v4.1-flash:1017），把历史思考的回放标记改成当前型号：
 * 降级层只回放 provider + api + model 三者一致的思考（踩坑 37），而该型号要求 thinking 必须传回，否则 400。只改内存里的副本
 */
function replayAs(e: Event): Event {
  const replay = (e as unknown as { replay?: { provider: string; api: string; model: string } }).replay
  if (!replay || replay.model === model.model.id) return e
  return { ...e, replay: { ...replay, model: model.model.id } } as Event
}

/** 末位 Socket：在感知说明之后追加一条整理请求（system_note，与 compact force 同一形状） */
function requestSocket(render: Render): Socket {
  return {
    name: "wording-request",
    beforeModel(ctx) {
      const usage = `${Math.round(((ctx.budget.used + contextOverheadOf(ctx.timeline)) / ctx.budget.contextLimit) * 100)}%`
      ctx.emit({
        type: "core.system_note",
        actor: "system",
        payload: { kind: "budget", text: render(usage), meta: { compactRequest: { usage, autoFoldAt: "85%", at: 0 } } },
      })
      return undefined
    },
  }
}

const sceneIds = flag("--scenes", "new,mid,wrapup").split(",")
const variantIds = flag("--variants", Object.keys(VARIANTS).join(",")).split(",")
const repeats = Number(flag("--repeats", "3"))
const out = new URL("../../out/onset-wording/", import.meta.url)
mkdirSync(out, { recursive: true })

/**
 * --ask-canary（Boss 定的送达检验）：长上下文末尾先追加一条 system 说明（带暗号），再追加一条用户消息问暗号是什么。
 * 用户直接问，排除"看到了但没当回事"，只看 system 说明有没有送到模型。不装脑子模块，免得多出别的说明
 */
if (process.argv.includes("--ask-canary")) {
  const repeatsAsk = Number(flag("--repeats", "3"))
  for (const scene of SCENES.filter((s) => sceneIds.includes(s.id))) {
    const all = parseEventsJsonl(readFileSync(new URL(`${scene.cell}.jsonl`, CELLS), "utf8"))
    const base = all
      .filter((e) => e.seq < scene.before && !scene.drop?.includes(e.seq))
      .map((e, i) => ({ ...e, seq: i + 1 }))
    const sessionId = base[0]?.sessionId as string
    for (let r = 1; r <= repeatsAsk; r++) {
      const code = `CHECK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
      const at = Date.now()
      const extra = [
        { type: "core.system_note", actor: "system", trust: "system", payload: { kind: "host", text: `Harness check code: ${code}.` } },
        {
          type: "core.user_message",
          actor: "user",
          trust: "principal",
          payload: {
            content: [
              { type: "text", text: "Quick check before you continue: what is the check code in the most recent system message? Reply with the code only, or NONE if you did not get one." },
            ],
          },
        },
      ].map((d, i) => ({ ...d, id: `ask-${at}-${i}`, sessionId, seq: base.length + i + 1, at, schemaVersion: 1 })) as Event[]
      const log = new InMemoryEventLog()
      await log.append([...base, ...extra])
      const fresh: Event[] = []
      let status = "?"
      try {
        const gen = runLoop({ sessionId, log, lowering: model.lowering, model: model.model, tools, systemPrompt: world.systemPrompt, sockets: [], maxTurns: 1 })
        while (true) {
          const step = await gen.next()
          if (step.done) {
            status = step.value.status
            break
          }
          fresh.push(step.value)
        }
      } catch (err) {
        status = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      const text = fresh.filter((e) => e.type === "core.model_text").map((e) => (e.payload as { text: string }).text).join(" ")
      const route = `${direct ? "direct" : "relay"}-${model.model.id}`
      const row = { mode: "ask-canary", route, scene: scene.id, repeat: r, code, got: text.includes(code), answer: text.slice(0, 200), status }
      appendFileSync(new URL("results.jsonl", out), `${JSON.stringify(row)}\n`)
      console.log(`${route} ${scene.label} 问暗号#${r}  ${row.got ? "✓ 收到" : "✗ 没收到"}  答：${row.answer.replace(/\s+/g, " ").slice(0, 120)}  ${status}`)
    }
  }
  process.exit(0)
}

for (const scene of SCENES.filter((s) => sceneIds.includes(s.id))) {
  const all = parseEventsJsonl(readFileSync(new URL(`${scene.cell}.jsonl`, CELLS), "utf8"))
  // 日志要求 seq 连续：剔掉原请求后顺次重编号（其后没有按 seq 引用它之后事件的 compaction）
  const seed: Event[] = all
    .filter((e) => e.seq < scene.before && !scene.drop?.includes(e.seq))
    .map((e, i) => ({ ...e, seq: i + 1 }))
    .map(replayAs)
  for (const v of variantIds) {
    const render = VARIANTS[v]
    if (!render) throw new Error(`未知文案 ${v}`)
    for (let r = 1; r <= repeats; r++) {
      const log = new InMemoryEventLog()
      await log.append(seed)
      const sessionId = seed[0]?.sessionId as string
      const fresh: Event[] = []
      const started = Date.now()
      let status = "?"
      try {
        const gen = runLoop({
          sessionId,
          log,
          lowering: model.lowering,
          model: model.model,
          tools,
          systemPrompt: world.systemPrompt,
          sockets: [compact({ rules: COMPACT_RULES, force: false }), spill(), perception({ limits }), budget({ limits }), requestSocket(render)],
          maxTurns: 1,
        })
        while (true) {
          const step = await gen.next()
          if (step.done) {
            status = step.value.status === "error" ? `error: ${JSON.stringify(step.value).slice(0, 3000)}` : step.value.status
            break
          }
          fresh.push(step.value)
        }
      } catch (err) {
        status = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      const calls = fresh.filter((e) => e.type === "core.tool_call").map((e) => (e.payload as { name: string }).name)
      const thinking = fresh
        .filter((e) => e.type === "core.model_thinking")
        .map((e) => (e.payload as { text: string }).text)
        .join(" ")
      const text = fresh
        .filter((e) => e.type === "core.model_text")
        .map((e) => (e.payload as { text: string }).text)
        .join(" ")
      const usage = fresh.find((e) => e.type === "core.budget_usage")?.payload as
        | { tokens: { input: number; output: number; cacheRead?: number } }
        | undefined
      const row = {
        route: `${direct ? "direct" : "relay"}-${model.model.id}${process.argv.includes("--no-mid-system") ? "-usernote" : ""}`,
        canary: v === "Z" ? text.includes(CANARY) || thinking.includes(CANARY) : undefined,
        scene: scene.id,
        variant: v,
        repeat: r,
        status,
        first: calls[0] ?? (text ? "（正文）" : "（无）"),
        complied: calls[0] === COMPACT_TOOL_NAME,
        calls,
        mentionsRequest: /compact|整理|上下文|context/i.test(thinking),
        thinking: thinking.slice(0, 400),
        tokens: usage?.tokens,
        ms: Date.now() - started,
      }
      appendFileSync(new URL("results.jsonl", out), `${JSON.stringify(row)}\n`)
      console.log(
        `${row.route} ${scene.label} ${v}#${r}  ${v === "Z" ? (row.canary ? "✓ 暗号" : "✗ 无暗号") : ""} ${row.complied ? "✓ compact" : `✗ ${row.first}`}  思考提到=${row.mentionsRequest}  in=${(usage?.tokens.input ?? 0) + (usage?.tokens.cacheRead ?? 0)} read=${usage?.tokens.cacheRead ?? 0} out=${usage?.tokens.output ?? 0}  ${Math.round(row.ms / 1000)}s`,
      )
    }
  }
}
