# E3 三组对照跑数 —— 2026-09-09，DeepSeek v4 flash（Anthropic 端口直连）

fixture：`examples/eval/fixtures/adrate-patrol`（AdRate 巡检降本脱敏版：全流程 / 只读 / 接续 三个），窗口缩到 64k，每格重复 3 次。
四轮共 99 格，约 1900 万 token（其中缓存读约 1600 万）。各轮的完整报告（含每格明细）见同目录 `e3*-report.md`；每格的时间线在 `examples/eval/out/`（未入库）。

| 轮 | 臂 | 改了什么 | 备注 |
| --- | --- | --- | --- |
| 1 `e3` | none / threshold / brain | 首跑 | 发现 lowering-pi 顺序 bug、评分口径两处问题（见下）；数字已按新口径重判 |
| 2 `e3v2` | + brain-lean | 世界写后可见；brain-lean = 外溢阈值 16k、去掉 memory / handoff | brain-lean 完成度 100%、token 低于 threshold，召回差 5 点 |
| 3 `e3v3` | threshold / brain-lean | compact 规则加"保留核对过的原始字段值"；spill 缺省 16k | 召回仍差：丢的不是被整理掉的，是模型**以为**被折叠了 |
| 4 `e3v4` | threshold / brain-lean | 感知说明明说"折叠了什么 / 什么都没折" | 部分缓解，未消除 |
| 5 `e3b` | threshold / brain-lean | **换模型族**：claude-sonnet-5 经 Boss 的中转（直通官方 API，`spikes/relay-check`） | 同一条事实再丢，但这次是模型**真的**整理掉了 |

## 各臂配置

- **none**：不装脑子，连 core 的阈值裁剪也拆掉（窗口只是数字，模型真实窗口更大，所以从不失败）
- **threshold**：只有 core 缺省的 `budgetTruncate`（85% 起机械折叠最旧的轮 + 兜底摘要）—— PRD §7 门槛 2 的基线
- **brain**：dogfood 同款（perception、compact、pins、spill 6k、memory、handoff、budget、approval）
- **brain-lean**：perception、compact、pins、spill 16k、budget、approval

## 结果（臂均值，重判后）

| 轮 | 臂 | 完成度 | 召回 | 总 token | 计费等价 | 缓存命中 | 轮 | 整理 模型/阈值 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | none | 93% | 100% | 206,070 | 47,376 | 88% | 5.3 | 0 / 0 |
| 1 | threshold | 93% | 95% | 204,448 | 65,772 | 78% | 6.0 | 0 / 0.7 |
| 1 | brain | 91% | 95% | 255,142 | 73,318 | 82% | 8.4 | 0.3 / 0.4 |
| 2 | none | 93% | 100% | 186,894 | 41,857 | 88% | 4.9 | 0 / 0 |
| 2 | threshold | 89% | 100% | 173,812 | 41,524 | 87% | 4.2 | 0 / 0.3 |
| 2 | brain | 96% | 97% | 211,648 | 49,920 | 88% | 6.6 | 0.1 / 0.3 |
| 2 | brain-lean | 100% | 95% | 163,962 | 55,034 | 76% | 4.4 | 0.1 / 0.3 |
| 3 | threshold | 96% | 100% | 168,349 | 41,002 | 86% | 4.4 | 0 / 0.3 |
| 3 | brain-lean | 100% | 97% | 184,477 | 57,642 | 78% | 4.7 | 0 / 0.3 |
| 4 | threshold | 100% | 100% | 189,348 | 44,516 | 87% | 4.8 | 0 / 0.3 |
| 4 | brain-lean | 96% | 94% | 186,015 | 43,666 | 87% | 4.8 | 0 / 0.3 |
| 5 (sonnet-5) | threshold | 93% | 100% | 259,533 | 98,062 | 70% | 4.7 | 0 / 0.3 |
| 5 (sonnet-5) | brain-lean | 100% | 90% | 286,523 | 96,683 | 75% | 8.9 | 0.7 / 0.2 |

