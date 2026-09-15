# examples/eval —— 首批 fixture 与对照跑数

`@reinsjs/eval`（`packages/eval`）是 harness：fixture 形状、录像回放工具、指标、门禁。这里放**具体的 fixture** 与跑真模型的脚本。

```bash
pnpm build                                                     # 示例跑的是 dist
REINS_PROVIDER=deepseek node examples/eval/run.ts --arms none,threshold,brain,brain-lean,compact-only --repeats 3   # 每格落盘 out/<run>/cells/
REINS_PROVIDER=deepseek node examples/eval/run.ts --suite tool-discovery --repeats 3                                # D1：200 件工具找靶，臂 eager / lazy
node examples/eval/report.ts examples/eval/out/<run> --candidate brain-lean --rescore                 # 汇总、门禁、按 fixture 分表
```

`REINS_PROVIDER`：`deepseek`（官方 Chat Completions 直连，缺省）| `cloudflare`（Cloudflare AI Gateway 透传官方 Anthropic，缺省 claude-sonnet-5）| `relay`（Boss 的 Claude 中转）| `aireiter`（丢中途 system，只作参考）。降级层是 `@reinsjs/lowering-fetch`（0.2 起；0.1 的四轮结果是 pi 版跑的）。

`run.ts` 一格一落盘（指标 JSON + 全链时间线 JSONL + 探针事件），可按臂拆进程并行、可用 `--repeat-start N` 只补跑失败的格；
`report.ts --rescore` 用落盘的时间线按当前评分器重算完成度、按探针记录重判召回，改口径不必重跑模型。
**结果**：`results/2026-09-09-deepseek-v4-flash/`（四轮 99 格的结论与各轮报告）；`results/2026-09-14-tool-discovery/`（D1 工具懒发现两族报告）；`results/2026-09-15-lowering-fetch/`（0.2 发前切 fetch 版后两族复跑：Sonnet 5 全过、DeepSeek token 项未过且实证是模型行为变化而非代码，含三组对照）。

## fixtures/tool-discovery：200 件工具里找靶（D1 工具懒发现的门禁）

`lazyTools()` 把 `lazy: true` 的宿主工具只以菜单进系统提示，模型用 `tool_find` 取回要用的几件。这组 fixture 只问一件事：**菜单 + 取回之下，模型还能不能找对、用对工具，代价多少。**

```bash
REINS_PROVIDER=deepseek node examples/eval/run.ts --suite tool-discovery --repeats 3 --out examples/eval/out/d1-deepseek
REINS_PROVIDER=relay    node examples/eval/run.ts --suite tool-discovery --repeats 3 --out examples/eval/out/d1-relay
node examples/eval/report.ts examples/eval/out/d1-deepseek --suite tool-discovery --reference eager --candidate lazy
pnpm vitest run examples/eval/fixtures/tool-discovery     # 世界与评分器自检
```

| 文件 | 内容 |
| --- | --- |
| `catalog.ts` | 200 件工具：28 件真实 AdRate 操作（说明与 schema 用 `examples/adrate/tools.ts` 同一份函数生成，execute 换成固定数据的假账户）+ 172 件邻近领域干扰项（CRM / 账单 / HR / 库存……程序生成，含 `metaads_*` 另一家投放平台的近似陷阱）。全部 `lazy: true`，按名排序、确定性生成 |
| `fixture.ts` | 六个短任务（列计划 / 停投一条 / 拉报表找零花费 / 找规则再停用 / 找 GMV Max 计划改 ROAS / 我是谁），每个只需 1～2 件靶工具；完成度 = 0.6 × 靶工具调对（含入参）+ 0.4 × 汇报提到事实，每次走错门扣 0.25；约束"只用 AdRate 工具" |
| `fixture.test.ts` | 目录 200 件唯一有序、假账户口径、评分器边界、六个 fixture 装配 |

**两臂只差一个 Socket**：`eager` 不装模块（200 件全在每次请求里，`lazy` 字段被忽略）；`lazy` 装 `lazyTools()`。同一批工具、同一套任务。总数 200 是 AdRate 侧规划的规模，本地快照与服务器此刻都只有 29 个操作。

### 结果（`results/2026-09-14-tool-discovery/`，6 题 × 2 臂 × 3 遍）

| 模型 | 臂 | 完成度 | 总 token（缓存读 1×） | 计费等价（缓存读 0.1×） | 缓存命中 | 轮 | 走错门 | 门禁 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| DeepSeek v4 flash | eager | 100% | 73,210 | 8,366 | 99.1% | 2.7 | 0 | — |
| DeepSeek v4 flash | lazy | 100% | 27,697 | 4,657 | 94.3% | 3.6 | 0 | ✅ 通过 |
| Claude sonnet-5 | eager | 100% | 97,358 | 10,523 | 99.5% | 2.4 | 0 | — |
| Claude sonnet-5 | lazy | 100% | 40,182 | 9,164 | 86.6% | 3.4 | 0 | ✅ 通过 |

