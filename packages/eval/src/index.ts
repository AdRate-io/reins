/**
 * @reins/eval —— eval harness（技术方案 §13，M2 E1）。
 *
 * - types：fixture（种子日志 + 任务 + 评分器）、臂、指标、报告的形状
 * - jsonl：事件 JSONL 读写，读是 fail-closed 的（过注册表升级）
 * - recorded-tools：从录像回放的确定性工具，让三个臂面对同一个世界
 * - recording：把真实录像整理成 fixture 素材（拼回外溢全文、逐字脱敏）
 * - metrics：从时间线算指标的纯函数（token、缓存命中、轮 / 工具 / 重复调用、整理次数与连续数、治理衰减窗）
 * - arms：内置 none / threshold 两臂，以及缩窗口的 Lowering 包装；模型自决臂由调用方用 @reins/brain 组
 * - runner：fixture × 臂 × 重复的对照运行器，含审批代答、预算续跑、handoff 跟随、分叉探针问答
 * - gate：PRD §7 门槛 2 / P8 的四条硬规则
 * - report：Markdown 表
 *
 * 只依赖 @reins/core，零 node:*；文件读写与 CLI 在调用方（examples/eval）。
 */
export * from "./arms.js"
export * from "./gate.js"
export * from "./jsonl.js"
export * from "./metrics.js"
export * from "./recorded-tools.js"
export * from "./recording.js"
export * from "./report.js"
export * from "./runner.js"
export * from "./types.js"
