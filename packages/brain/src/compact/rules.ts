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

/**
 * 取回工具（E3c）。整理会丢细节是机制本身的代价（两个模型族都把"复核过的字段值"整理成了"状态正常"这一句结论）；
 * 与其教模型该留什么，不如让它知道**什么还能拿回来**：摘要下面列出被折叠的每条工具结果，`recall({ seq })` 逐字取回。
 * 原件本来就在日志里（宪法二），这只是给模型一条读回去的路，与 spill 的 fetch_blob 同理。
 */
export const RECALL_TOOL_NAME = "recall"

export const COMPACT_TOOL_DESCRIPTION = [
  "Fold earlier conversation into a summary you write, freeing context window.",
  "Everything visible before the current turn (or before the last `keepRecentTurns` model turns) is replaced by your summary;",
  "the originals stay in the session log but you will no longer see them.",
  "Earlier summaries inside the folded range are replaced too — carry forward whatever still matters.",
  "The most recent user message and pinned notes survive verbatim, so you need not repeat them.",
  `Under your summary the harness lists every folded tool result (seq, tool, arguments); any of them can be brought back verbatim later with \`${RECALL_TOOL_NAME}\`.`,
].join(" ")

export const RECALL_TOOL_DESCRIPTION = [
  "Bring back, verbatim, a tool result that was folded away by a compaction.",
  "Each summary lists its folded tool results as `seq N tool(arguments)`; pass that `seq`.",
  "The original output is returned exactly as the tool produced it (large outputs are stored as blobs and read with fetch_blob instead).",
  "Use it when you need a value that the summary only mentioned or left out; each recall costs a turn and stays in context afterwards.",
].join(" ")

export const COMPACT_RULES = `## Managing your context window
You have a \`${COMPACT_TOOL_NAME}\` tool that folds earlier conversation into a summary you write. Runtime notes titled "Runtime context status" tell you how full the window is.
- Compact when a sub-task is finished or the trajectory has converged and the folded details are no longer needed verbatim. Do it at a natural pause, not while acting on something.
- Do not compact in the middle of a derivation, while a problem is still unresolved, or when you feel stuck: you would lose exactly the details you still need.
- The summary replaces everything it folds, including earlier summaries. Carry forward the user's goals and constraints, decisions made and why, the current state, and what comes next. List each fact that must survive in \`keep\`. The most recent user message and pinned notes survive verbatim on their own; check the pins still say what you need.
- Keep exact values, not just conclusions: identifiers, status and enum fields you verified, numbers, dates, error codes. "Checked, all ENABLE" loses the field values themselves.
- Nothing folded is lost for good: under each summary the harness lists the folded tool results as \`seq N tool(arguments)\`, and \`${RECALL_TOOL_NAME}({ seq })\` brings one back verbatim. When asked about a detail your summary did not keep, recall the result that contained it instead of guessing or saying it is gone.
- If you never compact, the harness folds the oldest turns mechanically once the window nears its limit. Its summary is worse than yours, but it lists the folded tool results the same way.`
