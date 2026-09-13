# @reins/brain 模块盘点

> 依据 2026-09-13 的 `packages/brain/src/` 源码写成（S1 skills 落地后更新）。与 `docs/技术方案.md` §9 有出入处以代码为准，出入已在文末"核心设计决策"与文中注明。

## 架构概览

`@reins/brain` 是 reins 预装的"驾驭经验"。`package.json` 里只有一个依赖：`@reins/core`（`workspace:*`）；主入口零 Node 内置依赖，只用 Web 标准 API，唯一的 `node:*` 在子路径 `@reins/brain/node`（文件系统技能载体 `fsSkillSource`，tsup `removeNodeProtocol: false`，`pnpm check:dist` 核对）。它不含循环、不含存储实现、不含降级层，只提供九个可单独装拆的模块。

每个模块都是一个工厂函数 `xxx(options): Socket`，返回 core 定义的 `Socket`（`packages/core/src/loop/types.ts`）。Socket 只有五个钩子（`beforeModel` / `afterModel` / `beforeTool` / `afterTool` / `onTurnEnd`）加两项静态贡献（`tools` / `systemPrompt`，run 起步时算一次、整个 run 不变，用于满足 prompt cache 约束、续跑补齐 pending 时在场、并计入 `configHash`）。模块只依赖这份契约，不依赖 `runLoop` 的实现。

宪法一在这里的落点：模块只做四件事——让模型看见（perception）、给它能力（compact / pins / spill / handoff / memory 的工具）、给它边界（approval / budget / spill 的上限）、给它记录（各模块 emit 的事件）。任何"框架替模型决定"的动作都只是兜底（阈值折叠、连续整理上限、预算触顶暂停）。

| 模块 | 用到的钩子 | 静态贡献 | 缺省是否推荐开启 | 缺少存储时 |
| --- | --- | --- | --- | --- |
| perception | beforeModel | 无 | 推荐默认 | 不依赖存储 |
| compact | afterModel、afterTool、onTurnEnd | 工具 `compact`、`recall`（`recall: false` 可关）；规则提示 `COMPACT_RULES` | 推荐默认（E3c 改判，取代 E3 / E3b 的"不默认"） | 不依赖存储（recall 读 EventLog） |
| pins | beforeModel、afterTool | 工具 `pin`（`tool: false` 可关）；规则提示 `PIN_RULES`（仅带工具时贡献） | 推荐默认 | 不依赖存储 |
| spill | afterTool | 工具 `fetch_blob`（`tool: false` 可关）；规则提示 `SPILL_RULES` | 推荐默认（阈值 16k） | 无 `BlobStore` → **外溢自动关闭**并告警一次，大结果原样通过；声明 `overflow: "truncate"` 的工具照常截断。注意工具与规则仍注册（常量形态），调用时返回 isError |
| handoff | afterTool、onTurnEnd | 工具 `handoff`；规则提示 `HANDOFF_RULES` | 不默认 | 不依赖存储 |
| memory | 无钩子 | 工具 `memory` 与规则提示 `MEMORY_RULES`，均为按 `SocketSetup` 算一次的**函数形态** | 不默认 | 无 `MemoryStore` → **工具与规则都不注册**（§5"缺则不注册"）并告警一次 |
| approval | beforeTool | 规则提示 `APPROVAL_RULES`（无工具） | 推荐默认 | 不依赖存储 |
| budget | afterModel、onTurnEnd | 无 | 推荐默认 | 不依赖存储 |
| skills | 无钩子 | 工具 `skill_read`（`resultTrust: "system"`）与规则提示 `SKILL_RULES` + 菜单，均为按 `SocketSetup` 算一次的**异步函数形态**（菜单只读载体一遍） | opt-in：给了 `source` 即开 | 无 `source`、或 `root/` 下无一份合规 SKILL.md → **工具与菜单都不注册**并告警一次；不合规的单份技能跳过、各告警一次 |

缺省开关的依据：`docs/DECISIONS.md` 2026-09-09 **E3** 行（spill 8k → 16k；compact / memory / handoff 不默认；perception / pins / budget / approval 推荐默认）与 2026-09-10 **E3c 结论**行（compact 含清单与 recall 后改为**推荐默认**，memory / handoff 仍不默认，其余不变），以及 `docs/TASKS.md` 的 E3 / E3c 行。

注册顺序有两处敏感（`onTurnEnd` 第一个给意见的 Socket 说了算）：handoff 应排在 compact 等可能返回 `pause` 的模块**之前**（否则回执说了交接却被别人暂停，回执撒谎）；budget 应排在 handoff **之后**（模型已决定交接就让它交接）。approval 建议排在 `sockets` **末尾**（至少在会 `rewrite` 入参的钩子之后），这样判定的是真正要执行的入参。

九个模块共用的几条写法约定：

