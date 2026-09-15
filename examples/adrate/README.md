# examples/adrate —— dogfood：用 AdRate 官方 CLI 把投放工具接成 agent

AdRate 是 Boss 的 TikTok 投放工具，官方 CLI `@adrate/cli` 本身就是给 Agent 用的：一切输出是 JSON 信封（`ok` 为唯一成功判据）、
稳定错误码与退出码、写操作带幂等键、`capabilities` / `schema` 自描述、自带两份 Agent Skill。所以接入不读它的服务层，直接包 CLI。

```bash
npm install -g @adrate/cli && adrate skills install
adrate auth login --test --device --json      # Boss 在浏览器授权；Token 进 Keychain，代码不接触
node examples/adrate/sync.ts                 # 从服务端拉能力与操作 schema → capabilities.json
node examples/adrate/tools.ts                # 打印生成的工具表核对
node examples/adrate/smoke.ts                # 不经模型直接调用工具，核对子进程与信封解析
REINS_PROVIDER=deepseek node examples/adrate/run.ts "<任务>" [--session <id>] [--approve-all]
```

- `tools.ts`：每个服务端操作一个 reins Tool。inputSchema 用服务端的（拿掉 `idempotencyKey`，幂等键 = `reins-<toolCallId>`，
  审批暂停 / 续跑前后不变，正好是"一个键一次不可变的写"）；execute 以参数数组起子进程，永不拼 shell 字符串；带幂等键的操作 risk=high、
  其余 low，审批模块按风险先问人；列表 / 报表类结果超 6k token 外溢。`CLI_OVERRIDES` 记服务端 schema 与 CLI 实际参数对不上的地方。
- `agent.ts`：全部脑子模块 + SQLite 存储（`data/`，已 gitignore）+ 系统提示 = 角色约定 + **技能菜单**（两份 Skill 只进 name / description，
  正文由模型 `skill_read` 按需翻，S1）。`adrate skills install` 落盘的 SKILL.md 只是"请运行 adrate skills read"的存根，所以载体不是
  `fsSkillSource` 读磁盘，而是启动时问 CLI `skills list --json` / `skills read --json` 一次，拼成 SKILL.md 喂 `inlineSkills`。
  降级层是 `@reinsjs/lowering-fetch`（0.2 起示例统一）：模型缺省经 aireiter 网关的 claude-opus-5（Anthropic Messages 线，网关丢中途 system 所以说明走 user 文本），
  `REINS_PROVIDER=deepseek` 走 DeepSeek 官方 Chat Completions 直连（reasoning_content 方言回放思考；多轮请求在 aireiter 上会被掐断，dogfood 用 DeepSeek）。thinking 不手设，用厂商缺省。
- `run.ts`：跑一条任务，审批逐条问 y/n（`--approve-all` 全批），结束写 JSONL 并用 `examples/minimal/replay.ts --agent` 生成回放页面。
- `probe.ts`：排障用，单独打一次模型请求。
- `local.ts`：测试广告主 id 等本地专用值的唯一读取处（环境变量或 gitignore 的密钥文件）。
- `scrub.ts`：把 `recordings/raw/` 的真实录像脱敏成公开版并重生成回放页面。

## 技能改造后的真跑：只读巡检（2026-09-13，S1，`recordings/s1-skills-{deepseek,claude}.jsonl` / `.html`）

任务："统计测试广告主下当前 ENABLE 的计划有多少条、各叫什么名字，不要修改任何东西"。系统提示不再含 Skill 全文，只有菜单。

