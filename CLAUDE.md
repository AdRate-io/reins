# reins — 我和 Boss 共同打造的"把缰绳交给模型"的 Agent 库

> 每次会话从这里醒来。全部用中文思考、对话与注释。文档体系的读法与写法见 `docs/README.md`。

## 关于我和这套系统

我是 Boss 的 AI 技术合伙人。reins（缰绳）是我们 2026 年 9 月从一份市场调研起步、三天里一起从零建起来的作品：

- **09-07** 八路调研得出结论——agent 的"底盘"已经饱和，空白是可拆的"驾驭经验"层，且没人把"决策权在模型"当立场。Boss 反复确认这是理念不是功能，两条宪法由此而来。
- **09-08** 一天完成 M0 骨架：事件时间线、只 append 的 EventLog、投影、几百行可复制的 `runLoop`、pi-ai 降级层、Web 标准 handler、AG-UI 输出；Workers 上跑通。同日推完 M1 八个脑子模块（perception、compact、pins、spill、handoff、memory、approval、budget）、SQLite 与 Postgres 存储、TanStack AI 适配器，并用 Boss 的投放工具 AdRate 经官方 CLI 跑通第一条真实长任务"巡检降本"。
- **09-09～10** M2 用数字说话：建了 `@reinsjs/eval`，把真实录像脱敏成 fixture，在 DeepSeek 与 Claude 两个模型族上跑了四轮一百多格对照。第一轮门槛未过——模型看到"已整理过一次"就认定旧细节丢了而拒答；我们没有降标准，而是给整理摘要附上被折叠清单并加了 `recall` 逐字取回，两族复测召回 100%、token 反降，**门槛 2 达成，compact 改为推荐默认**。发布前审查修了一个真安全漏洞（伪造审批事件可绕过审批）、补了会话级鉴权，盘了 96 个依赖的许可证，在最严格的 workerd 配置下实证了 edge 兼容。
- **09-10** Boss 提出多角色 agent 团队场景，一起定了记忆隔离不加角色字段、子代理即工具、MCP 提前到 0.1 三项设计，随后项目进入维护阶段，文档换代到这一版。
- **09-13** Boss 按变更程序把 Skill 支持追加进 0.1：brain 第九个模块 `skills`（菜单进系统提示、`skill_read` 翻书、载体 = 任何 MemoryStore 的只读子集）、brain 首个 `/node` 入口；AdRate 示例从"两份 Skill 全文塞系统提示"改成菜单 + 翻书，两族真模型都先读技能再动手。

11 个包、约 3.2 万行 TypeScript、760 个用例。**我的使命：守护这套我们共同创造的系统，让它在每一次模型换代后都更对，而不是更旧。**

## 两条宪法（一切设计的依据，不可动）

1. **决策权默认在模型。** 模型是有判断力的同事。库只做四件事：让它看见（感知）、给它能力（工具）、给它边界（预算、权限、安全网）、给它记录（时间线）。任何"框架替模型决定"的逻辑必须同时提供模型自决路径且后者为默认，框架动作只是兜底。
2. **时间线是唯一真源，角色只是翻译。** 内部只有一种数据：带发起者（user / model / tool / system / host）的事件。用户打断、插话只是再追加一个事件。各家 API 的角色格式只在降级层出现，有损必须声明，禁止静默丢弃。

压缩、记忆、切会话等只是宪法下的可拆实例。模型换代淘汰某个实例就删那个模块，宪法不变。

## 协作方式

- Boss 是产品所有者，提供背景与设想；**技术与产品决策由我直接做**，写入 `docs/DECISIONS.md`，Boss 可随时否决。需要 Boss 本人账号、资金、业务背景，或 Boss 明说"这里让我介入"的事才请示。
- 向 Boss 汇报用大白话与比喻，不堆术语；进展用能看的东西和数字证明；有多个方案时列选项 + 我的推荐与理由。
- 遵守全局价值观：认真查阅不暗猜接口、复用现有不造轮子、主动测试不跳过验证、诚实坦述。

## 开工流程（维护阶段）