- **规则提示同一形状**：带规则提示的模块（compact / pins / spill / handoff / memory / approval）都接受 `rules?: string | false`——缺省用内置文案，传字符串替换，传 `false` 则本模块完全不碰系统提示（宿主自己把导出的常量放进去）。
- **给模型看的文字一律英文**：进的是模型上下文而不是给人看的日志，英文 token 更省、各家模型都熟；给人看的告警与构造期错误则是中文。
- **纯函数层单独成文件**：`tiers.ts` / `reading.ts` / `plan.ts` / `preview.ts` / `paths.ts` / `commands.ts` 与 `checkBudget` / `evaluatePolicy` 都不碰事件与存储，可单测、可回放、可被宿主复用。
- **构造期就拒绝非法配置**：档位边界非严格升序、`maxConsecutive < 1`、`maxTextLength < 1`、`overshootTolerance ∉ [0,1)`、`maxResultTokens < 1`、pin spec 重名、预算上限非正数，都在 `xxx()` 调用时抛 `RangeError`，不留到跑起来才炸。
- **占位回执**：compact / pins / handoff 的工具 `execute` 只返回一句"工具在场但 Socket 没装"的占位串，正常路径下必被 `afterTool` 换掉——模型看到它就说明装配漏了一半。

## 文件清单

