# AdRate 对 reins 的优化建议（2026-11-05）

> **来源**：AdRate（投放工具，reins 的 dogfood 宿主）在正式接入前，对照 reins `main@11c160f`（core 0.9.0 / server 0.4.3 / brain 0.8.2）核实出的问题。由 Boss 带到 reins 项目评估、实施、发版；AdRate 侧不写兜底代码，等发版后再调整接入方案。
> **编号**：「AdRate 建议 N」，各批顺序编号（第一批 1～4、第二批 5、第三批 6），与 reins 文档中的「OnSet 建议 N」同一用法。
> **公开性**：已按 reins `docs/README.md` 的公开性规则撰写，不含真实业务数据，可以直接移入 reins 仓库。
> **宿主背景**：AdRate 是 TikTok 广告投放 SaaS，站内 Agent 的写工具会直接改动用户的广告（建广告、改预算、开关计划），**重复执行意味着重复花用户的广告费**。会话与 run 存活在服务端：用户断开后 run 继续跑完，前端只同步状态并提供"停止"按钮。

## reins 回复（2026-11-05）

> 四条都采纳（方案已过 reins 内部审查并按意见修订）。1、2、3 按建议的方向做，形态由 reins 定；4 采纳收窄，理由见该节回复。实施方案：`docs/implementation-plans/2026-11-05-停止语义与中断不重放.md`（✅ 已完成 2026-11-05）。
>
> **已发版**：core 0.10.0、server 0.5.0、agent 0.5.0（其余依赖包同步 patch）。实施中相对下文回复的增补与升级注意见下一节「实施与发版结果」，AdRate 按文末回填表调整。

文案先用真模型验证过，再定方案（`spikes/stop-and-interrupt/`）。用 AdRate 的形状造了六个现场："改 A 预算 + 暂停 B"中途停止后，用户分别改口、要求接着做、问别的；改预算中途进程死亡，上游实际改成了或没改成；等审批时改口。DeepSeek `deepseek-flash` 30/30。Claude Sonnet 5 / Opus 5.5 在全部可观察的格里没有一次违反判据（线路额度中断，只计决策那一步已落日志的格）。

结论：模型拿到"没执行""结果未知"之后，会结合用户新话决定；结果未知时总是先查再动；不需要额外的规则提示。

## 实施与发版结果（2026-11-05）

四条按下文各节「reins 回复」落地，回复里的形状与文案都没有变。实施和发版前审查中多做了以下几件，AdRate 接入时需要知道：

- **停止后不会再有写工具"漏网"。** 发版前审查发现两个空档：①同批前一个调用正在判定要不要审批时用户点了停止；②模型回复刚收完、第一个工具还没开跑时点了停止。这两种情况下，后面的写工具原本仍会执行。现在每个工具执行前都会检查一次停止：没开始的一律落"没执行"，开始执行的照常跑完（与回复一致）。
- **连接阶段被停止的，结果是暂停，不是报错。** 如果模型请求还在建立连接时用户就点了停止，run 原先会以 `error` 结束，现在统一为 `paused(host)`，并照常收尾。
- **子代理（`asTool`）判断"续跑还是新任务"的依据改了。** 现在看的是父日志里这次调用是否已有 `tool_started`，不再看子日志末条是不是 `run_paused`。原判据下，停止后同一位专家的下一轮新任务会被当成续跑而吞掉。专家开新一轮前，如果子会话里还有遗留调用，会先以 `RunStop("host")` 收尾，落 `Not executed: an earlier run was interrupted before this call started.`。这句不说"用户停止"，因为遗留调用多半是进程中途死亡留下的。宿主一般用不到 `RunStop("host")`，停止按钮仍然用缺省的 `RunStop()`，经 server 停止请求时会自动用上。
- **只做收尾的 run 不会往日志里写多余内容。** 空闲时发停止请求，reins 会起一个只收尾的 run。这个 run 只写"收尾结果 + `run_paused`"，不写工具表快照，也不写工具变化说明，更不会触发上下文整理。
- **真模型端到端验证。** spike 改为直接跑真实现：真的 `RunStop`、真的进程死亡、模拟 MCP 写工具被中止掐断，并新增"子会话遗留调用收尾后同一任务再来"一格。DeepSeek 8 个场景 × 3 遍，**24/24** 通过。

**升级注意（AdRate 发版时）：**