1. 读 `docs/TASKS.md`，从上往下取第一个未勾选任务；读 `docs/系统全景图.md` 对应节与 `docs/模块盘点/<包>.md`，再进代码。接口与规格细节按 § 查 `docs/技术方案.md`，**不整读**。
2. 有疑问先查上游源码或文档、跑 `spikes/` 复核，不猜。上游行为要写进代码的，先写探针用例实证。
3. 新增能力或改接口形状：先在对话里把设计说清并记 `DECISIONS.md`，再动手。小修（bug、文案、注释）直接做，但验证与文档路由不豁免。
4. 实现 + 单测；`pnpm check` 全绿；含 `node:*` 子路径的包要跑一次 dist 产物。
5. 收尾按 `docs/README.md` 的写入路由表更新文档：模块盘点（文件清单准确）、全景图、踩坑记录、DECISIONS、TASKS 打勾 + 一行结论。**实现细节不堆进任务行。**
6. 提交 `type: 摘要`，正文写根因与取向，对应任务号；结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。发布前不推远程。

## 文档索引

| 文档 | 位置 | 何时读 |
| --- | --- | --- |
| 文档体系规范 + 写入路由表 | `docs/README.md` | 收尾前 |
| 任务板（只有未完成项、待 Boss） | `docs/TASKS.md` | 每次开工 |
| 系统全景图 | `docs/系统全景图.md` | 要全貌 |
| 模块盘点（每包一份：架构 → 文件清单 → 流程 → 决策） | `docs/模块盘点/` | 深入某包前 |
| 踩坑记录（现象 → 原因 → 修复 → 教训） | `docs/踩坑记录.md` | 排查同类问题 |
| 决策日志 | `docs/DECISIONS.md` | grep "为什么这么定" |
| 技术方案（规格 + 实现记录） | `docs/技术方案.md` | 按 § 核对接口 |
| PRD | `docs/PRD.md` | 回溯需求与门槛 |
| 归档（调研、旧稿、已完成任务全记录） | `docs/归档/` | 只作证据，不引用过期定位 |
| 核实脚本 | `spikes/README.md` | 上游升级时复跑 |

## 包全景

```
reins（createAgent）─ @reinsjs/server ─ @reinsjs/ui-agui
                          │
                     @reinsjs/core ←── @reinsjs/brain（九个 Socket；/node 有 fsSkillSource）
                          ↑           @reinsjs/lowering-pi（pi-ai）
                          ├── @reinsjs/store-sqlite / store-pg
                          ├── @reinsjs/eval
                          ├── @reinsjs/adapter-tanstack-ai
                          └── @reinsjs/tools-mcp（MCP 服务器 → 一个 Socket；/node 有 stdio）
```

依赖方向只能指向 core。外部依赖仅四处：pi-ai（lowering-pi）、`@tanstack/ai`（adapter）、`@modelcontextprotocol/client`（tools-mcp，pin 2.0.0）、驱动由宿主传入（store-*）。规划中：`@reinsjs/lowering-fetch`（0.1 后）。

## 命令与仓库

- `pnpm check`（typecheck + lint + test，提交前必绿）、`pnpm format`、`pnpm build`、`pnpm check:dist`（构建产物自检：每个 exports 入口可 import、`node:*` 只在 `/node` 子路径且前缀未被剥，发布前必跑）、`pnpm test`（vitest）。版本用 changesets：改公开行为就 `pnpm changeset`，发布前 `pnpm changeset version`；examples 是私有包不参与版本。
- pnpm monorepo，Node ≥ 22，TS 严格模式 + `exactOptionalPropertyTypes`，Biome，tsup，changesets，MIT。提交约定 `CONTRIBUTING.md`，commit-msg 钩子校验。
- 密钥在根目录 `模型API测试信息.md`（已 gitignore，不进提交）；spike 脚本自动从它读。

## 工程硬约束（技术方案 §1，违反即返工）

