# 模块盘点：`packages/eval`（`@reinsjs/eval`）

> 对照 `docs/技术方案.md` §13 与 `docs/TASKS.md` E1～E3c，**以代码为准**。
> 一句话：把"同一个 fixture、同一个模型、只换循环配置"这件事跑起来，并把结果变成可机器判定的数字与一张 Markdown 表。
> 依赖只有 `@reinsjs/core`（`@reinsjs/brain` 仅 devDependency），零 `node:*`；文件读写与 CLI 都在调用方 `examples/eval`。

## 1 架构概览

四层：**形状**（types）→ **素材**（jsonl / recording / recorded-tools）→ **执行**（arms / runner）→ **判读**（metrics / gate / report）。
执行层不写第二套循环，用的就是 core 的 `runLoop`；"臂"只是 `LoopConfig` 的一个片段，所以三臂之间的差异只可能来自脑子模块与投影链。

```
fixture（seed 日志 + 任务 + tools + facts/constraints + completion）
  ×  arms（EvalArm = sockets / projection / 追加 systemPrompt）
  ×  repeats
                    │
                    ▼
             runEval ── 每格 ──► runCell
                                  ├─ 1 新 Stores（缺省 memoryStore）+ 新 sessionId，seed 换 sessionId 后原样 append
                                  ├─ 2 runLoop（core，唯一一套循环）
                                  │      ├ paused(approval) → fixture.approve 代答 → decisions 续跑
                                  │      ├ paused(budget)   → maxResumes 次以内续跑
                                  │      ├ handoff          → 跟到新 sessionId 再跑
                                  │      └ error / host / 客户端工具 → 停，如实记 status
                                  ├─ 3 探针：log.fork(主会话末尾 seq) → tools:[] → 问一条 fact → expect/judge 打分
                                  └─ 4 timeline（全链）/ fresh（去掉种子）
                    │
                    ▼
        measureTimeline(fresh, constraints)  ──► tokens / 轮 / 工具 / 重复 / 整理 / 违规两窗
        + completed + recall + wallMs + probeTokens ──► EvalMetrics ──► EvalOutcome
                    │
                    ▼
             summarize(outcomes) ──► Record<臂名, ArmSummary>（按臂取均值）
                    │
                    ├──► checkGate(report, { reference, candidate }) ──► GateResult（四条硬规则）
                    └──► renderReport(report, { gate, detail })      ──► Markdown 表
```

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `packages/eval/package.json` | 包声明：只依赖 `@reinsjs/core`，`@reinsjs/brain` 是 devDependency（模型自决臂由调用方组） |
| `packages/eval/tsup.config.ts` | 单入口 ESM 打包；打 `.d.ts` 时清空 `paths`，避免把 core 的类型内联进本包声明 |
| `packages/eval/src/index.ts` | 桶文件，`export *` 全部九个模块，并在头注释里列出每个模块干什么 |
| `packages/eval/src/types.ts` | 全部数据形状：`EvalTask` / `PlantedFact` / `PlantedConstraint` / `EvalFixture` / `EvalArm` / `Judge` / `TokenTotals` / `EvalMetrics` / `FactResult` / `EvalOutcome(Draft)` / `ArmSummary` / `EvalReport` |
| `packages/eval/src/jsonl.ts` | 事件 ↔ JSONL 文本；读走注册表 `read` 升级，fail-closed，错误带行号（`JsonlParseError`） |
| `packages/eval/src/recorded-tools.ts` | `recordedTools(recording, opts)`：把录像里配对的 tool_call → tool_result 变成确定性回放工具；`canonicalArgs` 是键排序稳定 JSON |
| `packages/eval/src/recording.ts` | 录像 → fixture 素材的纯函数：`unspillRecording`（拼回外溢全文）、`scrubEvents`（JSON 文本层逐字脱敏）、`aliasTable` / `matchStrings` / `jsonValuesAt` / `parseFetchChunk` / `assembleChunks` |
| `packages/eval/src/metrics.ts` | 时间线纯函数指标：`sumTokens` / `billableTokens` / `cacheHitRateOf` / `splitModelTurns` / `countCompactions` / `countRepeatedToolCalls` / `measureViolations` / `measureTimeline` / `finalTextOf` / `mean` |
| `packages/eval/src/arms.ts` | 内置 `noneArm()` / `thresholdArm()`，以及 `withCapabilities` / `withContextWindow` 这层只改能力声明的 Lowering 包装 |
| `packages/eval/src/runner.ts` | `runEval` 对照运行器与 `summarize`；含审批代答、预算续跑、handoff 跟随、fork 探针、`probeAnswerOf` / `gradeExpect` |
| `packages/eval/src/gate.ts` | `checkGate`：PRD §7 门槛 2 / P8 的四条硬规则，只给结论与数字 |
| `packages/eval/src/report.ts` | `renderReport`：臂均值表 + 可选门禁表 + 可选每格明细，输出 Markdown |
| `packages/eval/src/*.test.ts` | 五个测试文件（jsonl / metrics / recorded-tools / recording / runner），describe 覆盖：JSONL 读写、指标纯函数、录像回放、外溢拼回、脱敏与待脱敏值收集、`runEval` 对照运行器 |