"总 token"把缓存读按 1× 计（模型每轮读了多少，门禁用它）；"计费等价"按缓存读 0.1× 折算（账单）。违规率四轮全部 0 → 0，没有一次越界（动别的广告主、停投非候选、只读任务里写）。

**门禁（候选对照 threshold，PRD §7 门槛 2 四条）**：四轮都未全过。brain-lean 在第 2、4 轮 token 不多于基线，完成度三轮不低于基线；**召回每轮都低 3–6 点**，违规率持平。

## 数字背后

1. **token 差在"多几轮"，不在"每轮更长"**。三臂每轮新输入相近；brain 多的是 fetch_blob 取回外溢全文（模型本来就要整读 10k token 的计划列表）、写 memory、整理各占一两轮，每多一轮就把整个上下文再读一遍。外溢阈值 6k → 16k 后只读任务 143k → 85k、全流程 255k → 135k。
2. **召回差的两条事实都在接续版**（种子几万 token 的历史 + 一次阈值折叠）。折叠只盖住了最早 7 条事件，被问的复核结果就在视野里，threshold 臂 12/12 答对；brain 两臂的模型却说"那部分已被折叠，我不编造，可以重查"。装了整理机制、说明里出现"折叠 / compactions"字眼，模型就先入为主认为旧细节没了，连看都不看。感知说明明说"什么都没折 / 只有摘要替掉的那段没了"后，第 4 轮接续版 3 格里仍有 2 格如此，另有 1 次把候选数 14 答成计划总数。这是 DeepSeek v4 flash 的行为特征，换模型族要重测。
3. **完成度失分是模型行为波动，各臂都有**：列完候选就停下等 Owner 批准而不执行（none、threshold 各 1–2 格）；汇总表把计划 ID 缩写成 "…0006"（threshold、brain 各 1 格，与整理无关）；汇总完再写一次 memory。整理本身没有造成任何一格失分。
4. **none 最省**：64k 只是给循环看的数字，模型真实窗口装得下，什么都不管就是最便宜。脑子的价值只在真正顶到窗口时显现 —— 本批 fixture 只有接续版接近这个状态。
5. **模型侧的意外**：短答案（"14"）有 9% 落在 thinking 块里正文为空（已改为退回 thinking 判分）；DeepSeek 端口 99 格里 3 次 "Connection error" 中途掐断（runLoop 无重试，记入待办）。

## 由此定下的缺省（DECISIONS 2026-09-09 E3）

- `spill` 缺省阈值 8k → **16k**；
- `compact`（模型自决整理）、`memory`、`handoff` **不默认开**：整理次数太少不足以证明收益，且相关说明诱发"以为被折叠"的拒答；memory 多花轮次、召回没涨；handoff 全程未触发；
- `perception`、`pins`、`budget`、`approval` 推荐默认；感知说明改为明说折叠范围；
- core 的阈值折叠（`budgetTruncate`）**继续作为兜底**：brain 臂里模型不整理时它出手了，没有它接续版会撞窗口。

## 第二个模型族（E3b，claude-sonnet-5 经中转）

- **同一条事实（复核时的 secondaryStatus）brain-lean 6/6 格丢**，但机理不同：Sonnet 每格都**真的**调了 compact，摘要与 pin 只留了"operationStatus=ENABLE"，没留 secondaryStatus；模型答得很诚实（"摘要里没留，我可以重查"）。threshold 的机械折叠只盖最早 7 条事件，复核结果都在，12/12 答对。
  → 两个模型族一起说明：**模型自决整理会按它自己的重要性判断丢掉细粒度字段**，这是机制本身的代价，不是某家模型的脾气。compact 规则里"保留核对过的原始字段值"那句没能改变 Sonnet 的取舍。
