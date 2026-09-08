/**
 * handoff 模块给模型看的文字（技术方案 §9.5）：工具说明与规则提示。
 *
 * 经验不是指令：什么时候该换一个新会话继续，判断在模型。作为 Socket 的静态 systemPrompt 片段
 * 追加在宿主提示之后，整个 run 逐字不变（§9.1 约束 3）。英文：进的是模型上下文。
 */

export const HANDOFF_TOOL_NAME = "handoff"

export const HANDOFF_TOOL_DESCRIPTION = [
  "End this session at the end of the current turn and continue the work in a fresh session.",
  "The new session starts with only your `summary`, your `nextSteps`, the pinned notes, and the message it should act on;",
  "nothing else from this session is carried over. Write the summary for a colleague who has seen none of this conversation.",
  "Other tool calls in the same turn still run before the handoff happens.",
].join(" ")

export const HANDOFF_RULES = `## Handing off to a new session
You have a \`${HANDOFF_TOOL_NAME}\` tool that ends this session and starts a fresh one carrying only your summary, next steps, and the pinned notes.
- Hand off when the history is mostly spent context rather than useful memory: a long task has reached a clean phase boundary, or compaction has already happened several times and the summaries are what you actually work from. Prefer compacting while the current context is still worth keeping.
- Do not hand off in the middle of a step, with tool results you have not read yet, or when the user is waiting for an answer to a direct question. Answer first.
- The summary is the whole memory of the next session: state the goal in the user's words, what is done and what was decided and why, the exact state of anything half-finished, and identifiers (paths, ids, numbers) the next session will need. Put one concrete action per item in \`nextSteps\`.
- Outputs stored as blobs in this session are not readable from the new one; copy what matters into the summary.`
