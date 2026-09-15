# runtime-matrix —— Bun / Deno / Vercel Edge 上的运行时兼容性核实（四环境验证）

**结论（2026-09-15）：`@reinsjs/core`、`@reinsjs/lowering-fetch`、`@reinsjs/lowering-pi`、`@reinsjs/tools-mcp` 的打包产物在 Bun 1.4.2、Deno 2.9.6、Vercel 官方本地 Edge 运行时 `edge-runtime` 4.0.1 上全部跑通，库代码一行未改。** fetch 版三条线在四个运行时（含 Node 22 对照）真模型各臂 5/5；pi 版全通的三个宿主条件都出在上游而非 reins：Deno 要 `--allow-sys=osRelease`、Edge 运行时要有 `process` 全局、Bun 要拉高 `Bun.serve` 的空闲超时。

## 为什么这么做

`spikes/edge-runtime-check/` 已把 workerd 最严档验到 15/15，但 PRD 写的是"Node、Bun、Vercel、Cloudflare Workers 四个环境跑通"，根 README 一直挂着 "Bun, Deno and Vercel Edge should work but are not yet tested"。这次把三个空格填上，且要能与 workerd 的结论**并排比**：

- **同一个探针**：直接托管 `../edge-runtime-check/worker.mjs` 的标准 `fetch(request, env)` 处理器，路由、事件、工具、假端点全同。
- **同一份判据**：内容核对抽成 `../edge-runtime-check/fetch-verdict.mjs`（fetch 版原有五格 + 本次补的 pi 版五格），密钥读法抽成 `secrets.mjs`，两个编排器共用。
- **一律打 dist**（B11 教训），运行时装进本目录（`pnpm i --ignore-workspace`，版本 pin），不碰 Boss 机器上的全局。

## 怎么跑

```bash
pnpm build                                    # 仓库根，验的是用户装到的东西
cd spikes/runtime-matrix && pnpm i --ignore-workspace   # 装 bun / deno / edge-runtime / esbuild 到本目录
cd ../..
NO_PROXY=127.0.0.1,localhost node spikes/runtime-matrix/run.mjs             # 六臂，不出外网
NO_PROXY=127.0.0.1,localhost node spikes/runtime-matrix/run.mjs --live      # 每臂追加五格真模型
node spikes/runtime-matrix/run.mjs --live --only bun,deno-sys                # 只跑某几臂
REINS_OAI_MODEL=gpt-5.6-sol node spikes/runtime-matrix/run.mjs --live ...    # aireiter 的 gpt-5.5 过载时换同网关别的模型
```

`NO_PROXY` 必须：本机代理环境变量会把打 `127.0.0.1` 假端点的请求劫走。密钥自动从《模型API测试信息.md》读，只经子进程环境变量传递。

## 六个臂

| 臂 | 宿主 | 用意 |
| --- | --- | --- |
| `node` | Node 22 + `node:http` 手工翻译（`host-node.mjs`） | 基准线：某格在别处红、在这也红，是上游今天的行为不是运行时差异 |
| `bun` | `Bun.serve`（`host-bun.mjs`），直接 import dist | Bun 自己的模块解析 + pnpm 符号链接 node_modules |
| `deno-min` | `Deno.serve`（`host-deno.mjs`），只给 `--allow-net --allow-env` | 最小权限——有权限模型的运行时是最便宜的"谁在偷读系统信息"探测器 |
| `deno-sys` | 同上 + `--allow-sys=osRelease` | 精细到一项的授权是否足够 |
| `edge` | esbuild 把 `edge-entry.mjs` 打成单文件 IIFE（`platform: browser`、conditions `edge-light / worker / browser`、`node:*` external）→ `edge-runtime` 裸 vm → `runServer`（`host-edge.mjs`） | Vercel 部署前必先 bundle 的真实形态；vm 禁 `eval` / `new Function`，无 `process` / `Buffer` / `setImmediate` / `navigator`，动态 `import()` 一律失败 |
| `edge-process` | 同上，vm 上下文里多放一个**只有 `env` 的 `process`** | Vercel 文档对线上 Edge 承诺的最小面就是 `process.env`；用它把"模拟器与线上的差"单独量出来 |

每臂十条路由：pi 版 `/load` `/mcp` `/fake` `/live`（DeepSeek Anthropic 端口）`/live-openai`（aireiter Responses）；fetch 版 `/fetch-load` `/fetch-fake` `/fetch-live-chat`（DeepSeek 直连）`/fetch-live-anthropic`（CF 网关 Haiku 4.5）`/fetch-live-responses`（CF 网关 gpt-5-mini）。

## 实测结果（2026-09-15，每格 = 内容核对，不是状态码）

| 臂 | pi: load | mcp | fake | live-anthropic | live-openai | fetch: load | fake | live-chat | live-anthropic | live-responses |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| node | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| bun | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| deno-min | 通过 | 通过 | **✗ osRelease** | **✗ osRelease** | **✗ osRelease** | 通过 | 通过 | 通过 | 通过 | 通过 |
| deno-sys | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| edge | 通过 | 通过 | 通过 | 通过 | **✗ process.version** | 通过 | 通过 | 通过 | 通过 | 通过 |
| edge-process | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |

三个红格都是**预期内的宿主条件**，不是 reins 的缺陷（详见下节）。pi 版 live-openai 一列走 aireiter，当日 gpt-5.5 上游持续回 "servers overloaded"（Node 对照臂同样红），换同网关 `gpt-5.6-sol` 后 Node / Bun / Deno 同一轮全绿（`call_…|fc_…` 复合 id、usage output 18、Bun / Deno 还命中 4352 cacheRead）；edge-process 是在 gpt-5.5 还正常时通过的。

**各臂运行时面**（`/load` 自述）：

| 臂 | `navigator.userAgent` | `process` | `Buffer` | `setImmediate` | `import("node:fs")` |
| --- | --- | --- | --- | --- | --- |
| node | Node.js/22 | object | function | function | 成功 |
| bun | Bun/1.4.2 | object | function | function | 成功 |
| deno-* | Deno/2.9.6 | object | function | function | 成功 |
| edge | （无） | **undefined** | undefined | undefined | ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING |
| edge-process | （无） | object（只有 env） | undefined | undefined | 同上 |

edge 臂比 workerd 最严档还多缺 `setImmediate` 与 `navigator`，是本矩阵里最严的一档；bundle 1.8 MB（含 pi-ai 两家 SDK 与 MCP client），esbuild 零警告，`node:*` 没有任何一处在模块初始化时被碰。

**内容核对要点**：`/fake` 三个运行时都拼回 `{"city":"上海"}`（字节乱切下 UTF-8 重组对）、签名 40 字符、usage 123 / 42；`/mcp` 都拿到 echo + drop_table（destructive → high + 审批）并真调 echo；fetch 版 `/fetch-live-responses` 都带 `encrypted_content` 的 reasoning 项。

## 三个宿主条件（全出在上游，库不改）

1. **Deno + pi 版要 `--allow-sys=osRelease`。** 调用方是 pi-ai 的 `getPiUserAgent()`：见 `process.versions.node` 就 `process.getBuiltinModule("node:os")` 取 `release()` 拼 UA；Deno 为兼容设了 `process.versions.node`，又把 `os.release()` 归入 `sys` 权限。两家 SDK 对 Deno 走 `Deno.build`，不是它们。fetch 版不读任何系统信息，`--allow-net` 就够（`--allow-read` 两版都不需要）。
2. **Edge 运行时 + pi 版 OpenAI 路径要有 `process` 全局。** `openai` SDK 6.40 的 `detect-platform` 在 `typeof EdgeRuntime !== "undefined"` 分支裸读 `globalThis.process.version`；`@anthropic-ai/sdk` 0.123 同一处是 `process?.version ?? "unknown"`，所以 Anthropic 路径无事。Vercel 线上 Edge 提供 `process.env`（对象存在 → `.version` 是 undefined，不抛）；裸 `edge-runtime` 没有。`edge-process` 臂用只含 `env` 的垫片实证：够。
3. **Bun 宿主要拉高 `Bun.serve({ idleTimeout })`。** 缺省 10 秒，上游慢或 SDK 退避重试时 Bun 无声掐断连接，客户端只见 `fetch failed`、进程无任何日志。探针宿主设 255（上限）。

## 没覆盖什么

- **真 Vercel 部署未测**（要 Boss 的 Vercel 账号）。`edge-runtime` 是 Vercel 官方维护、`next dev` 跑 edge 函数用的那份实现，但线上多的 `process.env` 已用垫片臂单独量出；线上还可能有别的差（如 `node:` 白名单里的 `async_hooks` / `events` / `buffer` / `util`），本矩阵走的路径一处都没碰它们。
- **Netlify Edge、Fastly Compute 等**同属 Web 标准运行时，未验。
- **只测降级层、core 与 tools-mcp 主入口。** `@reinsjs/server`、`store-*`、`brain` 不在此矩阵（brain 主入口零 `node:*`，与 core 同一套约束；store-sqlite 的 `bun:sqlite` 路径见其 README，未在此实证）。
- **只测单轮首个请求**，多轮语义由各自 live spike 覆盖，与运行时无关。

## 编排器自己踩的坑

1. `node_modules/.bin/bun`、`.bin/deno` 是 POSIX shell 包装：kill 包装的 pid 会留下真二进制占着端口，下一臂 `EADDRINUSE`。改 `spawn(..., { detached: true })` + `process.kill(-pid)` 整组收掉，并轮询等端口释放再起下一臂。
2. 探测中途 `fetch failed` 一句话什么都定位不了：编排器抓到失败必须带出宿主退出码与两路输出尾巴（Bun 那次就是这么发现进程活着、stderr 空、是 idleTimeout 在作怪）。
3. pi 版探针的草稿原本只带 `payload摘要` 字符串（200 字截断），核对函数摸不到入参；对齐 fetch 版，`tool_call` 的 `payload` 原样带回。
4. 编排器跑完不退出：残留 keep-alive 连接拖住事件循环，末尾显式 `process.exit(0)`。