- 会话日志里一旦写过 `core.tool_started`，`@reinsjs/core` 0.9 及更早版本就读不了这个会话。升级后如需回滚，要连同这些会话一起考虑。
- 升级前已经停在子代理内部、正在等审批的会话，升级后续跑时，子代理会被当成新任务重新开跑。建议在升级前让这类会话先走完。
- 升级前产生的暂停状态不带新的两个摘要，所以仍按旧规则整体比对配置（见建议 4 回复）。部署时正在等审批的会话，如果配置变了，仍会收到 409。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | 用户主动停止时，未执行的调用落"未执行"结果，不再留作补跑 | core（+ server） | 宪法一：停止后要不要重做，由模型结合用户新输入决定 | 高，AdRate 方案前置 |
| 2 | 执行被中断（进程死亡）的调用不自动重放，落"结果未知" | core | 宪法二：时间线缺"已开始执行"这一事实；宪法一：重试与否归模型 | 高，AdRate 方案前置 |
| 3 | server 提供显式停止请求 | server | 无冲突，是 `onDisconnect: "continue"` 缺省值的配套能力 | 中，AdRate 方案前置 |
| 4 | 续跑的配置漂移校验收窄到"待执行调用相关"的部分 | core / server | **触及刻意取舍**（"暂停时模型看到的工具集就是它做决定的依据"），由 reins 侧评估 | 中，可选 |

建议 1、2 合起来，回答的是同一件事："补齐 pending"这一条路目前不区分 pending 的成因。

---

## AdRate 建议 1：区分"停止"与"暂停"

### 现状

宿主中止（`signal` abort）后，同批里余下的调用"不再执行、留作 pending"，下一个 run 开头按"补齐 pending"执行掉。见 `core/src/loop/run-loop.ts`：

- 393～401 行：起步时若已中止，进入 `paused(host)`；
- 403～436 行：补齐 pending；
- 918 行：批中途中止后 break。

丢租约（`leasedRunRegistry` 心跳失败）走的是同一个 `controller.abort()`。

### 问题

对**丢租约 / 进程迁移**这类系统暂停，"留作 pending、恢复时续上"是对的。

对**用户主动停止**是错的：

- 用户点停止的意思是"别再做了"；
- 但他下一条消息（可能就是"等等，先别改预算"）起跑时，被停掉的写调用会先被执行，模型还没读到这条新消息；
- 若宿主装了 `approval()`，这些调用会再弹一次确认，但用户无从知道这是被停掉的那一批。

### 建议形态（供参考，形态由 reins 定）

- 中止区分原因，例如 `controller.abort(reason)` 约定 `"stop"` 与其它值。
- `reason` 为停止时，循环为同批余下未执行的调用逐个落 `tool_result(isError: true)`，文案如 "Not executed: the run was stopped by the user."。之后不再有 pending，模型在下一个 run 里看到"哪些没做"，结合新输入自己决定。
- 其它原因（丢租约、宿主暂停）维持现行为。
- 正在执行的那一个调用照常跑完并落结果（现行为，保留）。

### 边界

- 子代理（`asTool`）：父停止时，子是否同样按停止处理，跟随现有的中止传递规则。
- 等审批中的调用（已 `paused(approval)`）：用户不批而直接发新消息，现在会怎样、是否也该视同"未执行"，请一并评估。

### reins 回复

**采纳。** 停止是中止的一种原因：

- core 导出 `RunStop`，宿主用 `controller.abort(new RunStop())` 停止。经 server 的停止请求（建议 3）会自动用它。
- 停止时，时间线里所有没执行的调用都逐个落 `tool_result(isError: true)`，文案 `Not executed: the run was stopped by the user before this call started.`。范围包括同批排在后面的、等审批的、客户端工具。
- 正在执行的那一个：不感知 signal 的工具照常跑完、落真实结果。感知 signal 的工具（例如 MCP 工具会把 signal 传给上游调用）可能被掐断，这时不可重放的写工具落"结果未知"（见建议 2），不落"执行失败"，因为写请求可能已经到了上游。
- 停止收尾挂在循环的每一个暂停出口上：一轮开头、重试等待、**模型回复中途**（已经完整输出的调用也算）、工具批中途、补跑，同一处理。
- 被停的调用若曾经开始过，按实情分两句：上一次进程死亡留下的落"结果未知"；子代理做了一半的落 `Interrupted: the run was stopped by the user while this call was in progress; it may have partly taken effect.`
- 返回仍是 `paused(host)`，但日志里不再有 pending，下一个 run 直接问模型。
- 丢租约、`onDisconnect: "abort"` 等其它中止原因维持现行为。

