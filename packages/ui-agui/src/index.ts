/**
 * @reins/ui-agui —— 时间线事件 → AG-UI 协议事件。
 *
 * - `mapEvent` / `AGUI_MAPPING`：一条完整事件的纯映射与映射表
 * - `createAguiEncoder`：一条流一个实例，把 @reins/server 的 StreamItem（含流式增量）翻成 AG-UI 事件
 * - `aguiEncoding()`：直接塞进 `createAgentHandler(agent, { encode: aguiEncoding() })`
 * 运行时零依赖；事件形状在测试里用 @ag-ui/core 的官方 schema 逐条校验。
 */
export { type AguiEncoderOptions, aguiEncoding, createAguiEncoder } from "./encoder.js"
export { AGUI_MAPPING, type MapContext, mapEvent, partsToText, reinsMetadata } from "./map-event.js"
export type * from "./types.js"
