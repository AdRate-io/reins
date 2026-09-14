/**
 * createAgent：把"模型 + 工具 + 存储 + 脑子"装成一个 agent 对象，给出两种用法 ——
 * `handler`（Web 标准 (Request) => Response，缺省 AG-UI 编码）和 `run()`（不经 HTTP 直接跑，脚本 / 队列 / 测试用）。
 *
 * 它不引入新概念：AgentDefinition 就是 runLoop 的跨请求配置，handler 就是 createAgentHandler。
 * 这里只负责把 BoundModel 拆成 model + lowering、把 Stores 拆成 log / blobs / memory（runLease 则换成 handler 的登记表）。
 */
import {
  type ApprovalDecisionInput,
  type BoundModel,
  type ContentPart,
  type Event,
  type EventDraft,
  type LoweringDelta,
  type Principal,
  type RunResult,
  runLoop,
  type SerializedRunState,
  type Stores,
  uuidv7,
} from "@reinsjs/core"
import {
  type AgentDefinition,
  type AgentHandler,
  createAgentHandler,
  type HandlerOptions,
  leasedRunRegistry,
} from "@reinsjs/server"
import { aguiEncoding } from "@reinsjs/ui-agui"

export interface CreateAgentOptions
  extends Omit<AgentDefinition, "model" | "lowering" | "log" | "blobs" | "memory"> {
  /** `anthropic("claude-opus-5", { apiKey })` 之类工厂的返回值，或自己组的 { model, lowering } */
  model: BoundModel
  /**
   * `memoryStore()`、`sqliteStores(db)`、`await pgStores(client)`（B9）或自己实现的一套接口；只有 log 必需。
   * 带 `runLease` 时 handler 自动用跨进程的租约登记表（D4）——多实例部署同一条会话同时只跑一个 run
   */
  store: Stores
  /** 传输层选项；缺省 AG-UI 编码（`encode: aguiEncoding()`），想推原始事件就传 `encode: () => rawEncoder` */
  handler?: HandlerOptions
}

/** `agent.run()` 的每次参数：与 HTTP 请求体是同一组字段，多了 signal / onDelta / principal 这些进程内才有的 */
export interface RunOptions {
  /** 缺省新建会话；结果的 sessionId 告诉你它是什么 */
  sessionId?: string
  input?: string | ContentPart[] | EventDraft
  resume?: SerializedRunState
  decisions?: readonly ApprovalDecisionInput[]
  principal?: Principal
  signal?: AbortSignal
  onDelta?: (delta: LoweringDelta) => void
}

export interface Agent {
  /** 跨请求不变的循环配置；要自己起 runLoop 或接别的传输层时用它 */
  readonly definition: AgentDefinition
  /** Web 标准 handler：POST 起 run、GET 补发，见 @reinsjs/server */
  readonly handler: AgentHandler
  /** 不经 HTTP 直接跑一次：yield 每条刚 append 的事件，返回 RunResult 四态 */
  run(options?: RunOptions): AsyncGenerator<Event, RunResult>
}

export function createAgent(options: CreateAgentOptions): Agent {
  const { model, store, handler: handlerOptions, ...rest } = options
  const definition: AgentDefinition = {
    ...rest,
    model: model.model,
    lowering: model.lowering,
    log: store.log,
    ...(store.blobs ? { blobs: store.blobs } : {}),
    ...(store.memory ? { memory: store.memory } : {}),
  }
  // store 带 runLease（如 pgStores）就自动装跨进程的租约登记表（D4），宿主不用记这一步；自己传 handler.runs 则以宿主为准
  const runs =
    store.runLease !== undefined
      ? {
          runs: leasedRunRegistry(store.runLease, {
            ...(handlerOptions?.warn !== undefined ? { warn: handlerOptions.warn } : {}),
          }),
        }
      : {}
  const handler = createAgentHandler(definition, { encode: aguiEncoding(), ...runs, ...handlerOptions })
  return {
    definition,
    handler,
    run(runOptions = {}) {
      const { sessionId, ...perRun } = runOptions
      return runLoop({ ...definition, ...stripUndefined(perRun), sessionId: sessionId ?? uuidv7() })
    },
  }
}

/** exactOptionalPropertyTypes 下不能把 undefined 传给可选字段，这里把没给的键去掉 */
function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}