## 3 核心流程

### 3.1 素材：从真实录像做出一个"世界"

1. `unspillRecording(recording)` 先把 spill 外溢过的 tool_result 补全：扫出全部 `fetch_blob` 结果，用 `parseFetchChunk` 从 `[blob "id": characters a–b of N …]` 头解析分片，`assembleChunks` 按字符偏移拼接——重叠取先到者，声明区间与正文长度不符、有缺口、没拼到 `total` 一律返回 `undefined`，该 blob 进 `incomplete` 且原结果原样保留。拼齐的把 `spilled` 字段删掉、内容换成全文；`fetch_blob` 的调用/结果对缺省整对删掉（`dropFetchBlob`）。
2. `scrubEvents(events, replacements)` 脱敏：对每条事件 `JSON.stringify` 后做字符串替换，**长的 `from` 先换**，替换双方都按 `jsonForm`（`JSON.stringify(s).slice(1,-1)`）转成 JSON 字面量里的写法，再 `JSON.parse` 回事件。返回每条规则的命中数 `hits`（不含原文，可进报告）。待换的值由 `matchStrings`（正则找）与 `jsonValuesAt`（按键名找，遇到 `text` 字段是 JSON 就解析后继续遍历）收集，`aliasTable` 去重保序编号。
3. `recordedTools(recording, opts)` 建回放工具：先按 `toolCallId` 建 tool_result 索引，再顺序扫 tool_call 配对，按工具名分组存 `{ key: canonicalArgs(args), result }`。统计四项：`pairs`（配对成功数）、`byName`、`spilled`（配对上的结果里 `payload.spilled` 非空的条数——回放时只有预览，全文不在，fixture 作者要么录制时关外溢要么用 `fallback` 补）、`unanswered`（有 call 无 result，录制时被拒或暂停未续，不进回放）。

`recordedTools` 的 `execute` 匹配顺序（严格在前，宽松要显式开）：

1. **同名 + 键排序后入参逐字相同**（`canonicalArgs` 递归排序对象键，所以 `{a,b}` 与 `{b,a}` 同一入参）→ 命中；
2. 同一入参在录像里出现多次，按 `cursor` 计数 `matches[n % matches.length]` **按序轮着给**，用完回到第一次；
3. 没匹配上 → `opts.fallback(name, args, ctx)`，返回非 undefined 就用（fixture 作者补的合成答案）；
4. 还没有 → `opts.sequence === true` 时给该工具**下一条没被 `used` 标记过的**录像结果（模型换写法但意图相近）；缺省关闭；
5. 都没有 → `noRecording()` 返回 `isError: true` 的英文说明（"这是回放环境，只有之前观察过的调用有数据"），而不是随便给一条。

工具声明来自 `opts.specs[name]`（description / inputSchema / risk / needsApproval / resultPolicy），缺省是一句通用说明 + `{ type: "object", additionalProperties: true }`；`opts.only` 可限定只为哪些工具建回放。

### 3.2 执行：`runEval` 的每一格

`runEval` 三重循环 fixture × arm × repeat（`repeatStart` 支持只补跑第 N 次），每格调 `runCell`：