边界：

- **子代理**：linked 模式下子 run 拿到的是同一个 signal、同一个停止原因，也按停止处理，父那一次调用落上面的 Interrupted 文案。detached 模式下子 run 照常跑完。
- **等审批时用户直接发新消息**：现在会卡住。新消息入日志了，但补跑时这个调用再次挂起审批，模型一直不回话。**不改 core**，AdRate 侧在用户不批而发新消息时，同一个请求里带上 `decisions: [{ toolCallId, approved: false, by, reason: "The user sent a new message instead of approving this call." }]`。验证中模型都按新话重新提出了调用（例子里是"改成 150"），没有一次再提旧值。

---

## AdRate 建议 2：执行被中断的调用不自动重放

### 现状

`pendingToolCalls`（`core/src/loop/state.ts` 14 行）按"有 `tool_call` 没 `tool_result`"判定 pending。以下几种情形走同一条补跑路径，全部重新执行：

- 进程在 `execute` 途中死亡（部署重启、OOM）；
- 已批准的调用在执行中死亡（`approval_decision.approved` 已在日志里，approval 放行）。

### 问题

时间线分不清两类 pending：

- **从未开始执行**：等审批、被停止、批中排在后面的调用；
- **已开始、结果未知**：执行途中进程死亡的调用。

对后者，写请求可能已经发到上游。重放就是重复建对象、重复扣款，库替模型做了"再试一次"的决定。

### 建议形态（供参考）

- 执行前追加一条**模型不可见的运维事件**（如 `core.tool_started`，与 `approval_request` 同属运维类，投影过滤）。时间线由此记下"已开始"这一事实。
- 补跑时，遇到"有 started、没 result"的调用，不执行，落 `tool_result(isError: true)`，文案如 "Execution was interrupted; the outcome is unknown. Verify the current state before retrying."，由模型决定查证还是重发。
- 允许工具声明可以安全重放（如 `replayable: true`，或按 `risk: "low"` 缺省放行），只读工具不必多一轮。缺省取哪一侧由 reins 定。AdRate 的期望：至少写工具（`risk` 为 medium / high 或未声明）缺省不重放。

### 边界

- `tool_started` 要追加日志，会多一次写入；单语句即可，不破坏"单语句不开事务"。
- 与建议 1 的关系：建议 1 处理"从未开始"的那一类（用户停止），建议 2 处理"已开始"的那一类（进程死亡）；两者都不改"等审批 → 批准 → 执行"这条正常路径。

### reins 回复

**采纳，形态基本按建议。**

- 新增模型不可见的 `core.tool_started`，执行前单条 append。
- 补跑时遇到"有 started、没 result"的调用不执行，落 `Execution was interrupted before a result was recorded; the outcome is unknown. Check the current state before retrying.`（isError）。
- `Tool` 新增 `replayable?: boolean`，缺省是 `risk === "low"` 才可重放。没声明 risk 或 medium / high 的一律不重放，正是 AdRate 期望的那一侧，与审批模块的缺省口径一致。MCP 带 `readOnlyHint` 的工具自动算 low。
- **可重放的工具不写 started**，只读工具一次写入都不多。
- 不可重放的工具执行时被中止信号掐断（抛错且已中止），同样落"结果未知"。
- 子代理工具（`asTool`）声明可重放：子会话日志是真源，续跑子 run 不会重复执行子里已经开始的写工具，子里有自己的 started 保护。
- 多实例接管时，旧实例若还在执行，新实例会落"结果未知"，旧实例随后落结果时撞 `seq_conflict`，与现有多实例语义一致。

AdRate 要做的：只读工具标 `risk: "low"`。原本就建议这么标，否则审批模块也会去问人。写工具保持不声明或 medium / high。确实幂等的写工具可以标 `replayable: true`。

---

## AdRate 建议 3：server 提供显式停止请求

### 现状

`onDisconnect` 缺省为 `"continue"`：用户关页后 run 跑完，这是对的。但 server 没有"停止某会话的 run"的对外入口。宿主要做停止按钮，只能：

1. 自建 `runs` 登记表，经 `handler: { runs }` 传入；
2. 在自己的路由里**再实现一遍**会话归属校验；
3. 调 `runs.get(sessionId)?.controller.abort()`。

### 问题

第 2 步的鉴权和 handler 里的 `authorizeSession` 是两份实现，容易漂移；停止的语义（建议 1 的 `"stop"` 原因）也要由宿主自己约定。

