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
  cacheWrite: number
}

/** 算不出（没有价目）返回 undefined，LoweringOutcome.costUsd 相应缺省 */
export function costOf(usage: TokenUsage, cost: ModelCost | undefined): number | undefined {
  if (!cost) return undefined
  const perToken = (n: number | undefined, price: number) => ((n ?? 0) * price) / 1_000_000
  return (
    perToken(usage.input, cost.input) +
    perToken(usage.output, cost.output) +
    perToken(usage.cacheRead, cost.cacheRead) +
    perToken(usage.cacheWrite, cost.cacheWrite)
  )
}
