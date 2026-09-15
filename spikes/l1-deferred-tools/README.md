# l1-deferred-tools — lazy-tools 的 provider 原生路径核实（2026-09-15）

> 对应任务「lazy-tools 的 provider 原生路径」。D1 实测取回工具后 Anthropic 缓存整段重写（频繁换任务贵 1.7 倍）；官方有 `defer_loading` + `tool_reference`（GA、无 beta 头）能让工具表整段不变。进代码前先核实厂商规矩，判据全部是产出内容。
> 运行：`node spikes/l1-deferred-tools/probe.mjs [haiku|opus|deepseek|all]`（裸 fetch，测厂商规矩）；`pnpm build` 后 `node spikes/l1-deferred-tools/live.mjs [haiku|opus]`（`runLoop + lazyTools() + @reinsjs/lowering-fetch` 端到端）；`node spikes/l1-deferred-tools/billing-deferred.mjs`（P9 计费六臂，Haiku；基座取自 probe.mjs 写下的 `out/haiku-p2-req1.json`，需先跑过 `probe.mjs haiku`）。配置自动从《模型API测试信息.md》读；官方模型经 Cloudflare AI Gateway 透传路径（F0 体检 43/43）。原始请求 / 响应写 `out/`（gitignore）。

## 厂商规矩（probe.mjs，Haiku 4.5 与 Opus 5 各 14/14）

| 探针 | 结论 |
| --- | --- |
| P1 只标 `defer_loading: true`、不带服务端 tool search 工具 | 接受；被延迟的工具对模型**完全不可见**（让它列自己的工具，只报 `tool_find`）。所以我们的菜单是必要的，不是重复 |
| P2 自定义 `tool_find` 的 `tool_result` 放 `tool_reference` | 模型随即调用被展开的工具（入参正确）；四种结果形态：**A** `text + tool_reference` 混放 → 400 "Tool definitions/code execution functions cannot be mixed with other content"；**B** 纯引用 + 块级 `cache_control` → 200；**C** 纯引用块后、同条 user 里跟一段 text → 200；**D** text 夹在两个 `tool_result` 之间 → 400 "tool_use ids were found without tool_result blocks immediately after"（**同条 user 里 tool_result 必须排在最前**） |
| P2.4 取回后的第 2、3 个请求 | `cache_read > 0`：Haiku 写 8497 → 读 8497 → 读 8634；Opus 写 4062 → 读 4062 → 读 4210。工具表整段不变，前缀缓存保住 |
| P3 对照臂（老路子：取回后把完整定义加进 tools 块） | 取回后第 2 个请求 **cache_read 归零**（Haiku 写 8685、Opus 写 4184），复现 D1；第一遍 Haiku 的对照臂读到了 10 分钟前另一遍写的缓存，探针加盐值后归零——跨遍对照必须加盐 |
| P4 `cache_control` 打在 `defer_loading` 工具上 | 400 "cannot have both defer_loading=true and cache_control set"。断点只能落在非延迟工具上 |
| P5 `tool_reference` 指向 tools[] 里没有的名字 | 400 "Tool reference 'x' not found in available tools" |
| P6 全部工具 `defer_loading` | 400 "At least one tool must have defer_loading=false" |
| P7 取回过的工具在后续轮次 | 直接调用、不再取回（API 在整段历史里展开引用），cache_read 照常 |
| P8a/b 历史含已移除工具的 tool_use / tool_result（工具表只剩别的工具 / 不带 tools） | **官方 Anthropic 接受**，模型正确作答——补上 P1 ⑧ 当时"官方直连未测"的那格 |
| P8c 历史里 `tool_reference` 指向已移除工具 | 400（与 P5 同源）：厂商对**整段历史**校验引用，上一次 run 取回、这次已解绑的工具会让整条请求失败 |
| DeepSeek Anthropic 兼容端口 | **忽略 `defer_loading`**：模型列出全部四件工具、直接调用；能力位对第三方 Anthropic 协议上游缺省关是对的 |
| P9 取回之前的计费（`billing-deferred.mjs`，2026-09-15 重做，6/6） | 被延迟的定义**不进缓存前缀、不计费**。同组各臂共用一次性 run 盐（写进 system 断点块**之内**），Haiku 4.5 六臂两组：带标臂（tool_find + 三件 deferred）写 8499 → **只留 tool_find 的删件臂整段命中 8499（write 0）**，即「带三件 deferred」与「完全没有这三件」的计费前缀逐字相同；把三件的 description 换成不同且更长文本的换料臂同样整段命中 8499 → 连定义内容都不进前缀；去掉 `defer_loading` 让三件实发的去标臂**不命中**、写 8675，多出的 **176** 就是三件定义（605 字符 JSON）的 token；第二组把顺序反过来（删件臂先跑、带标臂后跑），带标臂同样整段命中 → 排除单向巧合。如实记下但未探究：六臂 `input_tokens` 恒为 3。官方原文："Internally, the API excludes deferred tools from the system-prompt prefix"。CF 网关透传路径对 `count_tokens` 端点不转凭证（401 要 `x-api-key`），量化只能打真模型对照臂 |
| P9b 取回之后的计费（沿用 P2 的三个请求） | 展开后按普通 input 计费：P2 那轮 `tool_find` **只取回 get_weather 一件**，其后第 3 请求的缓存前缀由 8497 涨到 8634，**+137 是整段历史增量**（一件定义快照 + 两轮 tool_use / tool_result + 正文），不是三件定义的量，别拿它跟上一行的 176 对读 |

## 端到端（live.mjs，Haiku 4.5 与 Opus 5 各 9/9）

同一会话两次 run：第一次问 Paris 天气，第二次问 Tokyo。每个请求 tools 都是全表（3 件菜单工具 `defer_loading` + `today` + `tool_find`），断点落在 `tool_find`（最后一个非延迟工具）；模型先 `tool_find(get_weather)` 再 `get_weather(Paris)`；`tool_find` 的 tool_result 里是 `tool_reference` 块、说明文字作为 text 块排在这批结果之后；第二次 run 直接 `get_weather(Tokyo)`（已取回集合从时间线重建、厂商从历史展开引用）。

| 模型 | 第一次 run 三个请求（写 / 读） | 第二次 run 两个请求（读） |
| --- | --- | --- |
| Haiku 4.5 | 写 8623 → 读 8623 → 读 8780 | 读 8887、读 8912 |
| Opus 5 | 写 4243 → 读 4243 → 读 4410 | 读 4529、读 4558 |

有损落点只有一种：`core.tool_result: lossy/tool-reference`（说明文字改放这批结果之后），其余 exact。

## 落进代码的规矩（见 `packages/lowering-fetch/src/anthropic/to-request.ts` 头注释）

1. `ToolSpec.deferLoading` → `defer_loading: true`；全表都延迟时不延迟（P6）；断点打在最后一个非延迟工具上（P4）。
2. `tool_result` 里的 `tool_reference` 段：只有 **system 信任**的结果、且引用全部在本次工具表里（P5 / P8c）才发 `tool_reference` 块；文本段攒到这批 `tool_result` 之后再放（A / D）；否则整段展开成文本。
3. 能力位 `deferredTools` 只对 `provider: "anthropic"` 缺省开；第三方 Anthropic 协议上游由宿主实测后声明 `anthropic.deferredTools: true`。