1. **开跑前 `assertFixtures`**：fixture 非空、臂非空、臂名不重、每条 `fact` 要么有 `expect` 要么配了 `judge`、`task.seed` 的 `seq` 必须从 1 起连续——把配置错误一次挑出来，不烧完 token 才发现某条事实没法打分。
2. **建格环境 `CellEnv`**：`stores()` 缺省 `memoryStore()`（每格一套新的）；`fixture.contextWindow` 存在就用 `withContextWindow` 包一层 lowering；`registry` 缺省 `createCoreRegistry()`；系统提示是 `joinPrompts(fixture.task.systemPrompt, arm.systemPrompt)`（`\n\n` 连接，臂的排在后面）。
3. **会话与种子**：`newId()` 生成 sessionId；有 `task.seed` 就 `map(e => ({ ...e, sessionId }))` 后 append——**只换 sessionId，事件 id 保留**，`parentId` / `pinsKept` 这些会话内引用才不断。
4. **跑任务**：`drain(runLoop(loopConfig(...{ input })))` 第一次跑，之后进 `while (steps++ < maxSteps)`（缺省 200）：
   - `status === "handoff"` → sessionId 换成 `result.toSessionId`、推进 `sessionIds`，用空 extra 再 `runLoop`；
   - `paused` + `reason === "approval"` → 逐条 interruption，`kind === "approval"` 的交 `fixture.approve(i, draft())`（缺省全批），装成 `ApprovalDecisionInput{ by: "eval" }`；出现非 approval 的中断（客户端工具等）就 `blocked = true` 并**跳出**——eval 里没人能回填；
   - `paused` + `reason === "budget"` 且 `resumes < (fixture.maxResumes ?? 0)` → `resumes++` 后带 `resume: result.state` 续跑；**缺省 `maxResumes` 是 0，即暂停就算没跑完**；
   - 其余（error、host、budget 且续跑用尽）→ break，`status` 如实进指标。
   墙钟 `wallMs` 从这一段开始前量到结束，含续跑之间的开销，不含探针。
5. **收时间线**：按 `sessionIds` 顺序逐个 `readTimeline` 得到 `timelines`，`flat()` 成 `timeline`；`fresh` 是去掉第一个会话前 `seedLen` 条之后的全链——种子是上一次真实运行的账。`finalText = finalTextOf(fresh)`，随后 `completed = clamp01(await fixture.completion(draft))`（布尔转 0/1，非有限数按 0，夹到 0~1）。
6. **探针问答**：取最后一个会话的末条 `seq`，对每条 `fact`：`newId` 一个 probeSessionId → `stores.log.fork(fromSessionId, atSeq, probeSessionId)` → 在分叉会话里 `runLoop`，`tools: []`（**去掉宿主工具，防止模型重查一遍作弊；脑子工具如 `fetch_blob` / `recall` 由臂的 socket 带进来，仍在**），系统提示追加 `PROBE_NOTE`（"只凭本对话已知作答，除了取回被外溢/折叠的工具结果外不要调工具，简答"），`maxTurns` 缺省 4。`probeAnswerOf` 先取 `finalTextOf`，正文为空则退回**最后一段非空 `core.model_thinking`**，都没有记 `answerFrom: "none"`。`gradeExpect`：字符串按不分大小写 `includes`、正则 `test`、函数取返回值 clamp 到 0~1；没有 `expect` 走 `opts.judge`。探针 token 单独累加进 `probeTokens`，不进任务 tokens。
7. **算指标**：`measureTimeline(fresh, constraints)` + `status` + `completed` + `recall`（各事实分数均值，无事实时字段缺省）+ `wallMs` + `probeTokens`。

### 3.3 判读：指标口径、门禁、报告

`measureTimeline(timeline, constraints)` 返回 `tokens / cacheHitRate? / turns / toolCalls / toolErrors / repeatedToolCalls / compactions / violations`，各项口径：

- **tokens**：把时间线里全部 `core.budget_usage` 的 `input / output / cacheRead / cacheWrite` 相加，`total = 四者之和`（缓存读按 1× 计，反映"模型每轮读了多少"）。另有 `billableTokens(t) = input + output + 0.1 × cacheRead + cacheWrite`，只进报告不进门禁。
- **cacheHitRate** = `cacheRead / (input + cacheRead + cacheWrite)`；分母为 0（一次请求都没记用量）时返回 `undefined`，字段整个不出现。
- **turns**：`splitModelTurns` 的长度。**一轮 = 一段连续的模型输出（core `isModelOutput`：thinking / text / tool_call）+ 到下一段模型输出之前的一切**（工具结果、用量、整理、暂停）。开头在第一段模型输出之前的 preamble 事件归入第一轮的 `aftermath`；没有任何模型输出就是 0 轮。
- **compactions**：按 `payload.decidedBy` 分 `model` 与 `threshold`（非 model 一律记 threshold）。`maxConsecutive` 是**最长一串"连续含整理的模型轮"里 compaction 的总数**——逐轮数 `aftermath` 里的 compaction 条数，非零就累加、为零就清零，取过程最大值。
- **violations**：`measureViolations` 用 `timeline.findIndex(type === "core.compaction")` 定第一次整理的**数组下标**（不是 `seq`，跨会话拼接后 seq 会重新从 1 起），下标严格大于它的模型动作进 `after` 窗，其余进 `before` 窗。模型动作 = `core.tool_call` 或 `core.model_text`（`isModelAction`）。每窗记 `actions / violations / rate`，`rate = violations / actions`，无动作记 0。没整理过则全部落 `before`、`after` 全零。
- **repeatedToolCalls**：键为 `` `${name} ${canonicalArgs(args)}` ``，**第二次起每次记 1**（死循环计数），与回放工具用的是同一个 `canonicalArgs`。
- **toolErrors**：`isError` 的 tool_result 条数。