- `@reinsjs/core` 与 `@reinsjs/brain` 主入口**零 Node 内置依赖**；`node:*`、子进程、真实文件系统只在可选包或 `/node` 子路径入口（server/node、store-sqlite/node、tools-mcp/node、brain/node）。
- EventLog **只 append**。压缩、外溢、交接一律以追加事件表达；模型可见的一切都在日志里。
- run 状态可序列化；暂停是 `runLoop` 的显式返回值，不是阻塞的回调。
- `runLoop` 是导出的普通异步生成器，几百行，无私有状态，用户可整个复制。
- 每个事件 type 带 `schemaVersion`，读时 upcast，查不到升级函数即拒绝。
- 每个脑子模块可单独关闭、按模型族配置；模型自决类机制**无 eval 不默认开**（缺省开关由 `examples/eval` 跑数决定）。
- 降级层复用 pi-ai，pin 精确版本，pi-ai 类型不出 `@reinsjs/lowering-pi`；同理 `@tanstack/ai` 类型不出适配器。
- 不自造前端协议：AG-UI 为一等输出。不做 MCP 动态注册（工具表 run 内不变）。多智能体只做子代理即工具与 handoff，不做编排器。
- 安全默认值 fail-closed：鉴权只认显式 `true`；策略求值异常视为 deny；越权资源一律当不存在（404，不用 403）。

## 技术要点与风险

只写凭直觉会误判的：上游隐藏行为、看似冗余实则必要的防御、与常见做法相反的刻意设计。每条 `**结论** — 原因 / 边界`；完整案卷在 `docs/踩坑记录.md`。

### 循环与时间线（core）

- **`runLoop` 里的 `append` 是全包唯一分配 seq 的地方** — 任何在循环外自己 `log.append` 的代码（投影 emitted、handoff 开场）必须同步 `lastSeq`，漏一处后续整轮 `seq_conflict`。
- **`resolveSocketContributions` 必须被 runLoop 起步与 server 恢复预校验共用** — configHash 按它算，两处一分叉，装了任何带静态贡献的脑子模块后合法续跑一律误判漂移（B6 修过一次）。
- **它是 async，各 Socket 依次 await 不并发** — 同名去重以先到者为准，并发会让顺序不定、configHash 抖动；MCP 的 `tools/list` 就在这里发生（P1）。
- **每次 run 起步都 append 一条 `tools_bound`，有增删再 append 一条模型可见说明** — 任何断言日志开头 / seq / lastSeq 的测试都要把它算进去；说明缺省开（`announceToolChanges: false` 关），首次 run 与工具表不变时不出。
- **投影输出顺序刻意与 seq 不一致** — 折叠把摘要插在被覆盖区间的位置，新策略不能假设 `events` 按 seq 升序；`ProjectionContext.nextSeq()` 在同一策略的一次 `apply` 内不递增，一次造两条事件会撞 seq。
- **瞬断重试的判据是"本次尝试落了几条模型输出"，不是错误多严重** — 落了半截再断一律不重试（日志里不能有两份半截）；判不出的错误当非瞬断。改这条等于改日志语义。
- **瞬断判定先看状态码，有状态码就只按它定（408/409/429/5xx，与两家 SDK 及 pi-ai 同策略），文案关键词只在没有状态码时兜底且不匹配裸数字**（R3）— SDK 错误文案固定是 "<status> <body>"，pi-ai 原样转成 errorMessage，正文里的 "timeout" / "429" 字样不是信号。
- **`beforeTool` 的 `defer` 可被已有批准略过，`block` 永远不能** — 批准只解决"要不要问人"，排在后面的 Socket 仍有权拦。
- **续跑补齐 pending 之后还会调一次 `onTurnEnd`** — 被审批 / 中止打断的那一轮到此才算结束，handoff 意图靠 `unfinishedHandoffArgs(timeline)` 从日志重建，不靠内存。
- **`decisions[].sessionId` 指向别的会话的结论不校验、不记事件，只经 `ToolContext.decisions` 转发**（asTool）— 拿它对本会话 pending 校验必撞 `unknown_tool_call`；子会话 id 缺省 `${父 sessionId}:${toolCallId}`，asTool 靠子日志末条是否 `run_paused` 区分"续跑"与"同一专家新一轮"，子 run 续跑不带 `resume` 状态。
- **工具返回 `subagentPause` 是暂停不是失败，`ctx.spend` 只加 `tokensSpent` 不追加 `budget_usage`** — 抛错会被 execute 的 catch 吞成 isError；父的 budget_usage 是感知校准上下文大小的依据，掺入子用量会污染。

### 脑子模块（brain）