| 跑法 | 第一轮工具调用 | skill_read 结果 | 结局 |
| --- | --- | --- | --- |
| DeepSeek，`maxReadChars` 16k | `skill_read(adrate-ads)` + `skill_read(adrate-shared)`，之后才调 AdRate | trust=system，`adrate-ads` 被截到 245/355 行，**没有**按提示续读 | 55 条事件，正确得出 0 条 ENABLE |
| Claude（网关 claude-opus-5），16k | 同上 | 同上，同样没续读 | 42 条事件，正确得出 0 条 ENABLE，用 fetch_blob 读完两页 109 条 |
| DeepSeek，缺省改为 40k | 同上 | `adrate-ads` 一次读到 355 行，未外溢 | 29 条事件，按 `adrate-ads` 技能"定不了授权就列候选问 Owner 一次，绝不猜"停下来问 Owner |

两族都在动手前先翻书，验收过；两族都不按截断提示续读"先读再动手"的说明书，所以 `skill_read` 的缺省上限从 16k 改成 40k（DECISIONS 2026-09-13、踩坑记录同日）。
录像 `s1-skills-*.jsonl` / `.html` 是脱敏版（见下文「录像与脱敏」）。

## 录像与脱敏

`recordings/*.jsonl` / `.html` 都是脱敏版，由 `scrub.ts` 从 `recordings/raw/`（已 gitignore，只在本地）生成：广告主 id、计划 id、请求 id、
Command / 凭证 id、人名 / 团队名 / 广告主名 / 授权账号名换成等长别名（口径 DECISIONS 2026-09-09 E2），同一个值在所有录像与
`examples/eval/fixtures/adrate-patrol` 里是同一个别名。测试广告主 id、冒烟用计划 id
等本地专用值只在根目录 `模型API测试信息.md`（gitignore）或环境变量里，由 `local.ts` 读取，源码与文档里出现的都是别名。
重新脱敏：`node examples/adrate/scrub.ts`（需要 raw/ 与 AdRate CLI，回放页面用 `examples/minimal/replay.ts` 重生成）。

## 第一条真实长任务：巡检降本（2026-09-08，`recordings/patrol-disable.jsonl` / `.html`）

任务：拉 30 天报表分页读完 → 找出 ENABLE 且花费为 0 的计划 → 逐个取最新状态复核 → 停投 → 跟踪 Command 到终态 → 汇总表。
测试广告主 7000000000000000001，102 条计划，14 条 ENABLE。同一会话两次 run（第一次工具层参数 bug 让 14 个停投全被 CLI 拒绝，
模型自己对账证明零副作用并汇报；修好后续聊完成）：

| 指标 | 值 |
| --- | --- |
| 事件 / 模型轮 / 工具调用 / 审批 | 239 / 16 / 57 / 29 |
| 用时 | 471 s（含模型自己 wait 40 s 等写限流窗口） |
| 输入 token | 1,013,905，其中缓存命中 862,336（85%） |
| 结束时上下文 | 约 100k / 200k，未触发折叠 |
| 结果 | 14 条全部 DISABLE，Command 全部 isFinal=true / succeeded；CLI 独立复核 102 条全为 DISABLE |

Boss 2026-09-09 决定：机制验证通过，不做两周观察期，直接进入 M2 与生产接入。

看到的模型行为：分页读完 102 条、用 fetch_blob 分段取回外溢全文、并行发只读调用、写调用一批只发 10 个并主动 wait 40 s 等限流窗口、
失败后按 Skill 契约对账（commands_pending / commands_get 按原键）再汇报、幂等键原样透传给服务端。

发现并反馈 AdRate 的问题：服务端 `schema ads.campaign.status.write` 里 cliFlags 说 `--status ENABLE|DISABLE`，CLI 0.1.0 实际只认
`--set enable|disable`。**2026-09-09 AdRate 已修复并发布测试与生产**，`node sync.ts` 重新同步后 flag 已是 `--set`。
GMV Max 经复核不是漂移：inputSchema 的大写枚举是 HTTP 线上格式，CLI 小写是命令行格式，CLI 内部做映射；所以 `CLI_OVERRIDES` 只保留
两处"HTTP 大写枚举 → CLI 小写"的层间映射。写路径冒烟：`node examples/adrate/smoke-write.ts`（对测试广告主的一条已停投计划再发一次 DISABLE）。