`summarize(outcomes)` 按臂分组取均值：`finishedRate` 是 `status === "done"` 的比例，`tokens` 四项各取均值后 `cacheHitRate` 用**均值后的 token** 重算，`recall` 只对有值的格取均值，`violations` 取两窗 `rate` 的均值，其余直接均值。

`checkGate(report, { reference, candidate, tokenRatioMax = 1 })` 四条（缺任一臂直接抛）：

1. `tokens`：候选 `tokens.total ≤ 基线 × ratio`；
2. `completion`：候选完成度 ≥ 基线；
3. `recall`：候选召回 ≥ 基线；**双方都没有 recall（没预埋事实）时视为通过并带 `note`**，只有一方有则缺的一方按 0 参与比较；
4. `governance`：**候选自己**整理后违规率 ≤ 整理前（这一条不跟基线比，`reference` 字段填的是候选的 before）。

`renderReport(report, { gate?, detail? })` 输出 Markdown：抬头一行（模型、fixture 数 × 臂数、总格数、耗时）；臂均值表 13 列（跑完/完成度/总 token/计费等价/缓存命中/召回/违规前→后/整理 模型·阈值·连续/轮/工具/重复调用/墙钟），`undefined` 一律显示 `—`；`gate` 存在时附门禁表（token 列按整数显示、其余按百分比）；`detail` 存在时每格一行明细。

## 4 核心设计决策

