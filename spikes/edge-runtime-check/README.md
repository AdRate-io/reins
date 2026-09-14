# edge-runtime-check —— 降级层在 Cloudflare Workers（workerd）上的运行时兼容性核实

**结论（2026-09-09，pi-ai 0.85.1）：`@reinsjs/lowering-pi` 的打包产物在 workerd 上跑得通，且不需要 `nodejs_compat`。**
两条协议路径（Anthropic Messages / OpenAI Responses）各自真打了一次线上 API，均正常产出事件。

## 为什么要做这个

PRD 把"跑在任何 Web 标准运行时"当卖点，但此前从未在 edge 运行时上实证过。风险点很具体：
降级层经 pi-ai 间接牵进 `@anthropic-ai/sdk` 与 `openai` 两个 SDK，二者的 `exports` **没有 worker / edge 条件导出**
（只有 require / types / default），靠运行时探测打 shim。静态 import 链实测零 `node:` 内置，
但"静态干净"不等于"真能跑"。

一条纪律：**一律打 `dist`，不打源码。** B11 的教训 —— `@reinsjs/store-sqlite` 的 `node:sqlite` 被 tsup 缺省
`removeNodeProtocol` 剥成 `sqlite`，运行时 `ERR_MODULE_NOT_FOUND`，就因为只跑过源码与 vitest 路径。

## 怎么跑

```bash
# 仓库根先构建（验的是用户真正装到的东西）
pnpm build

# 前两层，零成本、不出外网
NO_PROXY=127.0.0.1,localhost node spikes/edge-runtime-check/run.mjs

# 追加两条真 API（密钥自动从《模型API测试信息.md》读，不需要设环境变量）
NO_PROXY=127.0.0.1,localhost node spikes/edge-runtime-check/run.mjs --live
```

`NO_PROXY` 是必须的：本机设了代理环境变量，wrangler 会照用，打 `127.0.0.1` 的假端点会被代理劫走。

## 四层探测 × 三档配置

| 探测 | 打哪 | 验什么 |
| --- | --- | --- |
| `/load` | 不出网 | 模块能否在 workerd 里加载、请求体能否构造、运行时可用面自述 |
| `/fake` | 本地假 Anthropic 端点 | 完整 fetch → SSE 解析 → 事件草稿链路。假端点刻意把工具入参切成两个 `input_json_delta`，并把 SSE 按 7~29 字节乱切（必然切断 UTF-8 多字节字符），压测增量拼装与行缓冲重组 |
| `/live` | DeepSeek `api.deepseek.com/anthropic` | Anthropic Messages 协议真往返（走 `@anthropic-ai/sdk`） |
| `/live-openai` | aireiter `api/v1` gpt-5.5 | OpenAI Responses 协议真往返（走 `openai` SDK，与上一条是**完全不同的代码路径**，必须单独验） |

| 档 | 配置 | 用意 |
| --- | --- | --- |
| 最严档 | `compatibility_date = 2023-01-01`，无 flag | 真正的纯 Web 标准环境 |
| 严格档 | `compatibility_date = 2026-09-09`，无 flag | 当前推荐配置 |
| 宽松档 | 2026 date + `nodejs_compat` | 兜底对照 |

## 实测结果

三档 × 四层，**12 格全部通过**：

| 档 | /load | /fake | /live（Anthropic） | /live-openai |
| --- | --- | --- | --- | --- |
| 最严档 2023，无 compat | 通过 | 通过 | 通过 | 通过 |
| 严格档 2026，无 compat | 通过 | 通过 | 通过 | 通过 |
| 宽松档 nodejs_compat | 通过 | 通过 | 通过 | 通过 |

**各档实际运行时面**（这是结论强度的关键，不能只看"跑通了"）：

| 档 | `process` | `Buffer` | `import("node:fs")` | `import("node:crypto")` |
| --- | --- | --- | --- | --- |
| 最严档 | undefined | undefined | 失败 | 失败 |
| 严格档 | object | function | 成功 | 成功 |
| 宽松档 | object | function | 成功 | 成功 |

**重要发现：Workers 较新的 `compatibility_date` 默认就带上了一部分 Node 兼容**（2026-09-09 这档不加任何
flag 也能 `import("node:fs")`）。所以只跑新 date 会**高估**结论。真正能支撑"纯 Web 标准可跑"的是最严档 ——
那一档 `process` / `Buffer` 都不存在、`node:*` 一律 import 失败，而四层探测照样全过。

**产出内容核对**（HTTP 200 不等于跑通，逐项对过）：

- `/fake` 三档一致：解析出 `core.model_thinking`（签名 40 字符，与假端点给的 base64 等长）+ `core.tool_call`，
  入参拼成 `{"city":"上海"}` —— 两段 `input_json_delta` 增量拼装成功且**中文未乱**，证明字节乱切下的
  UTF-8 重组是对的；usage `input 123 / output 42`、`stopReason toolUse` 全部对上。
- `/live`（DeepSeek）三档均返回真实 thinking 文本、真实 `toolCallId`（如 `call_00_K3Xpz…`）、
  真实 usage；后两档还带 `cacheRead: 256`（重复请求命中自动缓存）。
- `/live-openai`（gpt-5.5）三档均返回 1604 字符的 encrypted reasoning 签名与复合 `toolCallId`
  （`call_…|fc_…`）。thinking 明文 `text` 为空是 OpenAI 侧正常行为（reasoning summary 未请求），不是解析问题。

## 没覆盖什么（别把结论用超）

- **只测了 workerd。** Deno、Bun 未测（本机未装）。Vercel Edge / Netlify Edge 等虽同属 Web 标准运行时，
  各自实现有差异，未验。
- **只测了单轮首个请求。** 多轮回放 thinking 签名、中途 `system_note` 的落点等语义行为不在此列 ——
  那些由 lowering-pi 单测与 `t7-live-roundtrip` 覆盖，与运行时无关。
- **没测 `@reinsjs/server` / `store-*` 在 edge 上的表现。** store-sqlite 明确是 Node-only 可选包，
  store-pg 依赖驱动，本探针只管降级层。
- **体积问题原样存在。** 跑得通不等于跑得轻：pi-ai 把 10 个依赖全列在 `dependencies`，
  安装时无条件下载约 65 M（其中 `@google/genai` 14 M + aws-sdk 全家桶 15 M 在我们的可达链之外，纯死重）。
  这是打包体积与冷启动的隐患，与本探针结论互不抵消。

## 探针自己踩过的两个坑（留给将来复核的人）

1. `worker.mjs` 的块注释里写了 `packages/*/dist` —— 那个 `*/` 提前闭合了注释，后面的中文被当代码解析，
   esbuild 报 `Expected ";" but found "，"`。块注释里别写含 `*/` 的路径。
2. 《模型API测试信息.md》第 135 行有一句**说明文字**也含 `anthropic 协议 baseurl：` 字样，后面紧跟反引号。
   用 `/anthropic 协议 baseurl：\s*(\S+)/` 会先撞上它、抓到一个反引号，`/live` 于是报
   `Invalid URL string.` 却仍返回 HTTP 200（worker 正常返回了错误 JSON）。已改为要求 `https?://` 开头。
   **教训：HTTP 200 从不等于探测通过，必须逐项核对产出内容。** 本次两回假通过都是这么抓出来的。
