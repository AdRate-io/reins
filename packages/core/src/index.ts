/**
 * @reins/core
 *
 * 两条原则：
 * 1. 决策权默认在模型。库只做四件事：让它看见、给它能力、给它边界、给它记录。
 * 2. 时间线是唯一真源，角色只是翻译。
 *
 * 模块：
 * - events/：事件模型、schema 注册表与升级（T3）
 * - store/：EventLog / BlobStore / MemoryStore 接口与内存实现（T4）
 * - projection/：投影策略链，从时间线算出模型本轮看到什么（T6）
 * - testing/：存储一致性套件，单独入口 @reins/core/testing（T5）
 */
export * from "./events/index.js"
export * from "./projection/index.js"
export * from "./store/index.js"

export const REINS_VERSION = "0.0.0"