- **eval 独立成包、只依赖 core，臂就是 `LoopConfig` 片段** — `EvalArm = { name, sockets?, projection?, systemPrompt? }`，模型自决臂由调用方用 `@reinsjs/brain` 组，包本身不依赖 brain（`@reinsjs/brain` 只在 devDependencies）。理由：eval 要能评第三方脑子模块与用户自己改的循环配置，绑死 brain 就评不了别人；三臂共用同一个 `runLoop`，差异才只来自臂。边界：本包不做 CLI、不碰文件系统，`examples/eval` 负责这两件事。（DECISIONS 2026-09-09 E1）
- **回放匹配宁缺毋滥** — 同名 + 键排序后入参逐字相同才算命中，没命中缺省给 `isError` 说明，`fallback` / `sequence` 必须显式开。理由：三臂必须面对同一个世界，且不碰真服务（写操作有副作用、要审批）；宁可让模型知道"这里没数据"，也不给一条错答案让它接着推理。边界：匹配策略可加，`spilled` 的结果回放时只剩预览（`stats.spilled` 记数报警）。（DECISIONS 2026-09-09 E1）
- **fixture 的"世界"必须完整，所以先去外溢再脱敏** — `unspillRecording` 从模型自己 `fetch_blob` 取回的分片把全文拼回来，拼不齐的原样保留并进 `incomplete`，不硬凑。理由：不还原的话无脑子臂拿到的只是一段预览加一个取不回的 blob id。边界：只处理符合 `FETCH_HEADER` 格式的分片，blob 本体不从 BlobStore 读。（代码注释 + 技术方案 §13 E2）
- **脱敏在 JSON 文本层逐字替换** — 长的 `from` 先换，替换双方按 JSON 字面量写法转义，于是入参、工具结果、模型正文、思考里的同一个值一起变，回放时模型看到的 id 和它要传给工具的 id 仍然一致；命中数返回但不带原文。边界：**事件的 `id` / `sessionId` / `seq` 同样会被替换**，调用方不想动就别把那些值放进表里。（代码注释 + DECISIONS 2026-09-09 E2）
- **带种子的格，指标只算 `fresh`** — token / 轮 / 动作 / 违规都只看去掉 `task.seed` 之后的事件，完成判定与探针仍看全链 `timeline`。理由：种子是上一次真实运行的账，不剔除则三臂共背一段固定开销、比例被摊平。（DECISIONS 2026-09-09 E2）
- **召回用 fork 出来的探针会话问** — 从主会话末尾 `fork`，去掉宿主工具、保留脑子工具，追加"只凭已知作答"的提示，用量另记。理由：fork 让每条探针互不污染、也不污染主会话（主日志仍是那次任务的真实记录）；去掉宿主工具是防止模型重查一遍作弊，保留 `fetch_blob` / `recall` 是因为把外溢或折叠的东西取回来正是脑子的本事、该算它的分。（DECISIONS 2026-09-09 E1）
- **探针正文为空时退回 thinking** — `probeAnswerOf` 取不到正文就用最后一段非空 thinking，并用 `answerFrom` 标明来源。理由：E3 实测 DeepSeek v4 flash 的短答案（"14"）有 9% 整个落在 thinking 块里、正文为空、输出 1 个 token，那是模型唯一的输出，判成"不记得"是误伤。（代码注释 + DECISIONS 2026-09-09 E3 附）
- **"轮"按模型输出类型切，不按 actor** — `isModelOutput`（thinking / text / tool_call）。理由：模型自决 compaction、模型 pin、memory_op 的 actor 也是 model，并行工具时它们落在 tool_result 之后会被误切成一轮——core 的 `replayTurns` 原本就有这个缺陷，E1 一并改掉并导出 `isModelOutput`。（DECISIONS 2026-09-09 E1）
- **治理衰减按数组位置分窗，不按 seq** — 跨会话拼接的时间线里 seq 会重新从 1 起。边界：只以**第一条** compaction 为界，之后再整理多少次都在同一个 `after` 窗内。（代码注释 + DECISIONS 2026-09-09 E1）
- **缩窗口靠包一层 Lowering 改能力声明** — `withContextWindow` 走 `withCapabilities`，同时改 `capabilities()` 与 `toRequest()` 里回填的 capabilities，请求本身不动。理由：窗口对循环、投影、感知来说本来就是从 `ctx.capabilities` 读的一个数字，包一层最省；把窗口缩到几千 token 让中等任务也触发整理，比真烧到 200k 便宜得多，且三臂同窗口才公平。边界：**模型真实窗口没变**，所以 `none` 臂在这种设定下几乎不会真的撑爆。（DECISIONS 2026-09-09 E1）
- **门禁把 PRD §7 门槛 2 写成代码** — `checkGate` 四条机械规则，只给结论与数字，CI 红绿与默认开关由调用方脚本决定。理由：P8"无 eval 不默认开"需要一个机械可查的判据，写成代码而不是文档，跑数时就不会临场放水。（DECISIONS 2026-09-09 E1）
- **报告同时给总 token 与计费等价** — 门禁用 `tokens.total`（缓存读 1×，PRD 原文是"token 不多于"，不改口径），报告另给 `billableTokens`（缓存读 0.1×，Anthropic 与 DeepSeek 的缓存命中价都是标准输入价的一成）。理由：脑子多出的 token 九成是缓存读，账单差别小得多，两个数都给才不误导。（代码注释 + DECISIONS 2026-09-09 E3 附）

## examples/eval 盘点

harness 在 `packages/eval`，**具体的 fixture 与跑真模型的脚本在这里**。

