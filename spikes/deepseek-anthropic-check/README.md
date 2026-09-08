# deepseek-anthropic-check — DeepSeek 的 Anthropic 兼容端口作为第二家上游（2026-09-08）

> Boss 提供 DeepSeek 官方密钥（记在仓库根《模型API测试信息.md》，已 gitignore）。目的：给 B1 的 prompt cache 结论找第二家 Anthropic 协议上游做对照，并核实 reins 依赖的几件事在非 Anthropic 官方服务器上的反应。
> 运行：`node spikes/deepseek-anthropic-check/probe.mjs`（密钥自动从信息文件读取；原始响应落 `out/`，已 gitignore）。

## 探针（模型 deepseek-v4-flash，端点 `https://api.deepseek.com/anthropic/v1/messages`）

| # | 发什么 | 结果 |
| --- | --- | --- |
| 1 | pi-ai 风格块级 `cache_control`（system + 最后一条 user） | 200；usage 带 `cache_creation_input_tokens: 0`、`cache_read_input_tokens: 0` |
| 2 | 同一前缀再发一次 | 200；`cache_read_input_tokens: 640`。**DeepSeek 把自己的自动缓存翻译成了 Anthropic 的字段**，`cache_creation` 永远为 0（隐式缓存不计写入） |
| 3 | 请求顶层 `cache_control`（reins `automatic` 模式补的字段） | 200，接受；同样读到 640 |
| 4 | messages 里的中途 `role:"system"` 消息 | 200，接受并正常作答 |
| 5 | `thinking` 参数 + 工具调用 | 200；返回 thinking 块与 tool_use。不给 `thinking` 参数它也会输出 thinking 块 |

## 用 reins 跑 B1 缓存实测（`spikes/b1-perception-cache/measure.mjs` 指到 DeepSeek）

| 说明落点 | baseline | default（3 条） | stress（10 条） |
| --- | --- | --- | --- |
| user 文本（未声明能力时的缺省） | 94.3% | 93.9% | 93.1% |
| 中途 system + 顶层自动缓存（声明 `midConversationSystem: true`） | 94.5% | 94.2% | 94.1% |

- 命中占比不因注入下降；DeepSeek 按 128 token 块计缓存，1 个点内的差异是粒度噪声。
- 请求体记录（`+top`）证实经 pi-ai 的 `onPayload` 改写后顶层 `cache_control` 确实发出去了，DeepSeek 接受。

## 对 reins 的影响

1. **不能替代官方 Anthropic 对照**：DeepSeek 的缓存是全自动的，不认断点位置，三种断点处置在它那里没有区别；它只能证明"我们发的请求它都接受、注入不拉低命中"。
2. `ModelDefinition` 新增 `midConversationSystem?: boolean`：第三方 Anthropic 协议上游由宿主声明是否接受中途 system，缺省仍按不支持处理（说明以 `<system_note>` 标签包住走 user，有损矩阵 lossy）。
3. DeepSeek 可作为 M2 eval / dogfood 的便宜模型来源（v4-flash），以及发布前"第二家 Anthropic 协议上游"的兼容性回归。
