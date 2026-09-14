/**
 * perception —— 感知模块（技术方案 §9.1，B1）。
 *
 * 做法：beforeModel 里算一份档位读数，渲染成文字；若模型当前可见的最后一条感知说明与之逐字相同就什么都不做，
 * 否则 emit 一条 `system_note(kind=perception)`。循环把它 append 到时间线末尾并让模型本轮看到。
 *
 * prompt cache 的五条约束在这里的落实：
 * 1. 只追加在末尾：emit 走循环的 append，seq 在最新 user 消息之后、模型回答之前；前面的历史一字不改。
 * 2. 旧说明不删不隐藏：本模块从不改投影；旧说明随历史留着，整理时一起折叠。
 * 3. 系统提示与工具表稳定：beforeModel 永远返回 undefined，不动 systemPrompt / tools。
 * 4. 断点不自造：靠 pi-ai 的既有断点；降级层负责在改写 system_note 时保住它（lowering-pi/system-note.ts）。
 * 5. 唯一改前缀的是 compaction，那是 compact 模块（B2）的事。
 *
 * "每档只变一次"：所有数值先离散成档位，读数不变 → 文字不变 → 不追加。判重比较的是文字而非读数，
 * 因为宿主自定义 render 后，只要模型看到的东西没变就没必要多一条。
 */
import type { CoreEventOf, Event, Socket, TurnContext } from "@reinsjs/core"
import {
  type PerceptionLimits,
  type PerceptionReading,
  type ReadingThresholds,
  readPerception,
} from "./reading.js"
import { renderPerception } from "./render.js"
import { assertAscending } from "./tiers.js"

export interface PerceptionOptions {
  /** 上下文使用率档位边界（占窗口比例）。缺省 [0.5, 0.7, 0.85] → <50% / 50%–70% / 70%–85% / ≥85% */
  usageTiers?: readonly number[]
  /** 未折叠模型轮数档位边界。缺省 [5, 15, 40] → ≤5 / 6–15 / 16–40 / >40 */
  turnTiers?: readonly number[]
  /** 会话累计 token 档位边界。缺省 [1e4, 5e4, 2e5, 1e6] */
  tokenTiers?: readonly number[]
  /** 外溢结果条数档位边界（0 单独一档）。缺省 [3, 10] → 0 / 1–3 / 4–10 / >10 */
  spillTiers?: readonly number[]
  /** 预算余量比例档位边界。缺省 [0.05, 0.2, 0.5] → <5% / 5%–20% / 20%–50% / ≥50% */
  remainingTiers?: readonly number[]
  /** 本次 run 的上限；给了才报"余量"。与 budget 模块（B8）传同一份 */
  limits?: PerceptionLimits
  /** 用上一请求的真实用量校准上下文使用率（B8）。缺省 true */
  calibrate?: boolean
  /** 自定义措辞 / 语言；必须是纯函数（同一读数同一文字），否则每轮都会追加 */
  render?: (reading: PerceptionReading) => string
}

export const DEFAULT_PERCEPTION_THRESHOLDS: ReadingThresholds = {
  usage: [0.5, 0.7, 0.85],
  turns: [5, 15, 40],
  tokens: [10_000, 50_000, 200_000, 1_000_000],
  spills: [3, 10],
  remaining: [0.05, 0.2, 0.5],
}

export const PERCEPTION_SOCKET_NAME = "perception"

type PerceptionNote = CoreEventOf<"core.system_note">

/** 模型当前可见的最后一条感知说明；没有（从未注入或已被折叠）返回 undefined */
export function lastVisiblePerceptionNote(visible: readonly Event[]): PerceptionNote | undefined {
  for (let i = visible.length - 1; i >= 0; i--) {
    const e = visible[i] as PerceptionNote | undefined
    if (e?.type === "core.system_note" && e.payload.kind === "perception") return e
  }
  return undefined
}

export function perception(opts: PerceptionOptions = {}): Socket {
  const thresholds: ReadingThresholds = {
    usage: opts.usageTiers ?? DEFAULT_PERCEPTION_THRESHOLDS.usage,
    turns: opts.turnTiers ?? DEFAULT_PERCEPTION_THRESHOLDS.turns,
    tokens: opts.tokenTiers ?? DEFAULT_PERCEPTION_THRESHOLDS.tokens,
    spills: opts.spillTiers ?? DEFAULT_PERCEPTION_THRESHOLDS.spills,
    remaining: opts.remainingTiers ?? DEFAULT_PERCEPTION_THRESHOLDS.remaining,
  }
  for (const [name, bounds] of Object.entries(thresholds)) assertAscending(`perception.${name}`, bounds)
  const render = opts.render ?? renderPerception

  return {
    name: PERCEPTION_SOCKET_NAME,
    beforeModel(ctx: TurnContext) {
      const reading = readPerception(ctx, thresholds, opts.limits, {
        ...(opts.calibrate !== undefined ? { calibrate: opts.calibrate } : {}),
      })
      const text = render(reading)
      if (lastVisiblePerceptionNote(ctx.events)?.payload.text === text) return undefined
      ctx.emit({
        type: "core.system_note",
        actor: "system",
        payload: { kind: "perception", text, meta: { reading } },
      })
      return undefined
    },
  }
}