| 文件路径 | 职责 |
| --- | --- |
| `packages/brain/package.json` | 包声明：`@reins/brain`，唯一依赖 `@reins/core`，ESM、`sideEffects: false`；exports `.` 与 `./node` 两个入口 |
| `packages/brain/tsup.config.ts` | 两个入口（index / node）；`removeNodeProtocol: false` 保住 `node:` 前缀 |
| `packages/brain/src/index.ts` | 门面：九个模块目录的 `export *`，文件头一句话概括每个模块 |
| `packages/brain/src/node.ts` | `@reins/brain/node` 入口：`fsSkillSource(dir, { root? })`，`<dir>/<name>/SKILL.md` → `${root}/<name>/SKILL.md`；隐藏项与符号链接不列，read 二次防穿越并 realpath 防链接逃逸 |
| `packages/brain/src/node.test.ts` | fsSkillSource 在真实临时目录上的用例（列 / 读 / 越界 / 隐藏 / 符号链接 / 接到 skills()） |
| `packages/brain/src/shared/paths.ts` | memory 与 skills 共用的根目录限定路径规范化 `resolveRootedPath(raw, root, field)`：拒绝 `.` / `..` / 反斜杠 / 百分号编码 / 控制字符 / 段首尾空白，折叠重复斜杠 |
| `packages/brain/src/shared/view.ts` | 共用的带行号文件视图 `formatFileView`（范围、按字符上限逐行截断并提示续读）与 `byteLength` / `humanSize` / `splitLines` / `numbered` |
| `packages/brain/src/perception/index.ts` | perception 子模块聚合导出 |
| `packages/brain/src/perception/perception.ts` | `perception(opts): Socket`：beforeModel 算读数、渲染、与可见的上一条说明按文字判重，不同才 emit `system_note(kind=perception)` |
| `packages/brain/src/perception/reading.ts` | 纯函数算读数：模型轮数、会话累计 token、整理次数、外溢条数、预算最紧一维余量、加法校准的上下文开销 |
| `packages/brain/src/perception/render.ts` | 读数 → 给模型看的英文说明文字；含"折叠到底拿走了什么"那句（E3 实测补的） |
| `packages/brain/src/perception/tiers.ts` | 档位离散化：`rangeTier` / `countTier` / `percent` / `compactNumber`，以及边界严格升序的构造期校验 |
| `packages/brain/src/perception/perception.test.ts` | perception 的全部用例（档位、判重、校准、与 runLoop 集成） |
| `packages/brain/src/compact/index.ts` | compact 子模块聚合导出 |
| `packages/brain/src/compact/compact.ts` | `compact(opts): Socket`：注册 `compact` / `recall` 工具与规则提示，afterTool 落 compaction 并换回执，onTurnEnd 查连续整理上限 |
| `packages/brain/src/compact/plan.ts` | 纯函数 `planCompaction`：算切点、幸存者、被吸收的旧摘要、被折叠工具结果清单；另有按轮分段与连续整理计数 |
| `packages/brain/src/compact/recall.ts` | `recall({ seq })` 工具：从本会话日志按 seq 逐字取回一条被折叠的工具结果 |
| `packages/brain/src/compact/rules.ts` | compact / recall 的工具名、工具说明与规则提示 `COMPACT_RULES`（英文常量） |
| `packages/brain/src/compact/compact.test.ts` | compact 的全部用例（自决整理、阈值兜底与连续上限、recall、纯函数层） |
| `packages/brain/src/pins/index.ts` | pins 子模块聚合导出 |
| `packages/brain/src/pins/pins.ts` | `pins(opts): Socket`：宿主 `PinSpec` 在 beforeModel 判重追加，模型 `pin` 工具在 afterTool 落事件；含入参解析与查找辅助 |
| `packages/brain/src/pins/rules.ts` | `pin` 工具名、随上限生成的工具说明 `pinToolDescription(max)`、规则提示 `PIN_RULES` |
| `packages/brain/src/pins/pins.test.ts` | pins 的全部用例（宿主 pin、模型 pin、与 compact 的幸存端到端、构造与纯函数） |
| `packages/brain/src/spill/index.ts` | spill 子模块聚合导出 |
| `packages/brain/src/spill/spill.ts` | `spill(opts): Socket`：afterTool 超限外溢进 BlobStore 并替换成预览，`fetch_blob` 工具按字符偏移分段取回、按会话引用授权 |
| `packages/brain/src/spill/preview.ts` | 纯函数：度量文本（字符 / 行 / token）、按 token 上限裁一段、首尾预览、千分位格式化 |
| `packages/brain/src/spill/rules.ts` | `fetch_blob` 工具名、工具说明与规则提示 `SPILL_RULES` |
| `packages/brain/src/spill/spill.test.ts` | spill 的全部用例（外溢、fetch_blob 取回、resultPolicy、无 BlobStore、纯函数） |
| `packages/brain/src/handoff/index.ts` | handoff 子模块聚合导出 |
| `packages/brain/src/handoff/handoff.ts` | `handoff(opts): Socket`：afterTool 记意图并回执，onTurnEnd 返回 `{ handoff }`；排版开场说明、带走可见 pin、被打断时从日志重建意图 |
| `packages/brain/src/handoff/rules.ts` | `handoff` 工具名、工具说明与规则提示 `HANDOFF_RULES` |
| `packages/brain/src/handoff/handoff.test.ts` | handoff 的全部用例（交接流程、带 pin、同轮多工具、审批同轮的 R2 重建） |
| `packages/brain/src/memory/index.ts` | memory 子模块聚合导出 |
| `packages/brain/src/memory/memory.ts` | `memory(opts): Socket`：只有静态贡献；工具 execute 里执行命令、成功则 emit `memory_op`；缺 MemoryStore 则不注册并告警一次 |
| `packages/brain/src/memory/commands.ts` | 六个 command 的入参 schema、解析与在 `MemoryFs` 上的执行（view / create / str_replace / insert / delete / rename），以及命名空间绑定 `bindMemoryFs` |
| `packages/brain/src/memory/paths.ts` | `MEMORY_ROOT` 与 `resolveMemoryPath`：把 `/memories` 传给 shared 的 `resolveRootedPath`，薄包装 |
| `packages/brain/src/memory/rules.ts` | `memory` 工具名、工具说明与规则提示 `MEMORY_RULES` |
| `packages/brain/src/memory/memory.test.ts` | memory 的全部用例（路径限定、入参解析、六个命令、命名空间、与 runLoop 集成） |
| `packages/brain/src/approval/index.ts` | approval 子模块聚合导出 |
| `packages/brain/src/approval/approval.ts` | `approval(opts): Socket`：`evaluatePolicy` 管线（未知 → deny → ask → allow → unmatched）与 beforeTool 的三种落点 |
| `packages/brain/src/approval/rules.ts` | 规则提示 `APPROVAL_RULES`：要等人批不是出错、被拒别换写法再试 |
| `packages/brain/src/approval/approval.test.ts` | approval 的全部用例（简写与摘要、管线、与 runLoop 集成、R1 的 validate 前移） |
| `packages/brain/src/budget/index.ts` | budget 子模块聚合导出 |
| `packages/brain/src/budget/budget.ts` | `budget({ limits, note? }): Socket`：五维上限定义、`checkBudget` 纯函数、onTurnEnd 触顶即 `pause(budget)` |
| `packages/brain/src/budget/budget.test.ts` | budget 的全部用例（纯函数、五维各自触顶、收尾轮不拦、续跑再批一份） |
| `packages/brain/src/skills/index.ts` | skills 子模块聚合导出 |
| `packages/brain/src/skills/skills.ts` | `skills(opts): Socket`：`loadSkillMenu` 读菜单（按 setup 缓存、按 name 排序）、`parseSkillReadInput` 校验入参、`skill_read` 工具（`risk: low`、`resultTrust: system`、`resultPolicy.maxTokens = maxReadChars`）；缺 source / 空菜单不注册 |
| `packages/brain/src/skills/frontmatter.ts` | 纯函数 `parseSkillMarkdown`：只认 `name` / `description`，逐行 `key: value`，缩进的嵌套字段跳过；`SKILL_NAME_RE`、description ≤ 1024 |
| `packages/brain/src/skills/inline.ts` | `inlineSkills({ name: SKILL.md 文本 | { 文件: 内容 } }, { root? })`：字符串预填的只读 SkillSource（Workers、或正文来自别处如 AdRate CLI） |
| `packages/brain/src/skills/rules.ts` | `skill_read` 工具名 / 说明 / 入参 schema、规则提示 `SKILL_RULES`、菜单排版 `renderSkillMenu` |
| `packages/brain/src/skills/skills.test.ts` | skills 的全部用例（头部解析、菜单加载、入参与穿越、静态贡献与告警、读 / 附件 / 截断续读、与 runLoop 及 spill 集成） |

## 核心流程

### perception

