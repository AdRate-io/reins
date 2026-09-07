/**
 * 类型层测试：只在 typecheck 阶段生效（tsc -b 包含 src），运行时不执行任何断言。
 * 保证：判别联合能按 type 收窄 payload；createCoreEvent 的 type 与 payload 联动。
 */
import { expectTypeOf } from "vitest"
import type { AnyEvent, CoreEvent, CoreEventOf, ToolCallPayload, UserMessagePayload } from "./core.js"
import { createCoreEvent } from "./create.js"
import { createCoreRegistry } from "./registry.js"

declare const e: CoreEvent
if (e.type === "core.tool_call") {
  expectTypeOf(e.payload).toEqualTypeOf<ToolCallPayload>()
} else if (e.type === "core.user_message") {
  expectTypeOf(e.payload).toEqualTypeOf<UserMessagePayload>()
}

declare const any: AnyEvent
if (any.type.startsWith("ext.")) {
  expectTypeOf(any.payload).toBeUnknown()
}

const reg = createCoreRegistry()
const tc = createCoreEvent(reg, {
  type: "core.tool_call",
  payload: { toolCallId: "1", name: "x", args: {} },
  sessionId: "s",
  seq: 1,
  actor: "model",
})
expectTypeOf(tc).toEqualTypeOf<CoreEventOf<"core.tool_call">>()

// payload 与 type 不匹配必须报错
createCoreEvent(reg, {
  type: "core.model_text",
  // @ts-expect-error tool_call 的载荷不能塞给 model_text
  payload: { toolCallId: "1", name: "x", args: {} },
  sessionId: "s",
  seq: 1,
  actor: "model",
})
