# examples/eval —— 首批 fixture 与对照跑数

`@reins/eval`（`packages/eval`）是 harness：fixture 形状、录像回放工具、指标、门禁。这里放**具体的 fixture** 与跑真模型的脚本。

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