1. `beforeModel`：`readPerception(ctx, thresholds, limits)` 从 `ctx.events`（本轮视图）算未折叠模型轮数与可见外溢结果数，从 `ctx.timeline`（完整日志）算整理次数与会话累计 token（`sumSessionTokens` 累加 `budget_usage`，含缓存读写）。
2. 上下文使用率先经 `contextOverheadOf(timeline)` 加法校准（真实上下文 − 当时估算），再落到档位；配了 `limits` 时按最紧一维算余量档位。
3. `render(reading)` 渲染成英文说明；与 `lastVisiblePerceptionNote(ctx.events)` 的文字逐字比较，相同则什么都不做。
4. 不同才 `ctx.emit` 一条 `system_note(kind=perception, meta.reading=读数)`，追加在时间线末尾、本轮即可见。永远返回 `undefined`，不碰 `systemPrompt` / `tools`。
5. 说明文字里同时给出阈值兜底的触发点（`targetTokens / contextLimit`）与"折叠到底拿走了什么"一句；精确的校准开销只进 `meta.reading`，不进模型看到的文字。

### compact

1. run 起步：静态贡献带上 `compact` 工具（`execute` 只返回占位串）、`recall` 工具与 `COMPACT_RULES`。
2. `afterModel`：记下本轮模型有没有发工具调用（`WeakMap<TurnContext>`）。
3. `afterTool` 见到 `compact` 调用：`parseCompactArgs` 拿规范入参 → `planCompaction(ctx.events, args, { protectCallId, timeline, manifest })` 算切点与幸存者 → `ctx.emit` 一条 `core.compaction(decidedBy=model, actor=model, parentId=tool_call)` → 把占位结果换成 `receipt()` 回执。日志顺序是 tool_call → compaction → tool_result。
4. `recall({ seq })` 的 `execute` 走 `recallResult`：在本会话日志里 `locate` 到那条 `tool_result`，原样返回内容并加说明头；原件已外溢则指向 blob 让模型用 `fetch_blob`。
5. `onTurnEnd`：本轮模型还要继续时，把本轮模型自决的整理数 + 本轮开始时投影新造的阈值兜底整理数 + `trailingCompactionRun(ctx.timeline)` 相加，达到 `maxConsecutive`（缺省 3）即返回 `{ pause: { reason: "budget", note } }`。

### pins

1. `beforeModel`：逐条算宿主 spec 的文字（静态文本或 `extract(ctx)`；返回空表示"这轮没新说法"，上一条继续生效）。
2. 与 `lastHostPin(ctx.events, spec.name)` 的文字逐字比对；相同跳过，不同（首轮 / 内容变了 / 被折叠掉了）就 `ctx.emit` 一条 `system_note(kind=pin, actor=system, meta.pin={source:"host",spec})`，`supersedes` 指向该 spec 在完整时间线里的上一条。永不返回补丁。
3. `afterTool` 见到 `pin` 调用：`parsePinArgs` 校验；带 `replaces` 时用 `findModelPin` 找模型自己钉的那条，指向宿主 pin 或找不到都以 isError 回话；同文重复钉直接回"已钉过"。
4. 通过则 `ctx.emit` 一条 `system_note(kind=pin, actor=model, parentId=tool_call)`（替换时带 `supersedes`），并把占位结果换成回执。幸存与折叠后的重排本身在 core 投影链，本模块不重复实现。

### spill

1. `afterTool`：跳过 `fetch_blob` 自己的结果；用 `ctx.tools` 找到工具，取 `resultPolicy.maxTokens ?? maxResultTokens`（缺省 16000）与 `resultPolicy.overflow ?? "spill"`。
2. 把结果里全部文本片段拼成正文（图片等非文本片段不度量），`measureText` 估算不超限就原样通过。
3. 超限且 `overflow: "truncate"`：不存 blob，只留 `previewOf` 的首尾预览，说明里明说中段不可恢复。
4. 超限且没有 `BlobStore`：外溢关闭，结果原样通过，经 `warn` 告警一次（每个实例只一次）。
5. 超限且有 `BlobStore`：`ctx.blobs.put(text, { mime, sessionId })` 存全文，结果换成 `[说明 + 首尾预览]` 并在草稿上写 `payload.spilled = { blobId, summary }`；日志里仍只有一条 `tool_result`。
6. `fetch_blob({ id, start?, end? })` 的 `execute` 走 `readBlobSlice`：先 `referencedHere` 判本会话日志里有没有 `tool_result.spilled.blobId` 指向它（没有一律当不存在），再整段取回、UTF-8 解码、按**字符**切片、按 token 上限裁，头部写明范围、总长与续读起点。

### handoff