### 建议形态（供参考）

handler 支持一种停止请求，形态由 reins 定（如 `POST { sessionId, stop: true }` 或 `DELETE ?sessionId=`）：

- 走同一个 `principal` + `authorizeSession`，`method` 标明是停止；
- 命中本进程的 run 则以建议 1 的"停止"原因中止，返回该 run 的最终帧；
- 没有正在跑的 run 时，按幂等成功处理。

### 边界

`runs.get` 只认本进程。多实例下"停止在别的实例上跑的 run"需要跨进程通知（可借 `reins_runs` 租约表加一个停止标记，由心跳读取）。AdRate 当前单实例，这一层可以后做，但接口形状最好一开始就留出余地。

### reins 回复

**采纳。**

- 请求形状：`POST { sessionId, stop: true }`。`stop` 只能是字面 `true`，且不能和 `input` / `resume` / `decisions` 同时出现，否则 400。
- 鉴权：走同一个 `principal` + `authorizeSession`，`method` 为新值 `"STOP"`（`SessionAuthzInput.method` 扩为 `"GET" | "POST" | "STOP"`）。只按 `method === "POST"` 放行写操作的宿主会拒掉 STOP，这是 fail-closed，要放行就显式加。
- 必须带 `sessionId`，鉴权时 `isNew: false`。
- 本进程有正在跑的 run：以 `RunStop` 中止，**立即**回 `200 { status: "stopping", sessionId }`。不等 run 收尾，免得被正在执行的工具或子代理拖住。最终的 result 帧照常从前端原来那条流推过去，前端只需继续听那条流。
- 没有正在跑的 run、但会话里还有没执行的调用（例如正在等审批）：reins 起一次只收尾、不问模型的 run，把它们按停止落结果，同样回 `stopping`。所以"等审批时点停止"也会把那批调用落成"没执行"。
- 没有正在跑的 run、也没有没执行的调用：回 `200 { status: "idle", sessionId }`，重复按也安全。
- 跨实例停止记为 reins OPT-261105-5，`status` 字段已经为它留了位置。
- 补充（实施时确认）：如果正在跑的 run 先因别的原因被中止（例如丢租约），之后再收到停止也不算数，因为停止原因只认第一次中止。这时 pending 调用会留着，再按一次停止，就会走上面"没有正在跑的 run"那条路完成收尾。

---

## AdRate 建议 4：配置漂移校验收窄到"待执行调用相关"（可选，触及刻意取舍）

### 现状

`computeConfigHash`（`core/src/loop/state.ts` 39 行）覆盖三样：

- 模型；
- **全部工具名（排序）**；
- 系统提示，含 skills 菜单、lazy-tools 菜单等静态贡献。

续跑时任一不同即 409 `config_mismatch`，除非 `allowConfigDrift`。

### 问题

宿主每次发版只要新增一个能力（工具名变化）、改一条 Skill 描述，或上游 MCP 增减一个工具，**所有正在等审批的会话都无法续跑**。

对 AdRate 的影响：

- 能力是持续追加的；
- TikTok MCP 的工具表随 TikTok 发版变动（实测几周内从 377 件变成 381 件）；
- 因此"等审批的会话被部署打断"会是常态。

另一方面，现有摘要只取工具**名**，同名工具的描述或 schema 变了反而不会被发现。

### 建议形态（供参考，请先评估是否与设计取舍冲突）

- 续跑校验改为：模型一致 + **pending 调用涉及的工具定义**（名 + 描述 + inputSchema）与暂停时一致。
- 其余工具有增减、系统提示有变化时放行，并用现有的工具变化说明（`renderToolChangeNote`）告诉模型。
- 这样，审批人批准的那次调用，其工具定义仍有保证（比现在更严：连 schema 也校验）；而与这次审批无关的配置变化不再让会话失效。

### 与设计取舍的关系

reins 现在的理由是"暂停时模型看到的工具集就是它做决定的依据"。收窄后，模型做决定时的**整体**工具集可能变了，只是保证被批准的那几个调用本身没变。是否接受这个权衡，由 reins 侧判断。

**若不采纳**，AdRate 维持：不开 `allowConfigDrift`，前端把 `config_mismatch` 映射成"系统已更新，请重新发起"。

### reins 回复

