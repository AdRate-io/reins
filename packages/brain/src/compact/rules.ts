/**
 * compact 模块给模型看的文字（技术方案 §9.2）：工具说明与规则提示。
 *
 * 规则提示是"一等交付物"：什么时候整理、什么时候别整理，是模型判断，但判断需要经验 —— 这段话就是经验。
 * 它作为 Socket 的静态 systemPrompt 片段追加在宿主系统提示之后，整个 run 逐字不变（prompt cache 约束 3）；
 * 每轮变化的读数（上下文用了多少）由 perception 模块以 system_note 追加在末尾，两者分工不重叠。
 *
 * 用英文写：进的是模型上下文，不是给人看的日志。宿主要换措辞，传 compact({ rules }) 或 rules: false 自己放。
 */

export const COMPACT_TOOL_NAME = "compact"

export const COMPACT_TOOL_DESCRIPTION = [
  "Fold earlier conversation into a summary you write, freeing context window.",
  "Everything visible before the current turn (or before the last `keepRecentTurns` model turns) is replaced by your summary;",
  "the originals stay in the session log but you will no longer see them.",
  "Earlier summaries inside the folded range are replaced too — carry forward whatever still matters.",
  "The most recent user message and pinned notes survive verbatim, so you need not repeat them.",
].join(" ")

export const COMPACT_RULES = `## Managing your context window
You have a \`${COMPACT_TOOL_NAME}\` tool that folds earlier conversation into a summary you write. Runtime notes titled "Runtime context status" tell you how full the window is.
- Compact when a sub-task is finished or the trajectory has converged and the folded details are no longer needed verbatim. Do it at a natural pause, not while acting on something.
- Do not compact in the middle of a derivation, while a problem is still unresolved, or when you feel stuck: you would lose exactly the details you still need.
- The summary replaces everything it folds, including earlier summaries. Carry forward the user's goals and constraints, decisions made and why, the current state, and what comes next. List each fact that must survive in \`keep\`. The most recent user message and pinned notes survive verbatim on their own; check the pins still say what you need.
- If you never compact, the harness folds the oldest turns mechanically once the window nears its limit. Its summary is worse than yours.`