1. `afterTool` 见到 `handoff` 调用：同轮第二次调用直接以 isError 回绝；否则 `parseHandoffArgs` 解析。
2. `intentOf(ctx, args)` 组装意图：`composeHandoffNote` 把摘要与编号的下一步排成一段（既是旧会话 `handoff.summary` 也是新会话 seq 1 的文字）；`carriedPins(ctx)` 把可见且未被 `supersedes` 取代的 pin 复制成 `opening` 草稿；触发消息缺省取 `lastVisibleUserMessage(ctx.events)`。
3. 意图记在 `WeakMap<TurnContext>`，把占位结果换成回执（带了几条下一步、几条 pin、有没有触发消息）。同轮其余工具照常执行。
4. `onTurnEnd`：内存里有意图就返回 `{ handoff: intent }`；没有则用 `unfinishedHandoffArgs(ctx.timeline)` 从日志重建（上一次 run 在这一轮被打断的情形，R2），重建不出就无意见。core 循环随后 append `core.handoff`、开新会话、调 `onHandoff`。

### memory

1. run 起步：静态贡献是函数形态——`SocketSetup.memory` 存在才返回 `[memory 工具]` 与 `MEMORY_RULES`；不存在则两者都不注册并经 `warn` 告警一次。本模块没有任何钩子。
2. 工具 `validate` 走 `parseMemoryCommand`：认出六个 command 之一，每个路径都先过 `resolveMemoryPath` 规范化（防穿越）。
3. `execute`：`bindMemoryFs(ctx.memory, namespace(ctx))` 把命名空间前缀绑上（模型看到的路径始终是 `/memories/...`），再 `executeMemoryCommand(fs, cmd, limits)` 执行。
4. 成功的读写 `ctx.emit` 一条 `core.memory_op(actor=model, provenance.ref=toolCallId)`，循环把它排在 `tool_result` 之前；失败不留（tool_call 入参 + isError 结果已是审计痕）。`memory_op` 被投影过滤，模型看不见。

### skills

1. run 起步：`tools` 与 `systemPrompt` 都是异步函数，共用按 `SocketSetup` 缓存的 `menuFor(setup)`——`source.list("${root}/")` 一次，只认 `${root}/<name>/SKILL.md`，每份读头部 `parseSkillMarkdown`，`name` 须与目录名一致；不合规的记 `rejected` 并各告警一次；合规的按 name 排序成菜单。菜单为空或没给 `source` → 两项贡献都返回 undefined（不注册）并告警一次。
2. 系统提示片段 = `SKILL_RULES`（有相关技能先读再动手、读过不重读、附件按需）+ `Available skills:` 每项一行 `- name: description`；进 configHash，run 内不变，下一 run 重读。
3. 模型调 `skill_read({ name, path?, range? })`：`validate` 用 `SKILL_NAME_RE` 校 name，`path`（缺省 `SKILL.md`）拼到 `${root}/${name}/` 下走共用的 `resolveRootedPath`（穿越、反斜杠、百分号编码在此被拒，错误只提技能自己的根）；`execute` 读 `${root}/${name}/${path}`，null 统一回 "Skill file … does not exist."（不区分技能不在 / 文件不在 / 越界），正文经 `formatFileView` 带行号、超 `maxReadChars`（缺省 40000）按行截断并提示 `range` 续读。
4. 结果以 `tool_result(trust=system)` 进日志（循环按 `Tool.resultTrust` 落，只用于成功结果），降级层不套 `<untrusted>`；`resultPolicy.maxTokens = maxReadChars` 让 spill 不再把它外溢。不留新事件类型，tool_call / tool_result 就是审计痕。

### approval

1. `beforeTool`：用 `{ toolCallId, name, args, tool }` 跑 `evaluatePolicy`。工具表里没有的工具在看任何规则之前就 deny（`approval.unknown_tool`）。
2. 入参先过工具自己的 `validate`（R1）：规则、`needsApproval`、审批摘要看到的都是规范化后的入参；校验不过不问人，以 `approval.invalid_args` 放行给循环拒掉。
3. 依次跑 deny 段 → ask 段 → 工具自己的 `needsApproval`（视作 ask 段最后一条，policyId 为 core 的 `tool.needsApproval`）→ allow 段，每段首匹配即定；任一规则或 `needsApproval` 抛错立刻按 deny 处理（fail-closed）并经 `warn` 告警。
4. 三段都没命中按 `unmatched`（缺省 `byRisk`：`risk: "low"` 放行，medium / high / 未声明先问人）。
5. 落点：**allow** 返回 `"proceed"` 且不留任何事件；**ask** 返回 `{ defer: { policyId, summary } }`，循环 append `approval_request` 并以 `paused(approval)` 返回；**deny** 先 `ctx.emit` 一条 `core.approval_decision(approved=false, by=策略 id, reason)`，再返回 `{ block: reason }`。

### budget

1. `afterModel`：记下本轮模型有没有发工具调用（`WeakMap<TurnContext>`）。
2. `onTurnEnd`：本轮模型已收尾作答就不拦（循环本来就要停）。
3. 还要继续时跑 `checkBudget(ctx.budget, limits)`：`contextTokens` 取 `contextTokensOf(lastUsage)`（input + cacheRead + cacheWrite），其余四维直接读 `tokensSpent` / `turns` / `toolCalls` / `wallMs`；**用量 ≥ 上限**即触顶。
4. 有触顶维度就返回 `{ pause: { reason: "budget", note } }`，note（缺省 `defaultBudgetNote`）列出全部触顶维度与用量/上限，进 `Interruption` 给宿主看。上限按每次 run 计，宿主续跑即再批一份。