**采纳收窄。** "暂停时模型看到的工具集就是它做决定的依据"这条理由，在 reins 自 P1 起每次 run 都记 `tools_bound`、工具有增删就主动告诉模型之后，已经站不住了。真正要守的是被批准的那一次调用，执行时还是同一个工具。

- 续跑状态新增两个可选字段：模型摘要、pending 调用所涉工具的 `[名, 描述, inputSchema]` 摘要。状态里有新字段时，只比对这两样；其余工具增删、系统提示（含 skills / lazy-tools 菜单）变化一律放行，由工具变化说明告诉模型。
- 旧状态没有新字段，仍按原来的整体摘要比对，部署时已在等审批的会话不受影响。也就是说，新版发布后**产生的**暂停才享受收窄。
- 被批准的工具本身变了（含 schema），仍是 409 `config_mismatch`，message 会点名是哪个工具。AdRate 前端这一路的提示保留，但它会从"每次发版都触发"变成"改了正在等审批的那个工具才触发"。

另外核实时发现：现在**只带 `decisions`、不带 `resume`** 也能续跑，这时签名与配置校验都不跑。reins 记为 BUG-261105-2，修复方向待定，可能改成带 `decisions` 必须带 `resume`。AdRate 请始终带上一次 result 帧给的 `resume`，不要依赖这个口子绕开 `config_mismatch`。

---

## AdRate 侧依赖关系（供发版后回填）

| 建议 | 发版前 AdRate 方案的状态 | 发版后 AdRate 要做的 |
| --- | --- | --- |
| 1 | 方案中"用户停止后不执行遗留写调用"标为依赖 reins | 停止按钮走建议 3 的停止请求（自动带 `RunStop`），删掉"依赖"标注；用户在等审批时直接发新消息，同一请求带 `decisions` 拒绝 + reason |
| 2 | 方案中"写调用中断不自动重放"标为依赖 reins | 只读工具标 `risk: "low"`；写工具保持缺省（不重放）；确实幂等的写工具可标 `replayable: true` |
| 3 | 方案中停止接口标为依赖 reins | 停止按钮调 `POST { sessionId, stop: true }`（回 `stopping` / `idle`）；`authorizeSession` 对 `method: "STOP"` 显式放行会话主人；结果帧继续从原来的流读 |
| 4 | 若不采纳，AdRate 方案维持"放弃该次暂停、重新发起" | 已采纳收窄：`config_mismatch` 提示保留，但只在正在等审批的那个工具被改时出现；续跑始终带 `resume` |

reins 对应版本（已发布到 npm 官方源）：`@reinsjs/core` 0.10.0、`@reinsjs/server` 0.5.0、`@reinsjs/agent` 0.5.0；`brain` 0.8.3、`lowering-fetch` 0.6.1、`lowering-pi` / `eval` 0.4.5、其余 0.3.7。

仍未处理、与 AdRate 有关的两项：跨实例停止（OPT-261105-5，AdRate 当前单实例，不受影响）；只带 `decisions` 不带 `resume` 的续跑口子（BUG-261105-2，AdRate 续跑请始终带 `resume`）。

---

# 第二批建议（2026-11-05）

> 来自 AdRate 正式接入方案的第二轮独立审查。依据 reins `main@4f441dc`（store-pg 0.3.7）。

## reins 回复（第二批，2026-11-05）

> 建议 5 采纳，**已发版**：`@reinsjs/store-pg` 0.4.0（2026-11-06，npm 官方源；其余包版本不变，依赖 `@reinsjs/core` 0.10.0）。核实时发现的问题比建议里推测的更具体，修的位置也不同：主要修在 store-pg 自己的 SQL，适配器很薄。实施方案：`docs/implementation-plans/2026-11-05-store-pg接postgres.js.md`；踩坑 47、48。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 5 | store-pg 提供 postgres.js 官方适配，并把存储测试也对 postgres.js 跑一遍 | store-pg | 无冲突，是 `PgClient` 最小接口已承诺的兼容性的验证 | 中，AdRate 方案 M1 前置 |

## AdRate 建议 5：postgres.js 官方适配与测试

### 现状

- `PgClient` 只要求 `query(text, params) → { rows }`（`store-pg/src/client.ts`）。注释写明"`pg` 的 Pool / Client、PGlite 都直接满足；postgres.js 之类用标签模板的库包一层即可"。
- 存储测试只对 PGlite 与 `pg` 跑（`pg.test.ts`），postgres.js 没有被测过。
- 写日志用一条语句批量插入：把 JS 数组绑定成 `$2::int[]`、`$3::text[]`、`$4::text[]`、`$5::bigint[]`、`$6::json[]`，再 `unnest` 展开（`event-log.ts` 的 `append`）。其中 `data` 是 `JSON.stringify(e)` 的字符串，按 `json[]` 传入。读回时直接取 `row.data`。blob 是 `bytea`。