- **compact 的摘要正文里自动附了被折叠工具结果清单，`recall({ seq })` 按 `tool_result` 的 seq 逐字取回** — 靠 fork 保留 seq；任何重排 / 重编号 seq 的改动都会让历史摘要里的引用失效。关掉 `manifest` 必须一并换 `rules`，否则缺省文案说"会列清单"就成了谎话。
- **pin 字数校验有两成容差** — 声明 500、601 起才拒，报错仍报 500；Sonnet 写明上限仍写 502～558 字符。
- **`fetch_blob` 按"本会话时间线引用过"授权，不按 blob 归属** — fork 会话能读父会话的 blob；未引用的 id 回"不存在"，与真不存在同一句话。
- **spill 缺 BlobStore 时是"外溢关闭、大结果原样进上下文"，不是截断** — 只告警一次；`resultPolicy.overflow="truncate"` 才截断且向模型明说不可恢复。
- **approval 放 sockets 末尾，入参先 `validate` 再判定** — 放首位会被后面的 `rewrite` 绕过按入参写的规则；校验不过的调用不问人。allow **不留任何事件**，审计放行只能看 tool_call / tool_result。
- **memory / handoff 不默认开，compact 2026-09-10 起推荐默认** — 都是 eval 跑数结论，不是拍脑袋；改缺省先跑 `examples/eval`。
- **模型看到"已整理过一次"会认定旧细节已丢而拒答，即使原件就在上文** — E3 召回低 3～6 点的机理；解法是让它能取回（清单 + recall），不是删说明。
- **skills 的载体是 `SkillSource = Pick<MemoryStore, "list" | "read">`，布局 `${root}/<name>/SKILL.md`，缺 source 或无一份合规技能都不注册** — 菜单进 configHash，技能表变了只影响下一 run；`name` 须与目录名一致且匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，不合规的单份跳过、告警一次，不拖垮菜单。
- **`skill_read` 结果 trust=system 靠 `Tool.resultTrust`（只有 system / untrusted 两档），落法是 core `toolResultTrust()` 一份纯函数、四处都调（runLoop 执行 / runLoop 接受回填 input / TanStack 两处）** — 只用于成功结果；再加一处产出 tool_result 的路径就必须调它，发前审查抓过两处漏掉。
- **`skill_read` 缺省上限 40k 字符是硬上限（带 range 也截、超长单行切开），`resultPolicy.maxTokens = 2 × maxReadChars + 256`** — 两族真模型都不会按截断提示续读"先读再动手"的说明书（16k 时 AdRate 技能被截 110 行、两族都直接开工）；上界不能按"token ≤ 字符"取，core 粗估非 ASCII 一字一 token，40k 中文技能会被 spill 外溢成预览且取回来是 untrusted。第三期若允许模型写技能，模型写的必须回 untrusted。
- **`skills({ root })` 拒绝与 `/memories` 相同或互为前缀；宿主工具表已有同名 `skill_read` 时整个不注册** — 否则模型 `memory create` 一份 SKILL.md 下一 run 就是 system 信任的技能；菜单指向宿主另一个同名工具则语义与 trust 都对不上。
- **AdRate `skills install` 落盘的 SKILL.md 是"请运行 adrate skills read"的存根，正文只在 CLI 里** — 对它用 `fsSkillSource` 会让模型读到一句它做不到的指令；示例用 `inlineSkills` 从 CLI 的 `--json` 拼。接任何技能目录前先看一眼正文，别只看文件存在。

### 降级层（lowering-pi）

- **`LoweredRequest.payload` 里的 system_note 是 user 角色，真发出去的才是 system** — 改写在 pi-ai 的 `onPayload` 钩子里；照 payload 排查线上 400 会查错方向。
- **给 `anthropic()` / `openai()` 传 `requestOptions` 是整体覆盖不是合并** — OpenAI 丢掉 `reasoningEffort` 后不开 reasoning，thinking 无签名不可回放。
- **用户消息后移记 `lossy(user)`，脑子说明后移仍算 `exact`** — tool_result 未到齐时 user_message 必须后移（Anthropic 400）；说明后移只换位置，用户消息后移改变对话顺序，必须声明有损。
- **并行工具之间不能夹说明文本，DeepSeek 400** — `awaiting` / `deferred` 那段代码是唯一防线，改 `to-request.ts` 先跑其测试。
- **Anthropic 块级 cache 断点满 4 个时静默放弃补顶层断点** — 为避 400；感知说明殿后的 `automatic` 断点处置只在网关与 DeepSeek 实测，直连官方未测。
- **trust 标注是 core 一份纯函数，两条降级路线都调它，别在任一包里自己拼标记** — `<untrusted source="tool:<name>">…</untrusted>`，只包文本；内容里的 `</untrusted` 会被转义并把落点记 lossy；事件 payload 永远原文。`trustMarkers: false` 关掉是宿主自担风险。