以上是第二轮（r2）。第一轮 fixture 有缺陷（假账户 authId 给了字符串、schema 要整数），两族模型都按"不能编 id"的契约在同一题停下来问人，Claude 侧候选臂因此差一格未过——两轮报告都在 `results/2026-09-14-tool-discovery/`，案卷见 `docs/踩坑记录.md` 2026-09-14。

- 两族、两臂都零走错门：172 件干扰项与 `metaads_*` 陷阱没人碰；靶工具全部找对，完成度只差在个别格的入参或汇报。
- lazy 每题多约一轮（先 `tool_find` 再动手），上下文小一半以上（200 件 schema 约 30k token）。
- 缓存的代价单看 `spikes/d1-lazy-tools-cache/`：单题一个会话时取回一次、之后全命中，所以这里计费等价也是降的；一个会话里连续换任务、每题都要新工具时按 Claude 价目会反过来贵——那是最坏情形，README 与模块注释都写明。

## fixtures/adrate-patrol：AdRate"巡检降本"（B11 真实长任务的脱敏版）

来源是 `examples/adrate/recordings/patrol-disable.jsonl`（2026-09-08，DeepSeek 直连，239 事件 / 57 工具 / 29 审批）。

```bash
node examples/eval/fixtures/adrate-patrol/build.ts   # 重新从源录像生成 recording.jsonl 与 tools.json（需先 pnpm build）
pnpm vitest run examples/eval                        # fixture 自检（脚本化模型，不联网）
```

| 文件 | 内容 |
| --- | --- |
| `build.ts` | 源录像 → 去外溢（fetch_blob 分片拼回全文、删 fetch_blob 对）→ 脱敏 → 自查 → 写出 |
| `recording.jsonl` | 脱敏后的完整时间线（229 事件），也是 fixture 的"世界" |
| `tools.json` | 录像里用到的 10 个工具在 dogfood 里的真实声明（说明、schema、risk、resultPolicy） |
| `fixture.ts` | 世界解析、回放工具 + 补位、预埋事实 / 约束、完成判定、三个 fixture 的装配 |

**脱敏**：广告主 id、计划 id、请求 id、Command / 凭证 id、人名 / 团队名 / 广告主名 / 授权账号名全部换成等长别名，
同一个值在入参、结果、正文、思考里一起变，回放一致；测试广告主下的计划名（造出来的测试数据）、时间戳、用量数字保留。
build 结束自查：原值一个不剩、每条规则都命中、无邮箱 / URL 残留。

**三个 fixture 共用一个世界**（`adratePatrolFixtures({ contextWindow, maxTurns, maxResumes })`）：

| id | 任务 | 完成判定 | 约束 |
| --- | --- | --- | --- |
| `adrate-patrol-disable` | 102 条计划分页读完 → 14 条候选逐条复核 → 停投 → Command 终态 → 汇总表 | 0.6 × 停投到位 + 0.4 × 表里列全 − 0.5 × 误停 | 只动目标广告主；只对候选发 DISABLE |
| `adrate-patrol-audit` | 同上但只汇报不写 | 表里列全候选、不列非候选；动写工具 = 0 | 只动目标广告主；只读 |
| `adrate-patrol-resume` | 种子 = 真实第一次 run 全部历史（含 14 个被参数 bug 拒绝的写与模型的对账汇报），任务 = "工具修好了，继续" | 同 disable | 同 disable |

**预埋事实**（跑完后在分叉会话里问，确定性判分）：候选条数、某条计划名称、报表起止日期、写限每分钟次数、广告主 id、计划总数、某条计划复核时的 secondaryStatus。

**回放工具**：`recordedTools` 逐字回放录像；没录过的入参走从数据里长出来的补位 —— 列表 / 报表按任意页大小重新分页、任意计划的 get 从列表条目合成、
任意已存在计划的 status 写合成 succeeded 的 Command、commands get / resume 按键找回；别的广告主、不存在的计划、别的日期窗口照样报错。
`wait_seconds` 不真等。工具层 bug 那一轮（`--status` 被 CLI 拒）的 16 个失败调用（15 个停投 + 1 个对账查询）不进回放，但留在 recording.jsonl 与 resume 的种子里。

缺省 `contextWindow` 64k：真实 run 结束时约 100k，缩到 64k 让整理机制在中段出手；三个臂同窗口才公平。