- **完成度反过来**：brain-lean 100%，threshold 93%（一格列完候选停下等 Owner 批准）。两个模型族的 threshold / none 臂都出现过这种停摆，brain 臂一次都没有 —— 装了 approval 模块，模型知道写操作会经审批流程，就直接提交；没装时系统提示里"写操作先经 Owner 审批"一句让它停下来在正文里问。**approval 默认开的理由不只是安全，还有"让模型敢动"。**
- token：总量 +10%，计费等价持平（96.7k vs 98.1k）。Sonnet 在 brain-lean 下轮数翻倍（8.9 vs 4.7）：写操作分小批提交、每批一次审批暂停；pin 超 500 字符被拒后重试（5/9 格撞上限）。
- 中转验证：`midConversationSystem: true` 在官方 API 上可用（感知说明每轮进 system 角色，0 次 400）；中转强制隐藏 thinking，pi-ai 正常处理。

**结论不变、更硬了**：compact 不默认开（两个模型族召回都低 5–10 点）；approval 默认开多了一条证据；spill 16k、memory / handoff 不默认的判断在 Sonnet 上同样成立（brain-lean 没装它们，完成度 100%）。

**下一步**：让整理机制在丢细节前多留一手（给探针 / 模型一条"不确定就回看上文"的说明、或让感知报出可见工具结果条数），—— 方向有三：① compact 工具的 `keep` 字段引导模型逐字保留"核对过的字段值"而非结论；② 整理时自动把被折叠范围内的工具结果 id 列进摘要尾部（"以下结果已折叠，可 fetch 取回"），让模型知道能拿回什么；③ pin 上限 500 字符放宽或分条。做完任一项后在两个模型族上复测；门槛 2 在此之前不算达成。

## 整理丢细节专项（E3c，2026-09-10，两个模型族）

**改了什么**（DECISIONS 2026-09-10 E3c）：整理时在摘要之后自动附**被折叠工具结果清单**（`seq N tool(入参) — 大小`，模型自决与阈值兜底都列），新增 **`recall({ seq })`** 工具按号逐字取回一条原件；pin 的 500 字符上限写进工具说明与 schema。臂仍是 threshold（core 缺省链）对 brain-lean（perception / compact+recall / pins / spill 16k / budget / approval），3 fixture × 3 重复。报告：`e3c-deepseek-v4-flash-report.md`、`e3c-claude-sonnet-5-report.md`。

| 模型族 | 臂 | 完成度 | 召回 | 总 token | 计费等价 | 违规 前→后 | 整理 模型/阈值 | 轮 | 门禁 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| deepseek-v4-flash | threshold | 100% | 97% | 198,801 | 51,729 | 0 → 0 | 0.0 / 0.3 | 5.2 | — |
| deepseek-v4-flash | brain-lean | 100% | **100%** | **184,700** | 57,148 | 0 → 0 | 0.0 / 0.3 | 4.4 | **四条全过 ✅** |
| claude-sonnet-5 | threshold | 100% | 100% | 271,266 | 100,799 | 0 → 0 | 0.0 / 0.3 | 5.0 | — |
| claude-sonnet-5 | brain-lean | 100% | **100%** | 276,196 | **78,886** | 0 → 0 | 0.7 / 0.0 | 9.0 | 三条过，总 token +1.8% ❌ |

**召回这一关过了，两个模型族都是 100%。** 上一轮丢的同一条事实（复核时的 secondaryStatus）：

- Sonnet 6/6 格整理了，摘要照旧只写"状态 ENABLE"；但探针问到时，**5 格直接 `recall` 了摘要清单里那一条 `ads_campaigns_get` 的原件**（seq 报得一个不差），答出 `BUDGET_EXCEED`，另 1 格摘要里本来就带着。E3b 里这 6 格的回答是"没留，我可以重查"。
- DeepSeek 这一轮**一次都没自己整理**（模型自决 0），也没用 recall；召回 100% 来自它不再"以为被折叠而拒答"。规则里那句"被问到摘要没留的细节，去取回而不是猜或说没了"很可能是原因，但 n 小，不下断言。threshold 臂反而丢了 2 格：接续版 fixture 本来就顶着窗口，**探针会话**再多一问就触发阈值折叠把整段历史（seq 1–163）折掉，模型如实说"seq 44 那条已被移除"——是窗口边缘的真实行为，不是评分错。

