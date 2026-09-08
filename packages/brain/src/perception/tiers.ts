/**
 * 档位离散化。感知说明里的每个数字都先落到一个档位再给模型看，理由（技术方案 §9.1）：
 * 精确值每轮都变，会让每轮都多一条说明；档位一段会话只变三四次，说明条数与 token 都可控。
 */

export interface Tier {
  /** 档位序号，0 起；eval 与回放按它对比，不必解析标签 */
  level: number
  /** 给模型看的标签 */
  label: string
}

/** 边界必须严格升序，否则档位没有意义；在构造期就拒绝 */
export function assertAscending(name: string, bounds: readonly number[]): void {
  for (let i = 0; i < bounds.length; i++) {
    const cur = bounds[i]
    const prev = bounds[i - 1]
    if (cur === undefined || !Number.isFinite(cur) || (prev !== undefined && cur <= prev)) {
      throw new RangeError(`${name} 的档位边界必须是严格升序的有限数：${JSON.stringify(bounds)}`)
    }
  }
}

/**
 * 连续量（比例、token 数）：<b0 | b0–b1 | … | ≥bn。
 * 值恰在边界上归入上一档（≥），与"85%+ 才算高"直觉一致。
 */
export function rangeTier(value: number, bounds: readonly number[], fmt: (n: number) => string): Tier {
  let level = 0
  while (level < bounds.length && value >= (bounds[level] as number)) level++
  const lo = bounds[level - 1]
  const hi = bounds[level]
  if (lo === undefined) return { level, label: `<${fmt(hi as number)}` }
  if (hi === undefined) return { level, label: `≥${fmt(lo)}` }
  return { level, label: `${fmt(lo)}–${fmt(hi)}` }
}

/** 计数量（轮数、条数）：≤b0 | b0+1–b1 | … | >bn */
export function countTier(value: number, bounds: readonly number[]): Tier {
  let level = 0
  while (level < bounds.length && value > (bounds[level] as number)) level++
  const lo = bounds[level - 1]
  const hi = bounds[level]
  if (lo === undefined) return { level, label: `≤${hi}` }
  if (hi === undefined) return { level, label: `>${lo}` }
  return { level, label: lo + 1 === hi ? `${hi}` : `${lo + 1}–${hi}` }
}

export const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

/** 10000 → 10k，1500000 → 1.5M；小于 1000 原样 */
export function compactNumber(n: number): string {
  const trim = (x: number) => String(Number(x.toFixed(1)))
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}k`
  return String(n)
}