## 核心设计决策

**工具与规则提示走 Socket 静态贡献，不走 beforeModel 补丁**（B2）— 模块的工具若靠 `beforeModel` 注入，续跑补齐 pending 调用时（在 `beforeModel` 之前）工具不在场会报"未知工具"，且不计入 `configHash`、恢复时察觉不到模块被拆装。静态贡献整个 run 不变，也满足 prompt cache 约束。边界：动态增删工具仍走 `beforeModel`，但每改一次缓存前缀重算。

**真正的工作在 afterTool，工具的 execute 只占位**（B2 / B3 / B5）— compact / pins / handoff 都要"模型本轮看到的视图 + 完整时间线"，这些只有 `TurnContext` 有、`ToolContext` 没有；工具自己 `readTimeline` 又会绕开宿主的事件注册表（`ext.*` 事件读不出）。边界：模型看到的占位串只会在"装了工具却没装 Socket"时出现，文案里直说了。

**模块没有跨轮状态**（compact / handoff / budget）— 本轮的临时记录挂在 `WeakMap<TurnContext>` 上，轮结束随 ctx 回收，两个并发 run 互不干扰。边界：被打断的轮没有 `onTurnEnd`，内存记录会丢，所以 handoff 另有从日志重建的路（见下）。

**感知按渲染后的文字判重、所有数值先分档**（B1）— 精确值每轮都变会让每轮都多一条说明；档位一段会话只变三四次。按文字而非读数判重，是因为宿主换了 `render` 之后只要模型看到的没变就没必要多一条。边界：自定义 `render` 必须是纯函数，否则每轮都追加。

**感知的上下文使用率用加法校准而不是比例**（B8）— 投影只数可见事件正文，系统提示、工具表、thinking 签名块都不在内，真实 input 可高出一倍；这块开销在一个 run 里基本是常量，比例校准会随历史变长把误差放大（100k 估成 200k）。边界：首轮没有可对照请求时开销为 0；`calibrate: false` 关闭。

**折叠说明单列一句"什么还在视野里"**（E3 实测）— 只写 "compactions so far: 1" 时，DeepSeek v4 flash 会把仍在上文的早期工具结果当成"已被折叠"，被问到时拒答。这句话只随整理次数变，不引入每轮变化的数字，不扰动缓存。

**compact 的切点与投影裁剪同一口径**（B2）— 只在模型轮边界切、发起调用所在的轮永不折（Anthropic 要求带 tool_use 的 assistant 轮连同 thinking 原样回放，拆开就是 400）、seq 封闭（旧 compaction 不能吸收就留在视图里继续可见）。边界：入参用 `keepRecentTurns` 而不是方案原写的 `coverUntilSeq`——模型看不到 seq。

**被折叠范围内最近的一条用户消息由库保住**（B2）— 真模型实测：用户说"先整理，然后做 X"，模型整理时把这条也折了进去，摘要只写"接着做第二部分"，整理完反问第二部分是什么。模型没法复述它还没开始处理的指令。边界：`keepLatestUserMessage: false` 可关。

**摘要之后自动附被折叠工具结果清单，并给 `recall({ seq })` 取回**（E3c）— 整理丢细节是机制本身的代价（两个模型族都把"复核过的字段值"整理成"状态正常"一句结论），与其教模型该留什么，不如让它知道什么还能拿回来；原件本来就在日志里，缺的只是一条读回去的路。清单范围含被吸收旧摘要盖住的原件（从完整时间线补回），脑子自己的回执（compact / pin / recall / fetch_blob）不列。边界：`manifest: false` 关清单时应一并换 `rules`，缺省文案里关于清单的说法就不成立了。

**清单与取回用 tool_result 的 seq，不用 toolCallId 或事件 id**（E3c 附）— seq 短、模型能抄；fork 出的会话（eval 探针、宿主分叉）三种存储实现都保留 seq，子会话里照样有效；toolCallId 是厂商格式且长，事件 id 36 位。

**pin 有取代机制、没有 unpin，模型只能替换自己钉的**（B3）— 不加取代，抽取式 pin 每变一次就永久多一条、模型改口也会留下两条互相矛盾的 pin。append-only 日志里唯一的撤销表达就是"被后来者取代"。宿主钉的是宿主的约束，模型动不了（指向宿主 pin 报错）。

**pin 字数校验加两成容差，报错仍报声明值**（E3c 附）— 上限写进工具说明与 schema `maxLength` 后，Sonnet 5 仍写出 502 / 545 / 558 字符：模型瞄着上限写、数不准自己的字数，差几个字就拒掉只是白费一轮。声明值仍是 500，容差只吃掉数错的那一点；`overshootTolerance: 0` 可严格。