| 路径 | 内容 |
| --- | --- |
| `examples/eval/README.md` | 跑法、fixture 说明、脱敏口径、三个 fixture 的任务/评分/约束一览 |
| `examples/eval/run.ts` | 对照跑数脚本：`--arms / --fixtures / --repeats / --repeat-start / --context-window / --out`，`REINS_PROVIDER` 选 deepseek（fetch 版官方 Chat Completions 直连）/ cloudflare（Cloudflare AI Gateway 透传官方 Anthropic）/ relay（Claude 中转）/ aireiter；降级层 0.2 起是 `@reinsjs/lowering-fetch`；组出 `none / threshold / brain / brain-lean / compact-only` 五臂，调 `runEval`，**一格跑完立刻落盘**三个文件到 `out/<run>/cells/`：`<key>.json`（指标、事实问答、状态，剥掉时间线）、`<key>.jsonl`（全链时间线）、`<key>.probes.jsonl`（探针事件）；最后写 `run-<臂名>.json` |
| `examples/eval/report.ts` | 汇总脚本：读 `cells/*.json`，`summarize` 求臂均值、`checkGate` 跑四条、`renderReport` 出表，写 `report.md` / `report.json`；`--reference` / `--candidate` / `--token-ratio` 可配；`--rescore` 用落盘时间线按当前评分器重算完成度、按探针记录重判召回，**改口径不必重跑模型** |
| `examples/eval/fixtures/adrate-patrol/` | 唯一一套 fixture（AdRate"巡检降本"真实长任务脱敏版）：`build.ts`（源录像 → 去外溢 → 脱敏 → 自查 → 写出）、`recording.jsonl`（229 事件的脱敏时间线，就是 fixture 的"世界"）、`tools.json`（dogfood 同一张 10 个工具的声明）、`fixture.ts`（世界解析 + 回放工具与补位 + 预埋事实/约束 + 完成判定 + 三个 fixture 装配）、`fixture.test.ts`（脚本化模型自检，不联网）。三个 fixture：`adrate-patrol-disable`（全流程）、`adrate-patrol-audit`（只读）、`adrate-patrol-resume`（种子 = 真实第一次 run 的全部历史 + "工具修好了，继续"），共用一个世界，缺省 `contextWindow` 64k |
| `examples/eval/out/` | 跑数原始产物，**已 gitignore、未入库**。一个子目录一次运行（`smoke`、`smoke2`、`smoke-relay`、`e3-*`、`e3v2~v4-*`、`e3b-*`、`e3c-*`、`e3c2-*`），每个下面是 `cells/`（每格三个文件）+ `run-*.json` + `report.md` |
| `examples/eval/results/` | 入库的结论目录，目前只有 `2026-09-09-deepseek-v4-flash/`（README + 8 份报告） |

`results/2026-09-15-lowering-fetch/`（0.2 发前，示例与 eval 切到 fetch 版后两族复跑）：`README.md` 是总账——Sonnet 5 巡检 + 两族工具发现全过，DeepSeek 巡检 token 项 6 遍未过；
四份 `control-patrol-disable-*` 是同日只跑 disable 的对照（fetch 版 Anthropic 端口 / 0.2 pi 版 / 英文化前代码 / v0.1.1 原代码），结论：轮数 6.3 → 10 是模型自己变的、与降级层无关，英文化对每轮上下文的影响未排除（n=6 分不出）。

`results/2026-09-09-deepseek-v4-flash/` 各文件（结论摘自该目录 README）：

| 文件 | 一句话结论 |
| --- | --- |
| `README.md` | 四轮 99 格 + E3b/E3c 的总账：门槛 2 从未达成到达成，以及由此定下的各模块默认开关 |
| `e3-report.md` | 首跑 none / threshold / brain：发现 lowering-pi 顺序 bug 与两处评分口径问题，数字已按新口径重判 |
| `e3v2-report.md` | 加 `brain-lean` 臂、世界改为写后可见：brain-lean 完成度 100%、token 低于 threshold，但召回差 5 点 |
| `e3v3-report.md` | compact 规则加"保留核对过的原始字段值"、spill 缺省 16k：召回仍差，丢的不是被整理掉的，是模型**以为**被折叠了 |
| `e3v4-report.md` | 感知说明明说"折叠了什么 / 什么都没折"：部分缓解，未消除 |
| `e3b-claude-sonnet-5-report.md` | 换模型族（claude-sonnet-5 经中转）：同一条事实再丢，但这次是模型真的整理掉了；brain 臂完成度反超，approval 默认开多一条理由 |
| `e3c-deepseek-v4-flash-report.md` | E3c（折叠清单 + `recall`）DeepSeek 复测：召回 100%、总 token 低于基线，**门禁四条全过** |
| `e3c-claude-sonnet-5-report.md` | E3c Sonnet 第一轮：召回 100%（5/6 格靠 `recall` 取回原件），但总 token +1.8% 未过，差在审批分批的 14 次暂停与 pin 重试 |
| `e3c2-claude-sonnet-5-report.md` | E3c Sonnet 第二轮（pin 校验加两成容差 + 新增 `compact-only` 臂）：brain-lean token −22%、compact-only −29%，召回 100%，**两臂门禁四条全过** |