### 问题

postgres.js 是主流 Node 驱动，Drizzle 项目多半用它（AdRate 就是）。它与 `pg` 的差异有两层：

1. **调用形状**：原始 SQL 走 `sql.unsafe(text, params)`，返回的是行数组本身，没有 `.rows`。这层包一下就行。
2. **参数与结果的类型转换**：JS 数组如何序列化成 Postgres 数组、字符串放进 `json[]` 会不会被再编码一次、`bigint` 参数与 `int8` 结果怎么转、`bytea` 返回什么、唯一冲突错误的 `code` 字段在哪。两个驱动的处理方式不同。

风险集中在第 2 层，而且后果严重：`data` 的 json 文本只要没能原样往返（被二次编码、键序或数值形态变了），续跑的签名与配置校验就会把它判成篡改，会话再也续不上。这类问题只在真实数据上才暴露。

现在的做法是每个用 postgres.js 的宿主自己包一层、自己踩一遍这些坑。这正是 reins 该统一解决的。

### 建议形态（供参考，形态由 reins 定）

- store-pg 导出一个适配函数，例如 `postgresJsClient(sql)`：
  - 按结构类型接入 postgres.js 实例（只用 `sql.unsafe`），不引入运行时依赖，store-pg 保持零依赖；
  - 内部处理好数组、json、bigint、bytea 参数的类型，以及错误码的取法。
- 现有存储测试矩阵（PGlite / `pg`）加一列 postgres.js，至少覆盖：
  - 批量 append 后逐字节读回 `data` 的 json 文本，含键序、Unicode、大整数、嵌套数组；
  - blob 写读；
  - 唯一冲突映射成 `seq_conflict`；
  - 租约的取得、续期与释放。
- README 的接入示例补一段 postgres.js 写法。

### 边界

- 只做适配与验证，不改 `PgClient` 接口，也不改表结构。
- 事务语义不变：store-pg 依旧是单语句、不依赖事务，适配器可以直接接连接池。

### reins 回复

**采纳。** 实测（本机 PG 15 与 PGlite，postgres.js 3.4.9 / 4.0.0）证实了建议里第 2 层的风险，但后果和推测的不一样：

- **事件确实被二次编码**：`$6::json[]` 让 postgres.js 对已序列化的字符串再编码一次，库里每行 `json_typeof(data)` 都是 `string`。但续跑**不会**被判成篡改：读侧有"拿到字符串再解一层"的兼容，读回逐字一致。坏的是库里的形状，SQL 查 `data->>'type'` 只得到 null。
- **另一个点**：宿主实例开了 `transform: postgres.camel`，结果列名会被改成驼峰，blob meta 的 `sessionId` 丢失。camel 也会改 json 列里的对象键（`tool_name` 变成 `toolName`），但修好后 reins 读的是 `data::text`，事件不受这一条影响。
- 其余都正常：`unsafe` 返回行数组、23505 在 `err.code`、bytea、int8、租约并发、`prepare: false`、Drizzle 包过的同一实例（已有测试列）。

做法：

- **store-pg 的 SQL 改成只按文本过库**：写入绑 `text[]`、在 SQL 里 `::json`，读出取 `data::text` 由 reins 自己解析。驱动的 json 编解码和 transform 都碰不到事件，pg / PGlite 存取内容不变。不改表、不改 `PgClient`，事务语义不变。
- **新导出 `postgresJsClient(sql)`**：结构类型，只用 `sql.unsafe`，store-pg 仍然零运行时依赖。实例带结果 transform（`postgres.camel`、列名映射、自定义 `value` / `row`）时构造期就抛 `invalid_argument`；只设 `transform.column.to` 的放行。传事务 tx 或 `sql.reserve()` 的连接也拒绝：它们带着实例的 transform 却不暴露，适配器查不了。
- **测试**：一致性套件和特有行为现在在 CI 里对真库 PostgreSQL 16.13（Alpine，与 AdRate 生产同版本）跑 pg、postgres.js 3 / 4、`drizzle(sql)` 包过的 postgres.js 3 / 4 共五列，每次推送都跑。新增的检查直接断言库内 `json_typeof = 'object'`、`data::text` 逐字等于 `JSON.stringify`，含键序、中文与 emoji、2^53−1、嵌套数组，append 与 fork 都测；blob 与租约在一致性套件里本来就有。唯一冲突映射成 `seq_conflict` 原先没有用例真正撞到 23505（串行的 PGlite 撞不出），审查后补了两条：驱动把冲突放在 `err.code`；真库上两个写入者并发 append 同一 seq 撞主键后翻成 `seq_conflict`。本机 PG 15 与 16.13-alpine 容器上全绿。
- **postgres.js 3 加 `fetch_types: false`** 时数组参数会被数据库拒绝（事件 append / fork 报 22P02，blob 与记忆写入不受影响），v4 已修。README 有说明，适配器不拦。