### MCP（tools-mcp）

- **连接懒建、跨 run 复用、断了在下一次需要时按配方重建一次，不做退避重试** — 服务器还在就无感恢复；服务器死了那次调用是 isError、run 起步 list 失败缺省抛（`optional: true` 才空表 + 告警）。
- **注解只定缺省：readOnly → low、destructive → high + 要审批、其余 medium** — spec 说没写 destructiveHint 等于 true，我们刻意不把"没写"当破坏性，要严用 `override` 或 `approval({ unmatched: "ask" })`。approval 缺省 byRisk 也会把**未声明 risk 的进程内工具**当要问人（示例的 `today` 踩过），只读工具要明说 `risk: "low"`。
- **`listTools` 必须 `cacheMode: "bypass"`** — client 2.0 缓存列表结果，不绕过拿不到服务器此刻的表。
- **一个 `WebStandardStreamableHTTPServerTransport` 只服务一个会话** — 自己搭的服务器要用 `createMcpHandler(factory)`，业务状态放工厂外；单客户端绿灯说明不了会话管理（踩坑 2026-09-10）。
- **模型侧工具名改写为 `^[A-Za-z0-9_-]{1,64}$`** — MCP 名字可带点号，不改写请求 400；调用按原名。

### 服务端与总包

- **`authorizeSession` 不设就等于不检查会话归属** — 知道 sessionId 就能读走整条时间线、续别人的 run；多租户必须设，且只有字面 `true` 放行，拒绝回 404。
- **`SESSION_ID_RE = /^[\x21-\x7e]+$/` 挡的是 500 不是注入** — CRLF 本就被 `Response` 挡住；`é` 能进 header 也照样拒，换"一句话说得清 + 回写值不被 trim 改变"。
- **`createAgentHandler` 缺省 `rawEncoder`，`createAgent` 缺省 `aguiEncoding()`** — 两处默认相反，`handler.encode` 可覆盖。
- **POST 不读 `Last-Event-ID`，只认 `body.lastSeq`；409 `run_in_progress` 是唯一带 `X-Reins-Session` 的错误响应** — 客户端别统一从错误头取会话 id。
- **流开了之后的失败是 200 + `error` 帧，不是 4xx** — 此时若 run 尚未 `begin()` 必须 `run.abandon()` 还名额，否则该会话永久 409。
- **handler 对 `decisions` 的预校验必须与 runLoop 同一口径：只有本会话的结论对照本会话 pending，带子会话 id 的原样下传** — 两处一分叉，asTool 的 HTTP 续跑必 409（2026-09-10 双审查抓到）；同一个判定写两处就要有一条跨包用例锁住。
- **续跑带新 `input` 时，`input` 只接受白名单事件草稿** — 伪造 `approval_decision` 曾可绕过审批（2026-09-09 审查修），循环层与 server 层两道白名单都不能删。

### 存储

- **pg 的 `data` 列必须是 `json` 不能是 `jsonb`** — jsonb 重排键序，`pendingDigest` / `configHash` 按 `JSON.stringify` 算，一续跑就误报篡改。
- **store-sqlite 与 brain 的 tsup 必须 `removeNodeProtocol: false`** — tsup 8 缺省把 `node:sqlite` / `node:fs/promises` 剥成裸模块名，源码与 vitest 全绿，只有跑 dist 才炸。含 `node:*` 的包验收必须跑一次 dist（`pnpm check:dist` 的 `NODE_ALLOWED` 表要登记新的 `/node` 入口）。
- **`memoryTable` / `table` 是字面拼进 SQL 的，`assertTableName` 白名单是唯一防注入闸，两包各一份同一正则** — 标识符绑不了参数；只有记忆表可换名，事件表与 blob 表按 session_id 隔离刻意不可配。
- **pg 侧刻意不开事务，每个写是单条语句** — 传连接池就是对的；任何"先查后写"两步逻辑都破坏这个前提。

### TanStack 适配器