**spill 缺省阈值 16k，不是更小**（E3 对照）— 6k 阈值把模型必须整读的 10k token 计划列表外溢出去，模型再分两三次取回，平白多两三轮、总 token 翻倍而完成度不变；16k 时同一任务 4 轮做完。外溢是给"模型不需要全读"的巨量结果准备的安全网。

**没有 BlobStore 时外溢自动关闭，不退化成截断**（B4）— 静默截断会在宿主不知情时丢数据；宁可原样通过让感知与预算兜底，并告警一次。边界：工具显式声明 `overflow: "truncate"` 的照常截断（截断不需要存储）。

**fetch_blob 用字符偏移，授权按"本会话时间线引用过"**（B4 / B9 附）— `BlobStore.slice` 按字节切会切坏 UTF-8 多字节字符，而模型说的偏移是字符。授权口径从"blob.meta.sessionId 等于当前会话"改成"本会话某条 `tool_result.spilled.blobId` 指向它"：fork 出的会话复制了 tool_result 却不复制字节，旧口径下看得见 id 取不回。边界：未被本会话引用的 id 一律当不存在（回执与"真不存在"同一句话）；handoff 不复制 tool_result，所以新会话仍读不到外溢结果。（`docs/技术方案.md` §9.4 仍写"只能读本会话的 blob"，以此处为准。）

**审批管线建议放 sockets 末尾，且入参先过 validate**（B7 / R1）— 放首位会让后面的 `rewrite` 绕过按入参写的规则；放末尾则前面的钩子只可能收紧。审批人批的必须是将要执行的那份入参，`needsApproval(input)` 才不是谎话；校验不过不问人，以 `approval.invalid_args` 放行给循环以"入参不合法"拒掉。边界：宿主已批准的调用再遇到 `defer` 只是略过，deny 在任何顺序下都拦得住。

**deny 留痕、allow 不留痕、任何异常按 deny**（B7）— deny 先 emit `approval_decision(by=规则 id)` 再 block，谁拒的、为什么有据可查；allow 每次记一条会让日志翻倍而信息量为零（tool_call → tool_result 已是完整记录）。fail-closed 覆盖规则与 `needsApproval` 函数两处。

**handoff 的意图按日志重建，不只靠内存**（R2）— 模型调了 handoff 拿到回执、那一轮却因审批暂停或宿主中止没走到 `onTurnEnd` 时，`WeakMap` 里的意图随之丢失。`unfinishedHandoffArgs` 的判据：最后一条成功的 handoff 回执之后既没有 `core.handoff`（还没交接）也没有新的模型输出（没开新的一轮）。这是宪法二的直接推论——回执与入参都在日志里，换进程续跑也成立。

**pin 作为独立事件跟着交接走，不并进摘要**（B5）— pin 塞进摘要正文就不再是 pin，在新会话里穿不过那边的折叠，pins() 的判重也失效。落成 `HandoffIntent.opening`（摘要一条 + pin 各一条），保留 actor 与 `meta.pin`、provenance 指回旧事件。

**交接不带走外溢结果与其余历史，并且不自动续接**（B5）— 新会话只有摘要说明、带过去的 pin 与触发消息；外溢到 BlobStore 的结果读不到（`fetch_blob` 按会话引用授权，handoff 不复制 `tool_result`），规则提示里已告知模型"把要紧的写进摘要"。新会话由宿主再起一次 `runLoop`，因为宿主要先用 `onHandoff(from, to)` 重绑对话锚点。

**memory 缺 MemoryStore 则不注册工具与规则**（B6）— 注册一个一用就报错的工具，会让被规则要求"先查记忆"的模型每轮撞墙。落地靠 core 的 `StaticContribution<T>` 函数形态（按 `SocketSetup` 算一次），比 `beforeModel` 补丁干净且不碰缓存前缀。

**memory 是自定义工具而非 Anthropic 原生 `memory_20250818`**（B6）— 降级层 pi-ai 不支持 provider-defined 工具，且 reins 要跨模型族；六个 command 与字段同名同义、回执文案对齐官方参考实现，模型已有的习惯直接迁移。有意的三处差异：`create` 对已存在文件是覆盖并在回执说明；`view` 超 `maxViewChars` 按行截断并提示用 `view_range` 续读；写类操作有单文件上限。

**记忆路径宁严勿宽，命名空间只是一个选项**（B6）— 拒绝 `.` / `..` / 反斜杠 / 百分号编码 / 控制字符 / 段首尾空白，折叠重复斜杠得到唯一规范形态（同一个文件只有一个键）。隔离靠 `namespace(ctx) → 前缀`，存储层与日志都不知道"角色"这个概念。边界：`rename` / `delete` 目录不是原子的（MemoryStore 没有事务），顺序都是先写后删，中途失败最多多出重复、不会丢。

**感知只追加在末尾、永不改前缀**（B1）— prompt cache 的五条约束在 perception 里的落实：只 append 不改投影；旧说明不删不隐藏（隐藏一条曾经可见的事件等于改前缀，比多留几十个 token 更贵）；`beforeModel` 永远返回 `undefined` 不动系统提示与工具表；断点交给降级层保住；唯一允许打掉缓存的是 compaction。边界：折叠把旧说明盖掉后，下一轮会按新读数重新注入一条。