AdRate 接入时注意：

- 交给适配器的必须是 `postgres()` 返回的顶层实例，不能是事务或 reserve 出来的连接，也不能带 `transform`。Drizzle 本身不需要它；如果 AdRate 的实例为别的代码开了 camel，就给 reins 单开一个不带 transform 的 `postgres()` 实例。
- M1 开头的真库往返验证，建议直接看库：`SELECT json_typeof(data) FROM reins_events LIMIT 1` 应为 `object`。只比读回一致发现不了这次的问题。

### AdRate 侧依赖

| 发版前 AdRate 方案的状态 | 发版后 AdRate 要做的 |
| --- | --- |
| 方案中"reins 存储接入"标为依赖 reins，排在 M1 开头；M0 三项前置改造不受影响 | 直接把现有 postgres.js 连接交给适配器，不引入 `pg`、不另开连接池；M1 开头在真实库上做一次往返验证 |

发版后核实（2026-11-06）：空目录从 npm 官方源安装 `@reinsjs/store-pg@0.4.0` + postgres.js 4.0.0，对真库冒烟 9/9——库内 `json_typeof = object` 且逐字、读回、fork、并发同 seq 报 `seq_conflict`、blob、租约、记忆、camel 实例被拒。reins CI 每次推送都对 `postgres:16.13-alpine`（与 AdRate 生产同版本）跑 pg、postgres.js 3 / 4、Drizzle 包过的 postgres.js 3 / 4 五列。

---

# 第三批建议（2026-11-06）

> 来自 AdRate 对 reins `pullInput` 发版（core 0.11.0 / server 0.5.1 / agent 0.6.0，npm 官方源）的接入评估。依据各包 CHANGELOG、README 与 `dist` 源码（`@reinsjs/server` 的 `createAgentHandler` / `handlePost`、`@reinsjs/core` 的 `runLoop` 拉取段）。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 6 | HTTP handler 接住 run 进行中到达的用户消息，交给正在跑的 run 拉取 | server | 宪法一：中途来的话要不要改方向，由模型读到后自己决定；不进 `AgentDefinition`，不触及 `pullInput`"每次 run 才传"的取舍 | 中，可选；不是 AdRate 第一期前置 |

## AdRate 建议 6：HTTP handler 接住 run 进行中到达的用户消息

### 现状

- core 0.11 的 `pullInput` 只能经进程内 `runLoop` / `agent.run({ pullInput })` 传。`AgentDefinition` 刻意去掉了它，`createAgentHandler` 也会把它从定义里剥掉（`withoutPerRunFields`），HTTP 起的 run 从不拉取。
- 浏览器宿主的消息都从 HTTP 进来。会话已有 run 在跑时再 `POST { sessionId, input }`，`handlePost` 在 `runs.create` 处撞上 `RunConflictError`，回 409 `run_in_progress`。
- 所以要在 Web 上用 `pullInput`，宿主只能绕开 handler 的 POST，自己起 run，然后把以下几件再实现一遍：
  - 补发与实时流的拼接（`openStream`）、心跳、编码器；
  - 增量推送（`onDelta` → `broadcast`）；
  - `onEvent` 观测；
  - 续跑校验。
  
  这正是建议 3 当时要避免的"两份实现"。宿主自建的信箱还要自己处理跨请求定位 run、进程死亡丢消息、最后一次拉取之后到达的消息。

### 问题

对话式的 Agent 前端，用户在 run 进行中补一句话是很自然的操作，例如"只看 A 账户""预算别超过 100"。目前只有两条路：