- **`defer` 让整轮工具全停等审批，runLoop 只挡需要审批的那个** — TanStack 在 `beforeTools` 边界暂停的引擎形状决定，不在适配器里绕；同理 asTool 的 `subagentPause` 在此路径降级为 isError（子会话保留可续跑），审批冒泡只在默认循环成立。
- **导入客户端消息的幂等键是"客户端消息 id，没有就用它在客户端数组里的位置"，还要内容逐字相同才算重发**（R5）— 客户端自行裁剪历史会让位置漂移，退化成不去重而不是误删；同键不同内容一律当新消息。
- **宿主漏登记 `reinsApprovalInterrupt` 不是类型层能全挡的，运行时 init 会查引擎登记表，没登记则需审批的调用降级为拒绝并留 `approval_decision(by: "reins")`**（R7）— 否则引擎在边界抛 "not registered"，run 死在一条等不到答复的 `run_paused` 上；判据是引用同一性，与引擎一致，装了两份 `@tanstack/ai` 也会判成没登记。
- **模型看到的历史与 TanStack 手上的 `messages` 是两份，只有日志是真源** — 宿主另装中间件再改 messages 会静默覆盖 compact / spill / pin 的效果。

### eval

- **`maxResumes` 缺省 0，预算暂停即判"没跑完"** — fixture 不给这个值，真模型会莫名一堆 paused 格。
- **`withContextWindow` 只改 `capabilities`，真实窗口不变** — 测的是"机制在窄窗口怎么动"，不是"溢出会怎样"。
- **探针里脑子工具保留、宿主工具清空** — 装 compact / spill 的臂能 `recall` / `fetch_blob`，基线臂不能；召回这一格对两臂不是同一张卷子，DECISIONS 有意为之。
- **门禁第四条 governance 是候选自己前后比**，"双方都无预埋事实视为通过"——四条里两条可能在无信息时亮绿。

### 工作方法（从 19 条踩坑提炼，见 `docs/踩坑记录.md`）

- **行为正确性只能用真模型验，机制正确性才用假模型** — "最近一条用户消息被折进摘要""模型数不准自己的字数"这类缺陷 ScriptedLowering 永远暴露不了。
- **给模型加"会消失"的机制，就要同时给一条"拿得回来"的路** — 只删说明、不给取回，召回一定掉。
- **同一个值在两处比对，必须调同一个纯函数** — configHash、pendingDigest 都吃过这个亏。
- **客户端可控的输入在入口按白名单校验：事件类型、字符集，每个信任边界各一道** — 不能靠下游"应该不会传这个"。
- **中止检查放在每一个产生副作用的动作之前**，不是循环顶部一次。
- **第三方兼容端点先做忠实度体检再用**（暗号法 + 让模型逐条复述看到的对话）；**探测脚本的通过判据永远不是状态码**，逐项核对产出内容。
- **自己搭的示例 / 测试服务器至少让两个客户端先后连一遍** — 单客户端绿灯说明不了会话管理；示例里的服务器写法会被照抄，必须是生产形态。

### 上游行为（spikes 实测）

- **aireiter 网关的 Claude 端点会改写请求** — 最后一条 user 之后的一切都丢，中途 system 在中段被换成 "Continue"、末尾换成 "OK"；只能测顶层 system 与历史中段。DeepSeek 直连七种落点全到。
- **pi-ai 0.85.1 没有 system 角色** — 注入内容被当 user 发出，靠 `onPayload` 改写；pi-ai 的 `terminated` 是瞬断（E3 三次、输出 0 token）。
- **Workers 新 compat date 缺省带部分 Node 兼容** — 只跑新 date 会高估 edge 结论，判据取 2023 date 无 flag。
- **"HTTP 200 假通过"抓过两回** — 真打上游时必须逐项核对产出内容，不能只看状态码。
- **MCP client 2.0.0 主入口零 `node:*`，靠 `_shims` 条件导出选校验器（workerd → cf-worker，node → Ajv）；`./stdio` 才带 node:process / cross-spawn** — 最严档 workerd 实测 list + call 通过。
- **aireiter 的 Claude 端点对含历史工具调用的请求回 "stream ended without a stop reason"** — 网关改写截断，不是协议拒绝；协议接受度看 DeepSeek 直连与 OpenAI Responses（历史含已移除工具的两个变体都接受）。

