/**
 * 用量与成本（三线共用）。`TokenUsage` 语义跟随 core：`input` 是**未命中缓存**的输入 token，缓存读 / 写另计。
 * 各协议的原生用量字段在各自 from-stream 里换算成这个形状，这里只算钱。
 */
import type { TokenUsage } from "@reinsjs/core"

/** 每百万 token 的美元价。厂商有峰谷价的（DeepSeek）内置表存峰值价，算出来的是估算上限 */
export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  /** 缓存写价；Anthropic 是 5 分钟存活期的价（输入价 × 1.25） */
  cacheWrite: number
  /** Anthropic 1 小时存活期的缓存写价；缺省按输入价 × 2（厂商公布倍率） */
  cacheWrite1h?: number
}

/** costOf 的可选细分：缓存写里有多少是 1 小时存活期（只有 Anthropic 线有这一档） */
export interface CacheWriteSplit {
  cacheWrite1h?: number
}

/** 1 小时缓存写的单价：价目给了就用，否则输入价 × 2 */
export function cacheWrite1hPrice(cost: ModelCost): number {
  return cost.cacheWrite1h ?? cost.input * 2
}

/** 算不出（没有价目）返回 undefined，LoweringOutcome.costUsd 相应缺省 */
export function costOf(
  usage: TokenUsage,
  cost: ModelCost | undefined,
  split: CacheWriteSplit = {},
): number | undefined {
  if (!cost) return undefined
  const perToken = (n: number | undefined, price: number) => ((n ?? 0) * price) / 1_000_000
  const writes = usage.cacheWrite ?? 0
  // 1 小时那部分按 1h 价，其余按 cacheWrite；细分数超过总数时以总数为界
  const oneHour = Math.min(Math.max(split.cacheWrite1h ?? 0, 0), writes)
  return (
    perToken(usage.input, cost.input) +
    perToken(usage.output, cost.output) +
    perToken(usage.cacheRead, cost.cacheRead) +
    perToken(writes - oneHour, cost.cacheWrite) +
    perToken(oneHour, cacheWrite1hPrice(cost))
  )
}
