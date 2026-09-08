/**
 * @reins/brain —— 预装的"驾驭经验"（技术方案 §9）。
 *
 * 每个模块是一个 Socket（或 Socket + 工具），只依赖 @reins/core 的契约，不依赖 runLoop 的实现；
 * 每个都可以单独不装、按模型族配置。宪法一：模块只让模型看见、给它能力、给它边界、给它记录，不替它决定。
 *
 * - perception/：感知（B1）。把上下文用量、历史长度、预算余量等按档位写成 system_note 追加到时间线末尾
 * - compact/：自主整理（B2）。compact 工具 + 规则提示；阈值兜底复用 core 投影链；连续整理上限 → 暂停
 * - pins/：幸存契约（B3）。宿主声明的 pin（静态 / 抽取）+ 模型 pin 工具；幸存与重注入本身在 core 投影链
 * - spill/：结果外溢（B4）。超限的工具结果全文进 BlobStore，模型看首尾预览 + blob id，用 fetch_blob 分段取回
 * - handoff/：会话交接（B5）。handoff 工具把摘要、下一步、可见的 pin 带进新会话；机械部分在 core 循环
 * - memory/：记忆（B6）。memory 工具（形状对齐 memory_20250818）读写宿主的 MemoryStore，路径限定 /memories，每次读写留 memory_op
 * - approval/：审批与权限（B7）。deny → ask → allow 策略管线在 beforeTool 里跑：deny 留 approval_decision 再拦，ask 转审批暂停，allow 放行；fail-closed
 * - budget/：预算（B8）。五维上限（contextTokens / totalTokens / turns / toolCalls / wallMs），触顶且模型还要继续 → pause(budget)
 */
export * from "./approval/index.js"
export * from "./budget/index.js"
export * from "./compact/index.js"
export * from "./handoff/index.js"
export * from "./memory/index.js"
export * from "./perception/index.js"
export * from "./pins/index.js"
export * from "./spill/index.js"