**token 这一关，Sonnet 差 1.8%。** 差在轮数（9.0 对 5.0）而不在整理：brain-lean 的 disable 格 Sonnet 把 14 个停投写操作**一个一轮**地提交，每个经 approval 暂停 / 续跑一次（14 次暂停），DeepSeek 则一轮并行提交一批；另有 5/6 格 pin 写到 502–558 字符撞上限白费一轮（上限已写进说明与 schema，模型仍数不准自己的字数 → 校验加两成容差，见 DECISIONS）。整理本身每格只多一轮。计费等价 brain-lean 反而**便宜 22%**（缓存命中 81% 对 71%）。

**清单的样子**（Sonnet 一格的 compaction 摘要尾部，节选）：

```
Folded tool results (bring one back verbatim with recall({ seq })):
- seq 10 ads_campaigns_list({"advId":"7000000000000000001","page":1,"pageSize":1000}) — 40k chars
- seq 11 ads_campaigns_report({"advId":"7000000000000000001","endDate":"2026-09-07","groupBy":"none","page":1,"pageSize":1000,"st…) — 27k chars
- seq 30 ads_campaigns_get({"advId":"7000000000000000001","campaignId":"1800000000000006"}) — 567 chars
… （共 16 条）
```

**第二轮（Claude，`e3c2-claude-sonnet-5-report.md`，threshold 基线沿用第一轮）**：pin 校验加两成容差后重跑 brain-lean，并加一臂 **compact-only**（core 缺省链 + perception + compact/recall，不装 pins / spill / budget / approval），把"整理 + 取回"的成本单独剥出来看：

| 臂 | 完成度 | 召回 | 总 token | 计费等价 | 整理 模型 | 轮 | 门禁 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| threshold | 100% | 100% | 271,266 | 100,799 | 0.0 | 5.0 | — |
| brain-lean | 100% | 100% | **210,905**（−22%） | 71,289 | 0.7 | 5.9 | **四条全过 ✅** |
| compact-only | 100% | 100% | **192,604**（−29%） | 70,164 | 0.7 | 5.3 | **四条全过 ✅** |

- 召回再次 100%：两臂 12 格里 10 格探针用了 `recall`（seq 全对），其余 2 格摘要里本来就带着。**两轮合计 Sonnet 12/12、DeepSeek 9/9 格答对上一轮必丢的那条事实。**
- token 两轮差别大（brain-lean 276k → 211k）：这一轮 Sonnet 把停投写操作按批提交（每格 2–3 次审批暂停，上一轮 14 次），pin 撞上限从 5/6 格降到 2/6（剩下两条 608 / 680 字符，超出两成容差，该拒）。模型行为的轮间波动比整理机制本身的成本大得多，所以看 compact-only：只装整理 + 取回，token 比 threshold **少 29%**、召回不降 —— 整理是省的，丢细节的账由 recall 兜住。

## 结论（E3c 收口，DECISIONS 2026-09-10）

- **PRD §7 门槛 2 达成**：两个模型族、候选 brain-lean 对照 threshold，四条硬规则全过（DeepSeek 一轮、Sonnet 第二轮；Sonnet 第一轮总 token 差 1.8% 未过，差在审批分批的轮次与 pin 重试，不在整理）。
- **compact（含被折叠清单 + recall）改为推荐默认**，取代 E3 "不默认开"的结论：E3 / E3b 不默认的理由是"整理丢细粒度字段、召回低 5–10 点"，E3c 把丢的东西做成有路可回后，两族召回 100%、token 少 22–29%。
- memory / handoff 仍不默认；spill 16k、perception / pins / budget / approval 推荐默认不变；core 阈值兜底继续，它的摘要现在也列被裁掉的工具结果。
- 仍要看着的：DeepSeek 在这批 fixture 里从不自己整理（模型自决 0），它的收益全来自 threshold 兜底 + 不再拒答，recall 在 DeepSeek 上还没被真正用过；Sonnet 的审批分批行为轮间波动大，token 的门禁裕度不该按单轮数字宣传。
