/**
 * 读数 → 给模型看的文字。只陈述事实，不下指令：什么时候整理、要不要交接是模型的判断（宪法一），
 * 规则提示属于 compact 模块（B2）且放在稳定的系统提示里，不在这条每次变档才出现的说明里。
 *
 * 用英文写：这段话进的是模型上下文而不是给人看的日志，英文 token 更省，且各家模型都熟。
 * 宿主要换措辞或语言，给 perception() 传自己的 render。
 */
import type { PerceptionReading } from "./reading.js"

/**
 * 说清"折叠"到底拿走了什么。E3 实测（DeepSeek v4 flash）：只写"compactions so far: 1"时，模型会把仍在视野里的早期工具结果
 * 当成"已被折叠"，被问到时拒答"不编造"—— 其实那条结果就在上文。这句话只随整理次数变，不引入每轮变化的数字，不扰动缓存。
 */
function foldedNote(compactions: number): string {
  return compactions === 0
    ? "(nothing has been folded; everything above is verbatim)"
    : "(only the ranges those summaries replaced are gone; every tool result still shown above is verbatim)"
}

export function renderPerception(r: PerceptionReading): string {
  const lines = [
    "Runtime context status (from the harness, not from the user):",
    `- Context window used: ${r.contextUsage.label} (the harness auto-folds the oldest turns at ${r.autoFoldAt})`,
    `- Unfolded history: ${r.unfoldedTurns.label} turns; compactions so far: ${r.compactions} ${foldedNote(r.compactions)}`,
    `- Session tokens used: ${r.sessionTokens.label}`,
  ]
  if (r.budgetRemaining) {
    lines.push(`- Run budget remaining: ${r.budgetRemaining.label} (tightest: ${r.budgetRemaining.tightest})`)
  }
  if (r.spilledResults.level > 0) {
    lines.push(`- Tool results spilled out of the context: ${r.spilledResults.label}`)
  }
  return lines.join("\n")
}
