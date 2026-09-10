# 模块盘点：`reins`（总包）

> 依据 `packages/reins/src/` 的实际代码（2026-09-10，`main` @ 9e0b99e）。与 `docs/技术方案.md` §12 的 T14 条目核对，冲突以代码为准。

## 1 架构概览

`reins` 是"装一个包就能用"的门面，本身只有 85 行实现。它做两件事：提供 `createAgent`，以及原样再导出 `@reins/core`、`@reins/server`、`@reins/ui-agui` 三个包的全部公开面。降级层（`@reins/lowering-pi`，带 pi-ai 依赖）**不**在再导出之列，要单独 import。

`createAgent` 不引入任何新概念，只做两次拆包 + 一个缺省值：把 `BoundModel` 拆成 `model` + `lowering`，把 `Stores` 拆成 `log` / `blobs` / `memory`，拼成 `AgentDefinition`；再用它建 handler，缺省编码换成 AG-UI。

```
CreateAgentOptions { model: BoundModel, store: Stores, handler?: HandlerOptions, ...其余 AgentDefinition 字段 }
        │
        ├─ model.model + model.lowering ──┐
        ├─ store.log / blobs? / memory? ──┼──▶ definition: AgentDefinition
        └─ ...rest（tools / sockets / systemPrompt / secret …）┘
                                             │
             ┌───────────────────────────────┴────────────────────────────┐
             ▼                                                            ▼
  createAgentHandler(definition,                              run(options?) =
      { encode: aguiEncoding(), ...handlerOptions })            runLoop({ ...definition,
             │                                                    ...stripUndefined(perRun),
             ▼                                                    sessionId: sessionId ?? uuidv7() })
  Agent.handler: (Request, ctx?) => Promise<Response>          Agent.run: AsyncGenerator<Event, RunResult>
```

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `packages/reins/package.json` | 包元数据：包名就是 `reins`，单个 exports，依赖 `@reins/core` + `@reins/server` + `@reins/ui-agui`（无 lowering-pi） |
| `packages/reins/tsconfig.json` / `tsup.config.ts` | 单入口打 ESM + `.d.ts`；打声明时清空 `paths`，否则依赖包的类型会被内联而不是保留 import |
| `packages/reins/src/index.ts` | 门面：`export * from` core / server / ui-agui 三包，加上 `createAgent` 与 `Agent` / `CreateAgentOptions` / `RunOptions` 三个类型 |
| `packages/reins/src/create-agent.ts` | 全部实现：`CreateAgentOptions`、`RunOptions`、`Agent` 三个接口，`createAgent` 与内部的 `stripUndefined` |
| `packages/reins/src/create-agent.test.ts` | 测试。覆盖：handler 缺省 AG-UI 编码（POST 一次拿到 `RUN_STARTED … RUN_FINISHED`）、`handler` 选项可覆盖编码改推原始事件、`run()` 不经 HTTP 直接跑且缺省新建会话、事件都落进 `store.log` |

## 3 核心流程

**装配**（`createAgent`）

1. 解构出 `model` / `store` / `handler`（选项名 `handler`，即 `HandlerOptions`），其余字段 `...rest` 原样进 definition。
2. 拼 `definition: AgentDefinition` —— `model: model.model`、`lowering: model.lowering`、`log: store.log`；`store.blobs` / `store.memory` 存在才加键（`exactOptionalPropertyTypes` 下不能传 `undefined`）。
3. `createAgentHandler(definition, { encode: aguiEncoding(), ...handlerOptions })` —— `encode` 写在前面，所以宿主传自己的 `encode`（例如 `() => rawEncoder`）会覆盖 AG-UI 缺省；`principal` / `authorizeSession` / `onDisconnect` 等其余 `HandlerOptions` 一并透传。
4. 返回 `{ definition, handler, run }`。`definition` 暴露出来，是为了让人能自己起 `runLoop` 或接别的传输层。

**直接跑**（`Agent.run`）

1. 从 `RunOptions` 里摘出 `sessionId`，其余（`input` / `resume` / `decisions` / `principal` / `signal` / `onDelta`）过 `stripUndefined` 去掉没给的键。
2. `runLoop({ ...definition, ...perRun, sessionId: sessionId ?? uuidv7() })` —— 不经 HTTP，`yield` 每条刚 append 的事件，返回 `RunResult` 四态。给脚本 / 队列 / 测试用。

## 4 核心设计决策

- **T14 总包只做 `createAgent` 并原样再导出 core / server / ui-agui，不导出 lowering-pi** — 一个包装完即用，但把带 pi-ai 依赖的降级层留在可选包，才能换别的降级层实现而不必带着它。边界：DECISIONS 标注"中，发布前可调"。
- **T14 handler 缺省 AG-UI 编码** — PRD 定的"AG-UI 是一等输出"；想推原始时间线事件传 `handler: { encode: () => rawEncoder }` 覆盖。注意这与 `@reins/server` 直接用时的缺省相反（那边缺省是 `rawEncoder`）。
- **T14 `apiKey` 必填、不读环境变量** — 沿用 T7 决策，key 由宿主决定来源；显式传 key 才能让 Workers / Deno 等没有 `process.env` 的运行时跑同一份代码。`BoundModel = { model, lowering }` 与 `Stores = { log, blobs?, memory? }` 都定义在 core，工厂 `anthropic(id, { apiKey })` / `openai(...)` 在 lowering-pi。
- **`createAgent` 不引入新概念** — `definition` 就是 `runLoop` 的跨请求配置，`handler` 就是 `createAgentHandler`；本包只负责拆 `BoundModel` 与 `Stores`。这样"只装脑子不装底盘"的人跳过总包也不会看到两套说法。
- **`stripUndefined` 而不是逐字段展开** — 仓库开了 `exactOptionalPropertyTypes`，把 `undefined` 传给可选字段是类型错误；`run()` 的每次参数是六个可选键，逐个写条件展开太啰嗦。
