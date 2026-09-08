# b1-perception-cache — 分档感知注入对 prompt cache 的实测（2026-09-08）

> 对应任务 B1 的验收项与技术方案 §17 待核实项："注入前后 cacheRead 占比不得下降"。
> 运行：`pnpm build` 后 `REINS_GATEWAY_BASE=https://aireiter.com/api ANTHROPIC_API_KEY=… node spikes/b1-perception-cache/measure.mjs anthropic <标签>`（OpenAI 同理），
> `node spikes/b1-perception-cache/summarize.mjs` 汇总 `out/` 下全部结果（`out/` 已 gitignore，本文摘录关键数字）。

## 方法

- 同一段对话：5 个用户问题，系统提示要求先调 `lookup_item` 再一句话作答 → 每个问题 2 次请求，共 10 次。系统提示凑到约 1.6k token（越过 Anthropic 最小可缓存长度），逐轮逐字相同。
- 三种配置各用新会话跑：
  - **baseline**：不装感知
  - **default**：`perception()` 默认档位（真实情形；这段短会话里只在首轮、以及"未折叠轮数"跨档时注入，共 3~4 条）
  - **stress**：`turnTiers` 设成每完成一个模型轮就变档 → 每次请求前都追加一条新说明（最坏情形，10 条）
- 指标：每次请求 `budget_usage.tokens` 的 `cacheRead / (input + cacheRead + cacheWrite)`（两家的 `input` 都已扣除缓存部分），取第 2 次起的平均；另记录实际发出的请求里每条消息的角色与 `cache_control` 落点（`tail:` 列，带 `*` 的有断点）。
- Anthropic 侧另比较感知说明殿后时 pi-ai 打在它上面的断点的三种处置（`PiAiLowering.midSystemCacheBreakpoint`）：`note`（留在改写后的 system 消息上）、`previous-user`（搬到前一条 user）、`drop`（丢弃，B1 之前的行为）。

## 结果

（见下文各表；原始 JSON 在 out/）

### Anthropic（claude-opus-5，经网关；第 2 次请求起的平均命中）

| 断点处置 | baseline | default（3~4 条说明） | stress（10 条说明） | 运行次数 |
| --- | --- | --- | --- | --- |
| 不注入（各次运行的基线） | 91.8% ~ 93.3% | — | — | 7 |
| **automatic（缺省）** | 93.3% | **92.9%** | **93.9%** | 1 |
| drop | 93.2% | 92.7% / 92.9% | 93.9% / 93.9% | 2 |
| previous-user | 93.1% | 90.5% / 90.7% / 90.4% | 87.3% / 87.1% / 87.0% | 3 |
| 留在 system 消息上 | 93.2% | 60.8% | 18.6% | 1 |

- 每条说明约 50 token。`automatic` / `drop` 下说明殿后的请求 cacheWrite 只有 44~50（正好是说明本身），其余历史全部命中；`previous-user` 下同一位置 cacheWrite 涨到 300~1700，说明搬走的断点让后续请求对不上前一次写入的前缀；断点留在 system 消息上时每次请求 cacheWrite 等于整段提示、cacheRead 接近 0。
- `drop` 与 `automatic` 数字一样，是因为**网关自己会在请求顶层补自动缓存**（官方规则是"最后一个断点之后不缓存"，丢弃断点后不可能出现 48 token 的写入）。直连官方 API 时 `drop` 会让说明殿后的请求整段历史不缓存，所以缺省是 `automatic`，等价于把网关帮我们做的事写进降级层。
- 基线自身在请求 #3 / #7 / #9（tool_result 之后）固定有 370~600 的重写，每次运行都一样，与注入无关（推测是 thinking 块在新 user 轮到来时被剥离引起）。
- 注入的三处成本：每条说明约 50 token；说明殿后的请求多写 ~48 token；stress 下 cacheRead 合计反而更高（53k vs 49k），因为说明本身也进了缓存。

### OpenAI（gpt-5.5，经网关，1 次）

| 配置 | 均命中 | 说明 |
| --- | --- | --- |
| baseline | 16.5% | 10 次请求里 8 次 cacheRead 为 0 |
| default（3 条） | 32.9% | |
| stress（10 条） | 38.2% | |

该网关上 OpenAI 的缓存本身很不稳定（同一会话相邻请求 input 从 6.4k 跳到 2.2k，多数请求 0 命中），三种配置差异在噪声内；能确认的只是**注入没有拉低命中**。OpenAI Responses 用 `prompt_cache_key` 做前缀缓存，没有断点问题，感知说明落 developer 消息（exact）。

## 结论

1. 分档感知注入满足验收：Anthropic 与 OpenAI 上命中占比都不下降（前提是断点按 `automatic` 处置）。
2. 降级层默认 `midSystemCacheBreakpoint: "automatic"`；`previous-user` 与 `drop` 保留为选项；"留在 system 消息上"有害，不提供。
3. 未做：直连官方 Anthropic API 的对照（没有官方 key）。若将来直连实测 `automatic` 不如预期，改缺省即可，一行配置。
