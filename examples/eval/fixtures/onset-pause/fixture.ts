/**
 * OnSet 反馈 ②（docs/2026-10-30-OnSet反馈-compact与perception改进建议.md）：长期会话里，"一次 run 收尾"算不算整理的自然停顿。
 *
 * 现象：OnSet 一个"项目 × 角色"是一条长期会话，被消息唤醒一次跑一个 run。第三轮摄影（程野）的会话涨到 84%，
 * 感知报了 70%–85% 与 ≥85%，它一次都没整理，思考里写"上下文很紧，回答写短"—— 靠少做事扛，而不是整理。
 * 缺省规则只说"在自然停顿整理、别在做事中途整理"，可多 run 会话里模型总觉得事情没完，于是永远等不到"停顿"。
 *
 * 做法：世界 = 那条会话本身（`data/session.jsonl`，build.ts 从 OnSet 库生成，不进仓库）。在几次 run 的起点切开：
 * 切点之前的历史当种子，切点那条真实的投递消息当任务输入，工具按录像回放。两臂只差 compact 的规则文案：
 * - `rules-current`：现行 `COMPACT_RULES`
 * - `rules-candidate`：补两句 —— run 收尾准备停下等人就是自然停顿；窗口过了约 70% 且到了这种停顿就先整理，紧了先整理而不是少做事
 *
 * 种子里 OnSet 自定义的中文感知说明全部去掉（臂装的是缺省英文 perception，读数由它重新报），其余事件逐字保留、seq 重排。
 *
 * 看什么（`compactionTiming`）：模型自决的整理落在本 run 的哪里 —— `start`（动手之前）/ `end`（干完活、回复之前）/ `mid`（两步活之间）。
 * 前两者是我们要的，`mid` 是建议里点名要防的副作用"推导做到一半就整理"。窗口 <50% 的对照切点上，两臂都不该整理。
 * 预埋事实（分叉会话里问）看整理有没有把账目细节丢掉。
 */
import { readFileSync } from "node:fs"
import { COMPACT_RULES, COMPACT_TOOL_NAME, RECALL_TOOL_NAME } from "@reinsjs/brain"
import type { ContentPart, CoreEventOf, Event, Tool, ToolResult } from "@reinsjs/core"
import { type EvalFixture, type PlantedFact, parseEventsJsonl, type RecordedToolSpec, recordedTools } from "@reinsjs/eval"

const DATA = new URL("./data/", import.meta.url)

/** OnSet 线上的窗口（assembly.ts CONTEXT_WINDOW_TOKENS），budget 的 contextTokens 用同一个值 */
export const ONSET_CONTEXT_WINDOW = 400_000

// ---- 规则文案 ----

const NATURAL_PAUSE = "Do it at a natural pause, not while acting on something."
/**
 * 候选文案：只改第一条，其余逐字同现行。补的两句都是通用经验，不提 OnSet：
 * 一是"run 收尾"在长期会话里就是停顿（哪怕大项目没完）；二是窗口紧时先整理，不靠省掉查证与说明来省空间。
 */
export const CANDIDATE_COMPACT_RULES = COMPACT_RULES.replace(
  NATURAL_PAUSE,
  `${NATURAL_PAUSE} In a long-lived session that is woken up again and again, the end of a run is such a pause: you have done what this message asked and are about to reply and wait for the user or others, even if the larger project is not finished.
- When the window is past about 70% and you reach such a pause, compact before you stop (call \`${COMPACT_TOOL_NAME}\`, then give your reply). When it is tight, compact first rather than working less: do not skip reads, checks or explanations to save space.`,
)
if (CANDIDATE_COMPACT_RULES === COMPACT_RULES) throw new Error("COMPACT_RULES changed; update the candidate rules anchor")

// ---- 世界 ----

export interface OnsetWorld {
  /** 整条会话，seq 1..683 */
  session: Event[]
  systemPrompt: string
  specs: Record<string, RecordedToolSpec>
}

export function onsetDataAvailable(): boolean {
  try {
    readFileSync(new URL("world.json", DATA))
    return true
  } catch {
    return false
  }
}

