/**
 * 内置的两个对照臂与"缩窗口"包装（§13 对照组：无脑子、纯阈值压缩、模型自决）。
 *
 * - noneArm：什么都不装，连 core 的阈值裁剪也拆掉。窗口装不下就让降级层报错 —— 这是"不管"的真实代价。
 * - thresholdArm：不装脑子，只留 core 投影链缺省的 budgetTruncate（机械折叠 + 兜底摘要）。PRD §7 门槛 2 的对照基线。
 * - 模型自决臂请用 @reinsjs/brain 自己组（本包只依赖 core）：
 *     { name: "brain", sockets: [perception(), compact(), pins(), spill(), budget({...})] }
 *
 * withContextWindow：eval 里把窗口缩到几千 token，让中等长度任务也触发整理。它只改 capabilities，
 * 请求本身不变 —— 模型实际还是那个大窗口，只是循环、投影、感知都按小窗口行事。
 */
import {
  foldCompactions,
  type Lowering,
  type LoweringCapabilities,
  type ModelRef,
  reinjectPins,
  visibilityFilter,
} from "@reinsjs/core"
import type { EvalArm } from "./types.js"

export function noneArm(name = "none"): EvalArm {
  return {
    name,
    sockets: [],
    // 与 defaultProjectionChain 相同，只少最后一步 budgetTruncate
    projection: { strategies: [visibilityFilter(), foldCompactions(), reinjectPins()] },
  }
}

export function thresholdArm(name = "threshold"): EvalArm {
  return { name, sockets: [] }
}

/** 包一层 Lowering，只覆盖 capabilities 的若干字段（常用 contextWindow）；其余调用原样透传 */
export function withCapabilities<P>(
  lowering: Lowering<P>,
  override:
    | Partial<LoweringCapabilities>
    | ((caps: LoweringCapabilities, model: ModelRef) => Partial<LoweringCapabilities>),
): Lowering<P> {
  return {
    capabilities(model) {
      const caps = lowering.capabilities(model)
      const patch = typeof override === "function" ? override(caps, model) : override
      return { ...caps, ...patch }
    },
    toRequest(input) {
      const req = lowering.toRequest(input)
      // 请求里带着的 capabilities 也要一致，循环与脑子从 ctx.capabilities 读的是它
      return { ...req, capabilities: this.capabilities(input.model) }
    },
    stream(req, ctx) {
      return lowering.stream(req, ctx)
    },
  }
}

export function withContextWindow<P>(lowering: Lowering<P>, contextWindow: number): Lowering<P> {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new RangeError(`contextWindow must be a positive finite number, got ${contextWindow}`)
  }
  return withCapabilities(lowering, { contextWindow })
}
