# b2-compact-live — compact 工具在真实模型上的核实（2026-09-08）

> 对应任务 B2。单测用 ScriptedLowering 能证明机制，证明不了三件事：模型会不会正确用这个工具、整理后的请求上游接不接受、整理后模型还能不能接着干。
> 运行：仓库根 `pnpm build`，然后 `node spikes/b2-compact-live/run.mjs [natural|pressured|asked|all]`；`REINS_B2_WINDOW=<n>` 改 pressured 情形声明的窗口。密钥自动从《模型API测试信息.md》读；原始记录落 `out/`（已 gitignore）。

## 方法

同一份三段式任务（查 1/2/3 号件报总重 → 查 4/5 号件比轻重 → 不查、复述总重并加上较重者），每段一次 run、同一会话，装 `perception()` + `compact()`，模型 claude-opus-5（经 aireiter 网关，thinking 开）。记录每次真实请求的 HTTP 状态、消息角色与块类型序列、用量，以及最后一段回答里是否出现 part 1 的总重 222。

| 情形 | 声明窗口 | 说明 |
| --- | --- | --- |
| natural | 200k | 只装规则提示，看模型会不会自发整理 |
| pressured | 8k / 4k / 3k / 2k | 用小窗口把感知档位与阈值兜底逼出来 |
| asked | 200k | 用户在第二段开头明确要求"先用 compact 折掉第一段并保留总重" |

## 结果（claude-opus-5，每种一次）

| 情形 | 请求数 | 非 200 | 整理 | 最后一问记得 222 | 备注 |
| --- | --- | --- | --- | --- | --- |
| natural | 5 | 0 | 0 | ✔ | 感知全程 <50%，模型不整理，符合规则 |
| pressured 8k / 4k | 5 | 0 | 0 | ✔ | 感知仍 <50%（见下"估算偏低"） |
| pressured 3k | 5 | 0 | 0 | ✔ | 感知到 50%–70%，模型仍未自发整理（短任务里合理） |
| pressured 2k | 5 | 0 | 1（threshold） | ✔ | 第 2 段末视图越过裁剪目标 → core 兜底折叠 seq 1–11；兜底摘要作首条 user 文本被上游接受 |
| asked（修复前） | 5 | 0 | 1（model） | ✔ | **模型把"先整理，然后做 part 2"这条指令一起折了**，摘要只写"接着做 part 2"，整理完反问"part 2 要做什么"，part 3 也答不出 part 2 |
| asked（修复后） | 6 | 0 | 1（model） | ✔ | 最近一条用户消息缺省幸存 → 整理完直接查 4/5 号件，part 3 答 222 + 185 = 407 |

模型给的 compact 入参（修复后那次）：

```
summary: "User is working through a 3-part catalog job. Part 1: Looked up items 1, 2, and 3. Item 1 weighs 37g, item 2 weighs 74g, item 3 weighs 111g. Calculated and reported the total weight. Part 1 is complete."
keep: ["Total weight of items 1, 2, and 3: 222 g"]
```

整理后首个请求的形状：`user(text 摘要) → user(text 幸存的用户消息) → assistant(thinking+tool_use compact) → user(tool_result 回执) → system(text 感知说明)`，HTTP 200；再下一段的请求以它为前缀继续累加。

用量（asked 修复后，每次请求 input / cacheRead / cacheWrite）：`48/182/1466 | 1256/1792/72 | 92/2114/1066 | 108/92/2276 | 840/1944/812 | 78/2420/1220`。第 4 次（整理后第一次）前缀整段重写，这是 §9.1 约束 5 说的"唯一允许打掉缓存的动作"，代价一次性；第 5 次的重写是新 user 轮到来时上游剥离旧 thinking 块所致，B1 基线里同样存在，与整理无关。

## 发现与结论

1. **schema 对模型友好**：三次整理调用入参全部合法，`keep` 用来放数字事实，`keepRecentTurns` 没用（缺省 0 合适）。
2. **整理后的请求形状真实 API 接受**：模型自决与阈值兜底两种摘要都是首条 user 文本，其后是完整的 assistant（thinking + tool_use）轮，无 400。
3. **最近一条用户消息必须由库保住**（已改缺省）：模型无法复述它还没开始处理的指令。这条进了 `pinsKept`，随 pin 一起重注入在摘要之后。
4. **感知的"上下文使用率"偏低**：pressured 3k 时真实 input 已 4.4k（含系统提示、工具表、thinking），估算只按视图正文粗算，报 50%–70%。感知应改用上一次请求的真实用量（`budget_usage.tokens` 的 input + cacheRead + cacheWrite）校准——记入 TASKS 待做（B8 预算模块一并处理）。
5. **"用户只发了一个句号"是网关所为**（Boss 提议用 DeepSeek 直连对照后确认，见 `spikes/aireiter-gateway-check/`）：aireiter 的 Claude 端点会改写请求，末尾的中途 system 被换成 Assistant "OK" + Human "."，说明内容丢失；本次实测里 perception 的说明模型在注入当轮都没看到。compact 的规则提示走顶层 system、用户指令走 user 正文，都可达，B2 结论不受影响。
6. 模型是否"该整理时就整理"是 eval 问题（M2 E3），短任务里它一次都没自发整理是对的；长任务的时机质量要等 fixture。
