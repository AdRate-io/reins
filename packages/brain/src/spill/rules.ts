/**
 * spill 模块给模型看的文字（技术方案 §9.4）：fetch_blob 工具说明与规则提示。
 *
 * 与 compact / pins 一样，这是"经验"不是"指令"：大结果该不该分页读、读哪段，判断在模型。
 * 作为 Socket 的静态 systemPrompt 片段追加在宿主提示之后，整个 run 逐字不变（§9.1 约束 3）。
 * 用英文写：进的是模型上下文。宿主要换措辞，传 spill({ rules }) 或 rules: false 自己放。
 */

export const FETCH_BLOB_TOOL_NAME = "fetch_blob"

export const FETCH_BLOB_TOOL_DESCRIPTION = [
  "Read a slice of a stored tool output (a blob) by character offsets.",
  "When a tool's output is too large to show inline, the result you see is a preview (first and last lines) plus a blob id;",
  "the complete output is kept verbatim in the blob.",
  "Pass `start` and `end` (0-based character offsets, end exclusive) to read a range; omit them to read from the beginning.",
  "Each call returns at most the same amount that fits inline; the header tells you where to continue.",
].join(" ")

export const SPILL_RULES = `## Large tool outputs
When a tool returns more than fits inline, you see a preview (the first and last lines) and a blob id instead of the full output; nothing is lost, the complete output is stored verbatim. You have a \`${FETCH_BLOB_TOOL_NAME}\` tool to read it by character offsets.
- Read the preview first: often the head and tail already answer the question, or show that the call should be narrowed (a filter, a smaller page, a specific file) rather than paged through.
- Fetch only the ranges you need. Each fetch costs context on every later turn; paging through a huge output end to end is rarely worth it.
- The header of each fetch tells you the total size and where to continue; the offsets are characters, not lines.
- A blob id stays valid for the whole session, including after compaction, so you can note the id in your summary and come back to it.`