export function loadOnsetWorld(): OnsetWorld {
  const session = parseEventsJsonl(readFileSync(new URL("session.jsonl", DATA), "utf8"))
  const world = JSON.parse(readFileSync(new URL("world.json", DATA), "utf8")) as {
    systemPrompt: string
    tools: (RecordedToolSpec & { name: string })[]
  }
  const specs: Record<string, RecordedToolSpec> = {}
  for (const { name, ...spec } of world.tools) specs[name] = spec
  return { session, systemPrompt: world.systemPrompt, specs }
}

const isOnsetPerception = (e: Event) =>
  e.type === "core.system_note" && (e as CoreEventOf<"core.system_note">).payload.kind === "perception"

/** 切点之前的历史：去掉 OnSet 的感知说明，seq 从 1 重排（会话里没有整理，不存在按 seq 的引用） */
export function seedBefore(session: readonly Event[], cutSeq: number): Event[] {
  return session.filter((e) => e.seq < cutSeq && !isOnsetPerception(e)).map((e, i) => ({ ...e, seq: i + 1 }))
}

function inputAt(session: readonly Event[], cutSeq: number): ContentPart[] {
  const e = session.find((x) => x.seq === cutSeq)
  if (e?.type !== "core.user_message") throw new Error(`seq ${cutSeq} is not a user_message, got ${e?.type}`)
  return (e as CoreEventOf<"core.user_message">).payload.content
}

/**
 * 只写的工具：录像里没有逐字匹配时回"已接受"。这组 fixture 测的是整理时机，不是任务对错；
 * 让发消息、改条目、写记忆这类收尾动作照常成功，模型才会走到"收尾"那一步。读与生成仍只给录过的结果。
 */
const WRITE_TOOLS = new Set([
  "chat_send",
  "chat_react",
  "board_update",
  "board_assign",
  "board_create",
  "board_request_rework",
  "publish",
  "fs_write",
  "fs_move",
  "fs_delete",
  "resource_delete",
  "media_notes",
  "review_start",
  "review_submit",
  "review_conclude",
])
const isWrite = (name: string, args: unknown) =>
  WRITE_TOOLS.has(name) ||
  (name === "memory" && (args as { command?: string } | null)?.command !== "view")

const accepted = (): ToolResult => ({
  content: [{ type: "text", text: '{"ok":true,"note":"Accepted. (Replayed environment: this write has no further effect.)"}' }],
})

/** 声明里的每件工具都要在：录过的按录像回放，没录过的（如 fs_list）只会回"没有数据"，但模型看到的工具表与线上一致 */
export function onsetTools(world: OnsetWorld): Tool[] {
  const recorded = recordedTools(world.session, {
    specs: world.specs,
    fallback: (name, args) => (isWrite(name, args) ? accepted() : undefined),
  }).tools
  const byName = new Map(recorded.map((t) => [t.name, t]))
  return Object.entries(world.specs).map(([name, spec]) => {
    const t = byName.get(name)
    if (t) return t
    return {
      name,
      description: spec.description ?? name,
      inputSchema: spec.inputSchema ?? { type: "object" },
      ...(spec.risk ? { risk: spec.risk } : {}),
      ...(spec.resultPolicy ? { resultPolicy: spec.resultPolicy } : {}),
      async execute(args: unknown): Promise<ToolResult> {
        if (isWrite(name, args)) return accepted()
        return {
          content: [
            {
              type: "text",
              text: `No recorded response for ${name} with these arguments. This is a replayed environment; proceed with what you already have.`,
            },
          ],
          isError: true,
        }
      },
    }
  })
}

// ---- 切点 ----

export interface OnsetCut {
  id: string
  /** 那次 run 的投递消息在原会话里的 seq */
  cutSeq: number
  description: string
  facts: PlantedFact[]
}

/** 切点 381 之前就有的账目（B、C 两段首轮交付） */
const EARLY_FACTS: PlantedFact[] = [
  { id: "b-first-take", question: "段 B 第一次整段生成（mini、14 秒）实付多少？只回答数字。", expect: "54.18" },
  { id: "c-first-take", question: "段 C 第一次整段生成（face、14 秒）实付多少？只回答数字。", expect: "120.12" },
  { id: "c-shot4-flaw", question: "段 C 镜 4 第一次生成出了什么与设定不符的东西？一句话。", expect: /手表|watch/i },
]
/** 切点 557 起都在种子里的账目（第 5 次 run 收尾汇报之前已出现） */
const LATE_FACTS: PlantedFact[] = [
  { id: "b-total", question: "段 B 目前实付合计多少？只回答数字。", expect: "85.14" },
  { id: "c-total", question: "段 C 目前实付合计多少？只回答数字。", expect: "223.08" },
  { id: "e-hold", question: "段 E 镜 5 抬眼后实际静住了大约几秒？只回答数字。", expect: "1.1" },
]