**外溢做在 afterTool，而不是包装工具的 execute**（B4）— 宿主的工具不必知道 reins 的存在（P3），MCP / OpenAPI 来源的工具同样受益；`afterTool` 拿到的是尚未 append 的草稿，返回即替换，日志里只有一条 `tool_result`（T9），不会出现"结果 + 替换结果"两条。边界：`spilled` 字段只给 UI / 回放 / 感知看，降级层不翻译它。

**连续整理计数按"轮"分段，收尾轮不拦**（B2）— 阈值兜底的 compaction 在日志里紧贴下一轮模型输出之前，按模型轮起点分段会把它算进上一轮，连续三轮兜底就永远数不到 3（`segmentTimelineByTurn` 把开轮时追加的兜底 compaction 与系统说明归入其后那一轮）。模型已收尾作答的轮不拦，理由与 budget 相同。

**规则提示是一等交付物**（B2 / B3 / B4 / B5 / B6 注释）— 什么时候整理、什么值得钉、大结果该不该分页读、什么时候该换会话、记什么进记忆，都是模型的判断，但判断需要经验，这几段文字就是经验。它们只讲经验不下指令，放在整个 run 逐字不变的系统提示里；每轮变化的读数由 perception 以 `system_note` 追加在末尾，两者分工不重叠。

**技能菜单进系统提示、正文走工具结果，不把 SKILL.md 全文塞 system**（S1）— 加载哪个技能是模型的判断（宪法一）：菜单只给 name + description，翻不翻、翻哪份由模型定；正文以 `tool_result` 进时间线（宪法二），compact 折叠 / `recall` 取回 / spill 外溢零改动适用。AdRate 示例 09-08 把两份 Skill 全文（约 37k 字符）塞进系统提示是反面做法，09-13 改成第一个真实样本，两族真模型都在第一轮就先 `skill_read` 两份技能再动手。边界：技能表变了只影响下一 run（菜单进 configHash，暂停中变化按配置漂移处理）。

**载体接口不新造：`SkillSource = Pick<MemoryStore, "list" | "read">`**（S1）— 任何 MemoryStore 天然满足，宿主已有的记忆表直接当技能库（`/skills` 与 `/memories` 同一张表两个前缀，模型的 memory 工具够不到 `/skills`）；文件系统载体放 `@reins/brain/node`，字符串预填用 `inlineSkills`。边界：AdRate `skills install` 落盘的 SKILL.md 只是存根，正文要问 CLI——所以示例用 `inlineSkills` 而不是 `fsSkillSource`（踩坑记录 2026-09-13）。

**`skill_read` 结果 trust 是 system，靠 core 新加的 `Tool.resultTrust` 落**（S1）— 技能是宿主写的说明书，视同系统提示可信，套 `<untrusted>` 会让模型把契约当数据。口子开在 Tool 上而不是模块里的 afterTool：TanStack 适配器与 runLoop 两条路都要认，且只用于成功结果，isError 与执行抛错仍缺省 untrusted。边界：第三期若允许模型写技能，模型写的必须回到 untrusted。

**`skill_read` 缺省上限 40000 字符而不是 memory view 的 16000，且 spill 不再切它**（S1 实测）— Agent Skills 规范建议 SKILL.md ≤ 500 行（约 40k 字符）；AdRate 24.5k 字符的技能在 16k 上限下被截掉 110 行（含"Keep Campaign writes server-owned"），DeepSeek 与 Claude 都没有按截断提示续读就开工。"先读再动手"的说明书被截断等于没读全，缺省要让规范内的技能一次读完；`resultPolicy.maxTokens = maxReadChars`（token 数不会超过字符数）让 spill 的按工具限额永远放行，否则 6k 阈值的示例会把技能正文换成预览 + fetch_blob，让模型再翻一次。

**缺 source 或空菜单都不注册，告警一次**（S1）— 与 memory 的"缺则不注册"同理：空菜单加一个一用就"不存在"的工具只会让被规则要求"先读技能"的模型撞墙。不合规的单份 SKILL.md 单独跳过（各告警一次），一份坏文件不拖垮整个菜单。

**fsSkillSource 不列符号链接、read 走 realpath**（S1）— 技能目录里一个指向外面的链接不能把 `/etc/passwd` 变成"附件"；载体可能被宿主直接拿去用，不能依赖 skills 模块一定过滤过路径，所以 read 自己再拒一次 `..` / 隐藏段 / root 之外。

**预算按每次 run 计，且只拦模型还要继续的轮**（B8）— 收尾作答的轮循环本来就要停，把一次正常结束改成 `paused` 只会让宿主续跑一个没事可做的会话。per-run 让"暂停 = 找宿主要更多预算"最直白；会话级配额由宿主聚合 `budget_usage` 自己做（要"整个会话不超过 X"就把 X 减去已用量再传进来）。
