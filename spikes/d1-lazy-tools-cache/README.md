# d1-lazy-tools-cache — 逐轮变动请求工具集对 prompt cache 的实测（2026-09-14）

> 对应任务 D1 的核实项：`lazyTools()` 取回工具后请求的工具表会变，Anthropic 文档写明工具表变动使 tools / system / messages 三段缓存全部失效——代价到底多大、什么情形下值得。
> 运行：`pnpm build` 后 `node spikes/d1-lazy-tools-cache/measure.ts <relay|deepseek> [eager|lazy|all]`；密钥从仓库根《模型API测试信息.md》读；结果写 `out/`（已 gitignore，本文摘录关键数字）。

## 方法

- 工具表：`examples/eval/fixtures/tool-discovery` 的 200 件（28 件真实 AdRate 操作 + 172 件邻近领域干扰项），全部标 `lazy: true`。
- 同一个会话里连续做 6 个短任务（每个任务一次 run，任务见同目录 fixture 的 `TASKS`），两臂各跑一遍：
  - **eager**：不装模块，200 件全在每次请求里
  - **lazy**：装 `lazyTools()`，请求里只有已取回的 + `tool_find`；每个任务都要先取回它自己的工具——这是**最坏情形**（每个任务都换工具表），不是典型长任务
- 每次请求记 `budget_usage.tokens`（input / cacheRead / cacheWrite / output）与请求里的工具件数；命中占比 = cacheRead / (input + cacheRead + cacheWrite)。
- 上游：Boss 的 Claude 忠实中转（`claude-sonnet-5`，直通官方 API，缓存字段真实）；DeepSeek 官方 Anthropic 端口（`deepseek-v4-flash`，缓存全自动、按 128 token 块）。

## 结果

### Claude sonnet-5（官方 API 经忠实中转）

| 臂 | 请求数 | 每次请求的上下文 | input | cacheRead | cacheWrite | output | 第 2 请求起均命中 | 工具表变动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 14 | 40k ～ 44k | 28 | 549,436 | 44,239 | 2,011 | 99.3% | 0 |
| lazy | 22 | 10k ～ 23k | 44 | 239,290 | 134,077 | 3,537 | 65.4% | 7 |

- **取回之后的第一个请求缓存整段重写**：7 次工具表变动对应 7 个 `read=0, write=全部上下文` 的请求（10.1k → 23.1k 逐次增长），其余请求命中 95%～99%。文档说的"三段全失效"实测成立。
- 200 件工具约 **30k token**（eager 首请求写 40.3k，lazy 首请求写 10.1k，差 30k）；200 行菜单本身约 4k～5k。
- lazy 每个任务多一个请求（先 `tool_find` 再动手）：22 vs 14。
- 未加权总 token：lazy 377k vs eager 596k（**−37%**）。**按 Anthropic 价目加权**（cacheRead 0.1×、cacheWrite 1.25×、input 1×）：eager ≈ 110k、lazy ≈ 192k 输入等价 token——**这个情形下 lazy 贵 1.7 倍**，贵在 7 次整段重写（134k 写入）。

### DeepSeek v4 flash（Anthropic 兼容端口，自动缓存）

| 臂 | 请求数 | input | cacheRead | cacheWrite | output | 第 2 请求起均命中 | 工具表变动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 20 | 4,631 | 590,464 | 0 | 4,008 | 99.2% | 0 |
| lazy | 25 | 32,687 | 319,616 | 0 | 5,526 | 90.0% | 5 |

- DeepSeek 的自动缓存在工具表变动时**不是全丢**：变动那次请求仍读到约 6.5k（系统提示 + 菜单那段），其余作 input 重算（1.4k → 10.7k 逐次增长）；未命中部分记在 `input` 里（`cache_creation` 恒 0，与 `deepseek-anthropic-check` 一致）。
- 未加权总 token：lazy 358k vs eager 599k（**−40%**）。按 DeepSeek 价目加权（命中约 0.1×）：eager ≈ 64k、lazy ≈ 65k——**打平**。
- DeepSeek 一次取回会多拿几件相关工具（首次取了 4 件），Claude 每次只取正好要用的 1～2 件。

## 结论

1. **机制成立**：两族模型都先 `tool_find` 再动手，取回的工具下一轮即可调用，靶工具全部找对（调用清单在 `out/*.json` 的 `calls`）。
2. **代价有边界**：每次取回换来一次整段重写（Claude）或大半重算（DeepSeek）。按 Claude 价目粗算，eager 每请求约 0.1 × 42k ≈ 4.2k 等价 token，lazy 约 0.1 × 15k ≈ 1.5k，每请求省约 2.7k；一次取回的重写约 1.25 × 15k ≈ 19k——**一次取回要靠约 7 个后续请求才回本**。本 spike 是 22 个请求 7 次取回的最坏情形，所以亏；巡检降本那种几十个请求、开头取一次的长任务则明显赢。
3. **上下文小一半是另一层收益**：eager 每次请求 40k+ 里 30k 是 200 件工具的 schema，模型每轮都在 200 件里挑；lazy 是 10k～23k。200 件工具对模型准确率的影响由 eval（`examples/eval/fixtures/tool-discovery`）单独看。
4. **推荐用法**：lazyTools 适合"工具表大、单个任务用的少、任务长"的场景；一个会话里频繁换任务、每个任务都要新工具时不划算。规则文案已经要求"一次把要用的取全"。**后续优化路径**：Anthropic 官方的 tool search / `defer_loading` 把取回的工具定义注入 messages 而不改 tools 块，正是为了不打掉缓存——那是降级层按 provider 做的优化（另立任务），本模块接口不用变。