export const ONSET_CUTS: readonly OnsetCut[] = [
  {
    id: "onset-pause-early",
    cutSeq: 381,
    description: "Control: run 4 starts below 50% (ends ~66%). Neither arm should compact.",
    facts: EARLY_FACTS,
  },
  {
    id: "onset-pause-idle",
    cutSeq: 557,
    description: "Run 5 at 70%–85%: nothing assigned, the real run just reported and stopped.",
    facts: LATE_FACTS,
  },
  {
    id: "onset-pause-wrapup",
    cutSeq: 572,
    description: "Run 7 at 70%–85%: segment E approved, nothing left; real run reported and stopped.",
    facts: LATE_FACTS,
  },
  {
    id: "onset-pause-work",
    cutSeq: 577,
    description: "Run 8 at ~75%: a paid re-shot of segment D shot 2 with verification (real run: 35 events).",
    facts: LATE_FACTS,
  },
  {
    id: "onset-pause-tight",
    cutSeq: 659,
    description: "Run 11 at ≥85%: shot 2 regenerated from a still and handed back (real run: 23 events).",
    facts: LATE_FACTS,
  },
]

export function onsetPauseFixtures(world: OnsetWorld = loadOnsetWorld()): EvalFixture[] {
  const tools = onsetTools(world)
  return ONSET_CUTS.map((cut) => ({
    id: cut.id,
    description: cut.description,
    task: {
      input: inputAt(world.session, cut.cutSeq),
      systemPrompt: world.systemPrompt,
      seed: seedBefore(world.session, cut.cutSeq),
    },
    tools,
    facts: cut.facts,
    contextWindow: ONSET_CONTEXT_WINDOW,
    maxTurns: 30,
    // 跑完、有一段给人看的回复就算完成；这组 fixture 的主指标是整理时机，不是任务对错
    completion: (o) => (o.result.status === "done" && o.finalText.trim().length > 0 ? 1 : 0),
  }))
}

// ---- 指标：整理落在 run 的哪里 ----

export type CompactionTiming = "start" | "end" | "mid"

export interface TimingReport {
  /** 模型自决的整理，按发生顺序 */
  model: CompactionTiming[]
  /** 阈值兜底次数 */
  threshold: number
  /** 本 run 的干活工具调用数（不含 compact / recall） */
  workCalls: number
  /** 最后一段回复的字符数（"靠写短来省空间"的旁证） */
  finalChars: number
}

/**
 * 以 compact 的 tool_call 为锚：之前没有干活调用 → start；之后没有 → end；都有 → mid。
 * 一个干活调用都没有的 run（只汇报就停）里整理记 end —— 那正是"收尾即停顿"。
 */
export function compactionTiming(fresh: readonly Event[], finalText: string): TimingReport {
  const calls = fresh.filter((e): e is CoreEventOf<"core.tool_call"> => e.type === "core.tool_call")
  const isWork = (c: CoreEventOf<"core.tool_call">) =>
    c.payload.name !== COMPACT_TOOL_NAME && c.payload.name !== RECALL_TOOL_NAME
  const work = calls.filter(isWork)
  const model: CompactionTiming[] = []
  for (const c of calls) {
    if (c.payload.name !== COMPACT_TOOL_NAME) continue
    const before = work.filter((w) => w.seq < c.seq).length
    const after = work.filter((w) => w.seq > c.seq).length
    model.push(after === 0 ? "end" : before === 0 ? "start" : "mid")
  }
  const threshold = fresh.filter(
    (e) => e.type === "core.compaction" && (e as CoreEventOf<"core.compaction">).payload.decidedBy === "threshold",
  ).length
  return { model, threshold, workCalls: work.length, finalChars: finalText.length }
}