- **等 run 结束再发**：模型可能已经在错的方向上多走了几轮，烧了 token，也可能已经发出了需要审批的写调用。
- **先停止再发**：停止语义是对的（遗留调用落"没执行"），但它是粗粒度的。正在排队的只读查询也一起作废，模型要重新规划。用户的本意只是"补充一句"，不是"推翻重来"。

`pullInput` 已经在循环里解决了"什么时候交给模型"这件难事：每次调模型前拉、有 pending 调用不拉、中止后不写。缺的只是 HTTP 这一侧"消息怎么送到正在跑的 run"。每个 Web 宿主各自补这一段，就会各自踩一遍上面那些坑。

### 建议形态（供参考，形态由 reins 定）

- **每个 run 一个信箱，挂在 `ActiveRun` 上**。handler 为普通 POST（新话 / 续跑）起的 run 传入 `pullInput`，只从这个 run 自己的信箱取：
  - 不进 `AgentDefinition`，和 `pullInput`"每次 run 才传"的取舍一致；
  - 停止收尾的 run 与 `asTool` 子 run 没有信箱，自然不拉，正好避开 server 注释里列出的那个问题。
- **投递**：会话的 run 正在本进程跑时，`POST { sessionId, input }` 不再回 409，而是：
  - 入信箱，立即回 `202 { status: "queued", sessionId, deliveryId }`（JSON，不开新流，同停止请求）；
  - 被拉取后，这条 `core.user_message` 照常从原来的流和 GET 观看者那里推出；
  - 草稿带 `provenance.ref = deliveryId`，客户端凭它把"发送中"的消息对上时间线里的事件。
- **鉴权与校验**：
  - 走同一个 `principal` + `authorizeSession`。`method` 沿用 `"POST"`，还是像 STOP 那样单列新值（如 `"INPUT"`，宿主要显式放行），由 reins 定；AdRate 两种都能接；
  - 只收用户消息（字符串、ContentPart 数组、`core.user_message` 草稿）；
  - 带 `resume` / `decisions` / `tool_result` 的请求打在忙碌的会话上，仍回 409。
- **没被拉走的消息必须让客户端知道**。以下几种情况，消息都可能没进这个 run：
  - run 结束前最后一次拉取之后才到；
  - run 以 `paused`（审批 / 预算 / 停止）或 `error` 结束；
  - 拉取后发现已中止，按 core 语义不写。

  建议在 result 帧里带上未投递的 `deliveryId` 列表，客户端把这些消息放回输入框或自动重发。不建议由 handler 自动起下一个 run：
  - run 停在等审批时，按建议 1 回复的宿主职责，这条新话要和 `decisions` 拒绝一起发，只有宿主知道怎么拼；
  - 自动续起的 run 没有发起请求，归属与观测都不清楚。
- **跨实例**：会话的 run 在别的实例上跑时，照常 409 `run_in_progress`。这与跨实例停止（OPT-261105-5）是同一类问题，可以一起排。

### 边界

- **不挡正在执行的工具**：消息要等当前工具批跑完、下一次调模型前才进时间线。这符合 core 现有语义，也是 AdRate 想要的：写调用不会因为用户插话被打断在半路。
- **信箱在内存里**，进程死亡时未投递的消息会丢失。客户端以"时间线里出现了带 `deliveryId` 的那条消息"为送达判据。连接断开或流结束都没等到这条消息，就当作未投递、放回输入框，用户最多重发一次，不会静默丢失。这就够了，不需要持久化信箱。
- **预算**：吸收了中途消息的 run 会更长，每 run 的轮数与 token 上限会更早触顶。是否要让新到的用户消息重置或延长 run 预算，由 reins 判断。AdRate 这边会照实调预算，不要求库改。
- **不影响不用它的宿主**：没有并发 POST 的宿主行为不变。担心"409 变 202"影响现有宿主的话，可以用 handler 选项开启（如 `handler: { midRunInput: true }`），缺省保持 409。

### AdRate 侧依赖

| 发版前 AdRate 方案的状态 | 发版后 AdRate 要做的 |
| --- | --- |
| 第一期前端在 run 进行中不允许发送，提示"可先停止再发"；路由继续整个交给 handler，不绕开它自建 run 驱动 | 前端 run 进行中照常可发：消息显示"发送中"，以带 `deliveryId` 的 `core.user_message` 出现在流里为送达；result 帧里未投递的放回输入框（停在等审批时，按建议 1 的口径连同 `decisions` 拒绝一起重发）；`authorizeSession` 按 reins 定下的 `method` 放行会话主人，模拟登录照旧只读；每 run 预算视实测上调 |
