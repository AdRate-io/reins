/**
 * memory 模块给模型看的文字（技术方案 §9.6）：工具说明与规则提示。
 *
 * 工具名与六个 command 与 Anthropic 的 `memory_20250818` 同名同义，模型对这个形状已有训练：
 * 先看 /memories、把进展写进去、假定随时会被打断。规则提示按 §9.6 的三句经验写：任务开始先查记忆；
 * 只记未来有用的；不记能从代码或文档推出的。这是"经验"不是"指令"：记什么、什么时候记，判断在模型。
 * 作为 Socket 的静态 systemPrompt 片段追加在宿主提示之后，整个 run 逐字不变（§9.1 约束 3）。英文：进的是模型上下文。
 */

export const MEMORY_TOOL_NAME = "memory"

export const MEMORY_TOOL_DESCRIPTION = [
  "Read and write files in your memory directory `/memories`, which persists across sessions.",
  "Commands: `view` shows a directory listing or a file with line numbers (optional `view_range: [start, end]`, `end` -1 means to the end);",
  "`create` creates or overwrites a file with `file_text`;",
  "`str_replace` replaces exactly one occurrence of `old_str` with `new_str` (omit `new_str` to delete it);",
  "`insert` inserts `insert_text` after line `insert_line` (0 inserts at the top);",
  "`delete` removes a file or a whole directory; `rename` moves `old_path` to `new_path` (the destination must not exist).",
  "Every path must start with `/memories`; the root itself cannot be deleted or renamed.",
].join(" ")

export const MEMORY_RULES = `## Memory
You have a \`${MEMORY_TOOL_NAME}\` tool: a directory \`/memories\` that persists across sessions, while everything else in this conversation is forgotten when it ends.
- Before starting a task, \`view\` \`/memories\` and read the files that look relevant. Earlier sessions may have left progress, decisions, or lessons there.
- Record what a future session would need and could not re-derive: the goal in the user's words, decisions and the reasons behind them, open questions, lessons from mistakes, where things are. Do not store what can be read from the code or documents, transient state, or secrets and credentials.
- Assume interruption: your context may be reset at any moment. Update memory as you make progress, not only at the end.
- Keep it organized: small files with clear names, rewrite a fact when it changes instead of appending a second version, delete what is no longer true.`
