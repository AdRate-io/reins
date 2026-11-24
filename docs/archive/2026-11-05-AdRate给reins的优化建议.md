# AdRate 对 reins 的优化建议（2026-11-05）

> **来源**：AdRate（投放工具，reins 的 dogfood 宿主）在正式接入前，对照 reins `main@11c160f`（core 0.9.0 / server 0.4.3 / brain 0.8.2）核实出的问题。由 Boss 带到 reins 项目评估、实施、发版；AdRate 侧不写兜底代码，等发版后再调整接入方案。
> **编号**：「AdRate 建议 N」，各批顺序编号（第一批 1～4、第二批 5、第三批 6～7、第四批 8），与 reins 文档中的「OnSet 建议 N」同一用法。
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
| 6 | HTTP handler 接住 run 进行中到达的用户消息，交给正在跑的 run 拉取 | server | 宪法一：中途来的话要不要改方向，由模型读到后自己决定；不进 `AgentDefinition`，不触及 `pullInput`"每次 run 才传"的取舍 | 中；Boss 2026-11-06 定第一期就接（已发版，见处置） |
| 7 | 信箱跟着共享的 `runs` 走，按请求组装 handler 的宿主也能投递（建议 6 发版后核实时追加） | server | 无冲突，与停止请求跨 handler 生效同一条路 | 高，AdRate 第一期"运行中插话"依赖它 |

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

### reins 处置（2026-11-06）

已做，server minor + ui-agui minor（方案 `docs/implementation-plans/2026-11-06-HTTP进行中投递.md`）。按建议保留：每 run 一个内存信箱、`handler: { midRunInput: true }` 开启（缺省 409）、202 JSON 不开流、只收用户消息、`resume` / `decisions` / `tool_result` 仍走原路径（409 或原有校验错误）、跨实例仍 409、不持久化、不自动起下一个 run、不改预算、草稿 `provenance.ref = deliveryId`。改了三处：① 取出不删，写进时间线才删；② **result 帧不带未投递列表**，送达判据只有"时间线里出现带该 `deliveryId` 的 `core.user_message`"，流结束仍没见到即未送达；③ 鉴权沿用 `method: "POST"`，不新增方法。补了两处：投递者必须与 run 的发起人同一 `principal?.id`（否则 409）；`@reinsjs/ui-agui` 在 user_message 的 `TEXT_MESSAGE_START.metadata.reins.provenance` 带出 deliveryId。`deliveryId` 可由客户端给（同 run 内幂等）、普通 POST 起 run 时也带；未写入满 16 条回 429 `mailbox_full`。客户端四种应答（202 / SSE 200 / 409 / 429）见 server README "Messages during a run"。

### AdRate 发版后核实（2026-11-06）

从 npm 官方源取 `@reinsjs/agent` 0.6.1（精确依赖 server 0.6.0 / ui-agui 0.4.0 / core 0.11.0），对照 `dist` 源码与 server README "Messages during a run" 核实：

- 处置所述行为与源码一致：
  - `handlePost` 在 `authorizeSession`（`method: "POST"`）之后才判投递；
  - 投递条件：带 `sessionId`、不带 `resume` / `decisions`、用户消息形态；
  - `Mailbox` 取出不删、写进时间线才删，且记下发起人 `principal?.id`；
  - 满 16 条回 429；run 结束时 `close()` 丢弃。
- 三处改动 AdRate 都接受：
  - 送达只看时间线，比 result 帧带列表更简单，前端只需一种判据；
  - 沿用 `"POST"` 正合 AdRate 的鉴权口径（模拟登录只放行 GET，投递自然被拒）；
  - 同发起人校验 AdRate 本就需要：run 以发起人的身份执行。
- **发现一处 AdRate 用不上的地方，见下面建议 7**：信箱登记在 `createAgentHandler` 闭包里的 `mailboxes`（`WeakMap<ActiveRun, Mailbox>`），每个 handler 实例各有一份。

## AdRate 建议 7：信箱跟着共享的 `runs` 走，而不是跟着 handler 实例走

### 现状

- `runs` 可以由多个 handler 共用。`HandlerOptions.runs` 的注释写明"多个 handler 共用同一个进程时可传同一个实例"。停止请求就是这样跨 handler 生效的：`runs.get(sessionId)` 拿到 `ActiveRun`，再 `controller.abort(...)`。
- 信箱不同：`openMailbox` / `deliver` 用的是本 handler 闭包里的 `mailboxes`。投递请求如果落到另一个 handler 实例上，会出现以下情况：
  - `runs.get` 能拿到 run，但 `mailboxes.get(active)` 是 `undefined`，`deliver` 返回 `undefined`；
  - 请求于是落回普通路径，`runs.create` 撞上 `RunConflictError`，回 409 `run_in_progress`；
  - 不报错、不告警，宿主看到的只是"投递永远 409"。

### 问题

AdRate 必须每个请求组装一次 agent，所以每个请求都是新的 handler：

- 会话的 TikTok MCP 工具来自"按会话身份取的 MCP socket"（按凭据缓存）。不同会话的 socket 不同，`definition` 无法做成进程级常量。
- 同一 socket 内也无法按会话切 token：`tools-mcp` 的 `auth.token()` 不带调用上下文，拿不到当前会话。
- 停止请求与 409 判定靠共享的 `runs` 已经能跨 handler 工作，AdRate 方案一直是这样设计的。

结果是：开了 `midRunInput: true`，AdRate 的投递在任何情况下都回 409，功能等于没开。按会话装配工具的宿主（多租户、每会话不同凭据）都会遇到同样的问题。

### 建议形态（供参考，形态由 reins 定）

- 信箱随 `ActiveRun` 走，例如挂成 `ActiveRun` 上的字段，或由 `runs` 登记表持有 `ActiveRun → Mailbox` 映射。凡是共用同一个 `runs` 的 handler 都能投递，与停止请求同一条路。
- 保持现有约束：
  - 只有开了 `midRunInput` 的 handler 起的 run 才有信箱；
  - 收到投递的 handler 自己也要开 `midRunInput`，否则走原来的 409；
  - 发起人校验、16 条上限、不持久化都不变。
- 补一条测试：两个 handler 实例共用一个 `runs`，A 起 run、B 收投递，回 202，消息写进时间线。

### 边界

- 不涉及跨实例（`leasedRunRegistry` 的 `get` 只认本进程，跨实例照旧 409）。
- 若 reins 更倾向"宿主应当只用一个 handler"，那就需要 `createAgentHandler` 支持按请求解析工具 / socket（例如定义里允许一个按 `sessionId` + `principal` 返回工具表的回调）。这个改动面更大，AdRate 倾向上面的做法。

### AdRate 侧依赖

| 发版前 | 发版后 |
| --- | --- |
| AdRate 照常接 `midRunInput: true` 与前端投递逻辑。投递回 409 时，前端把消息放回输入框，提示"Agent 正在处理，稍后再发"，体验退化为"运行中不能发送"，不出错。M1-3 的"运行中插话"验收项等这一条 | 升级后路由不改代码，"运行中插话"验收项转为可测；补一条"两个 handler 共用 runs 时投递回 202"的回归测试 |

### reins 处置（2026-11-06）

接受建议，按"信箱随共用的 `runs` 走"做，server patch。信箱表从 `createAgentHandler` 闭包挪到 handler 模块级（`WeakMap<ActiveRun, Mailbox>`），没有挂成 `ActiveRun` 的字段，公开形状不变。凡是共用同一个 `runs` 的 handler 都能找到这个 run 的信箱，可达范围与停止请求一样。约束保持不变：起 run 的 handler 与收投递的 handler 都要开 `midRunInput`，任一方没开都回 409；发起人校验、16 条上限、不持久化、跨实例 409 都照旧。原方案里"两个 handler 共用 `runs`、打到另一个 handler 起的 run → 409"的用例改成三格：

- 每个请求新建 handler、共用 `runs` 时回 202，消息写进发起 run 的时间线，第 2 次模型请求能看到，同 `deliveryId` 跨 handler 幂等；
- 起 run 的 handler 没开 `midRunInput` 时回 409；
- 收投递的 handler 没开 `midRunInput` 时回 409。

新用例在旧实现上失败、新实现上通过。不选"handler 按请求解析工具"的另一条路：改动面大，而且共用 `runs` 本来就是公开的多 handler 用法。AdRate 升级后路由不用改代码，前提是各请求的 handler 传的是进程级同一个 `runs`（`createAgent` 每次调用会自建一份，按请求调用必须显式传 `handler: { runs }`，README 已写明）。另在 README 写明共用 `runs` 的 handler 是同一个信任域：投递由收件 handler 鉴权，却以起 run 的 handler 的工具与 log 执行。

### AdRate 发版后核实（2026-11-06）

npm 官方源 `@reinsjs/agent` 0.6.2（精确依赖 server 0.6.1 / ui-agui 0.4.1 / core 0.11.0）：

- `dist` 中 `mailboxes` 已移到模块级 `WeakMap<ActiveRun, Mailbox>`，`openMailbox` / `deliver` 都经它查，CHANGELOG 与 README 已写明"按请求新建 handler 须共用同一个 `runs`"。
- **答复 reins 的确认项**：AdRate 各请求的 handler 传入的是进程级同一个 `runs`。接入方案 3.7 从定稿起就要求 `leasedRunRegistry(store.runLease)` 只建一次、挂 `globalThis`，经 `handler: { runs }` 传入；停止请求与 409 判定原本就靠它。已核 agent 0.6.2 的 `createAgent`：handler 选项按 `{ encode, ...自建 runs, ...handlerOptions }` 合并，显式传入的 `runs` 会覆盖每次自建的那份。这一条在 M1-2 实施（尚未写代码），路由单测会覆盖"两个按请求新建的 handler 共用 `runs`，投递回 202"，防止日后漏传。
- 信任域前提满足：各请求共用同一个 log（`getAgentStores()` 进程级单例）、同一套 principal id（`u:<userId>`）、同一个 `authorizeSession` 与入场检查。
- 已回填：接入方案（3.5～3.11、第六、八～十一节，第十节新增 10.10"第一期支持运行中插话"）与接入简报（版本表、2.1、2.5、3.8）。

---

# 第四批建议（2026-11-06）

> 来自 AdRate 对运行中插话方案的独立审查，核实时发现的既有缺口，与插话无关，但插话的"停在审批时连同拒绝一起重发"也要用到它。依据 npm 官方源 core 0.11.0 / server 0.6.1 / ui-agui 0.4.1 的 `dist` 源码。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 8 | 等审批的会话在补发时也能拿到可续跑的 `resume` | core / server（+ ui-agui） | 宪法二：续跑凭据目前只活在一条连接里，不在时间线上 | 高，AdRate 第一期确认卡依赖它 |

## AdRate 建议 8：补发时也给出可续跑的暂停状态

### 现状

- 签名的暂停状态（`SerializedRunState`）只在 `runLoop` 暂停时算一次，放进 `RunResult.state`，经 live 流的 `result` 帧发给**当时挂在流上的**客户端。
- 时间线里的 `core.run_paused` 只有 `{ reason }`。GET（或带 `lastSeq` 的 POST）补发以 `end` 帧结束，只带 `sessionId` / `lastSeq`。ui-agui 把它编码成 `RUN_FINISHED`，`result: { status: "replayed" }`，没有 `state`。
- 续跑审批（`resume` + `decisions`）要求带这份状态。不带 `resume` 只带 `decisions` 的口子是 BUG-261105-2，AdRate 按约定不依赖它。

### 问题

"关页后 run 在服务端继续，回来接着看"是 reins 的缺省形态（`onDisconnect: "continue"`），而等审批恰恰是最常见的"用户走开了"的时刻。以下几种情况都会碰到：

- run 停在审批时，用户已经关了页；
- 刷新页面；
- 第二个窗口打开同一会话；
- 换一台设备打开。

客户端都能从补发里看到 `approval_request`，画出确认卡，却拿不到 `resume`。结果是：

- 无法批准或拒绝；
- 也无法按建议 1 回复的口径"不批而发新消息"（同样要带 `resume` + `decisions`）；
- 唯一能走的是停止请求：把待审批调用落成"没执行"，再让用户重说一遍。正确，但对"回来点批准"这个最常见的动作太绕。

宿主自己补救只有两条路，都不对：

- 把 `state` 存进浏览器：换设备、换浏览器无效，还要处理过期；
- 截流自存一份：要在 handler 外面解析 SSE，等于又写一份传输层。

### 建议形态（供参考，形态由 reins 定）

- **暂停当时就把状态落进时间线**：例如 `core.run_paused` 的 payload 带上签名后的 `state`，或带上算它所需的摘要。模型不可见，投影本就过滤这类运维事件。
- **补发结束时给出它**：会话末尾是"暂停且仍有 pending"时，`end` 帧带上这份 `state`，ui-agui 的 `RUN_FINISHED`（`replayed`）一并带出。末尾之后已有别的事件（例如已经续跑、已停止收尾）就不给。
- **注意不要在 GET 时现场重算**：`configHash` / `modelDigest` / `pendingToolsDigest` 若按补发时的配置算，暂停后改过的工具也会被签成"一致"，配置漂移校验就失效了。状态必须反映暂停那一刻。
- 多个窗口拿到同一份 `state` 各自续跑：AdRate 推断现有的租约与续跑校验（`pendingDigest` 比对、`unknown_tool_call`）会让后到者回 409，这一点未逐行核实，请 reins 确认。

### 边界

- 不改 `SerializedRunState` 形状，也不改续跑校验，只是让它多一个获取途径。
- 子代理暂停（`Interruption(kind=subagent)`）同理：父会话末尾的暂停状态就够续跑，子会话的决定照旧经 `decisions` 下传。

### AdRate 侧依赖

| 发版前 | 发版后 |
| --- | --- |
| 关页、刷新、换设备后回到等审批的会话：确认卡只读，提示"请回到发起的页面处理，或点停止后重新说" | 确认卡与"不批而发新消息"统一从补发结束帧取 `resume`；亲历流与补发两条路径同一份逻辑 |

### reins 处置（2026-11-06）

接受，按建议形态的第一种做，core / server / ui-agui 各发一个 minor。方案见 `docs/implementation-plans/2026-11-06-补发带续跑状态.md`。

- **状态落进时间线**：暂停时先签状态，再写 `core.run_paused { reason, state }`。`RunResult.state` 与这条事件里的是同一个对象，`state.lastSeq` 就是这条 `run_paused` 自己的 seq。只存签好的成品，不存摘要、补发时再签：这样只有一份来源。
- **补发结束时给出**：补发读完后再取一次日志末尾。末尾 seq 等于本次 `end.lastSeq`，且是带状态的 `run_paused`，才在 `end` 帧带 `state`。缺省 AG-UI 编码下是 `RUN_FINISHED.result.state`，与 `status: "replayed"` 并列，`outcome` 仍是 `success`：补发只有日志，拼不出 live result 的 `interruptions`，确认卡从补发里的 `approval_request` 画。客户端 `lastSeq` 已在末尾、一条不用补发时也给。给的是**最近一次暂停**的状态，不论原因：续跑之后、再次暂停之前不给；用户停止、预算暂停、中止各自又落一条带状态的 `run_paused`，其中停止后 `pendingToolCallIds` 为空。所以"有 state"不等于"要审批"，确认卡只对 `pendingToolCallIds` 里、补发中有 `core.approval_request` 的调用画。
- **不在 GET 时重算**：采纳。状态是暂停那一刻签的，暂停后改了 pending 调用涉及的工具，续跑照样 409 `config_mismatch`。
- **多窗口确认**：推断成立，已有用例锁住。一个窗口在续跑时，另一个回 409 `run_in_progress`（跨实例靠租约）。前一个跑完后，另一个回 409 `pending_mismatch`。若前一个只续跑、没给结论，又停在同一批调用上，旧状态仍有效，批的还是那一批。极窄的竞态（预校验通过后前一个才跑完）会以 200 + `error` 帧收口。各种情况下工具都不会重复执行。
- **子代理**：续跑用父会话末尾的状态就够，子的结论照旧经 `decisions[].sessionId` 下传。但子的 `approval_request` 在子会话日志里，父会话的补发里没有。缺省 `childSessionId`（`父会话:调用id`）可以推出子会话，再去 GET 它；自定义了 `childSessionId` 就推不出来，确认卡画不出。**请确认 AdRate 第一期是否用 `asTool`**，用的话我们再议。
- **安全**：能 GET 挂到进行中 run 的主事人，今天本来就会收到带状态的 `result` 帧。这次只是把可得时间延长到暂停之后，范围仍由 `authorizeSession` 定。
- **BUG-261105-2**：本次不修。状态能从补发取到之后，"带 `decisions` 必须带 `resume`"已经可行，会另行通知 AdRate / OnSet 后收紧。AdRate 已按约定总带 `resume`，不受影响。
- **升级前已暂停的会话**：`run_paused` 里没有状态，补发不给。AdRate 尚未上线，没有影响。

### AdRate 发版后核实（2026-11-06）

npm 官方源 `@reinsjs/agent` 0.6.4（精确依赖 core 0.12.0 / server 0.7.1 / ui-agui 0.5.1），AdRate 整体升级后本机真模型（DeepSeek `deepseek-flash`）实测：

- 起 run 停在审批后丢掉亲历流的状态，GET 补发的 `RUN_FINISHED.result` 为 `replayed`，`state` 与亲历流的逐字相同，`pendingToolCallIds` 与补发里的 `core.approval_request` 对得上；
- 用补发拿到的 `state` 续跑（拒绝），200 正常收尾；
- 同一份旧 `state` 再续跑一次，回 409 `pending_mismatch`，工具没有重复执行；
- 续跑跑完后再补发，结束帧不再带 `state`。

处置的其他几条 AdRate 都接受：确认卡按 `pendingToolCallIds` + `approval_request` 画，不以"有 state"判断；`pending_mismatch` 前端不重试、补发刷新。**子代理**：AdRate 第一期不用 `asTool`，子会话确认卡的问题暂不涉及，用到时再议。方案 3.5 / 3.10 / 第八节与接入简报 3.6 已回填。

---

> 来自 AdRate M1-2 本机真模型验收（DeepSeek `deepseek-flash`，2026-11-06）。依据 npm 官方源 ui-agui 0.4.1 的 `dist/index.js`（`createAguiEncoder`）与实际抓到的 SSE 帧。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 9 | 同一轮 thinking + 正文都流式时，AG-UI 流不再整段重发 | ui-agui | 宪法二：live 流与时间线（补发）对同一轮给出不同的消息集合 | 中，M1-3 前端上线前需要 |

## AdRate 建议 9：同一轮先流思考、再流正文时，AG-UI 流把两段各发两遍

### 现状

`createAguiEncoder` 只留一个 `open` 槽，用来把「正在流式输出的那一块」和随后提交的事件对上：

- 增量到来：kind / index 与 `open` 相同就续写；不同就先 `closeOpen()`（发**不带** `metadata.reins` 的 `_END`），再用新的 `messageId` 开一块。
- 事件提交：只有 `open` 恰好是同 kind 的那一块，才发带 `metadata.reins` 的 `_END` 收口；否则先 `closeOpen()`，再经 `mapEvent` 用事件 id 把整段内容**重新完整发一遍**。

一轮里 thinking 和正文都流式时，增量顺序是 thinking → 正文，提交顺序是 `core.model_thinking` → `core.model_text`：

1. 正文增量一到，thinking 块被无元数据关闭（临时 id A）；正文开在临时 id B。
2. 提交 `model_thinking`：`open` 是正文、kind 不同 → 无元数据关闭 B，再按事件 id 整段重发 thinking。
3. 提交 `model_text`：`open` 已空 → 按事件 id 整段重发正文。

实测帧序（拒绝审批后的续跑轮，节选）：

```
REASONING_START            01a1afd0-a14d…   （临时 id，无 metadata）
REASONING_MESSAGE_CONTENT  "The…"           （增量）
REASONING_END              01a1afd0-a14d…   （无 metadata）
TEXT_MESSAGE_START         01a1afd0-a38b…   （临时 id，无 metadata）
TEXT_MESSAGE_CONTENT       "我…"            （增量）
TEXT_MESSAGE_END           01a1afd0-a38b…   （无 metadata）
REASONING_START            01a1afd0-a6b1…   metadata.reins.seq=13 core.model_thinking   ← 整段重发
TEXT_MESSAGE_START         01a1afd0-a6b4…   metadata.reins.seq=14 core.model_text       ← 整段重发
```

时间线里只有一条 `model_thinking`、一条 `model_text`，日志正确，重复只在 live 流上。没有 thinking 的轮次不受影响：正文增量的 `_END` 直接带上 `metadata.reins`，是一条消息。

### 问题

- 按 AG-UI 协议原样渲染的客户端（CopilotKit、ui-agui 自带 demo）会把这一轮的思考和回答各显示两遍；刷新后走补发，又只剩一遍，同一会话前后不一致。
- 客户端想自己去重，只能靠「无 metadata 的块之后紧跟同 kind、内容相同的有 metadata 块」这类启发式猜测，这正是编码层该给出的确定信息。
- 推理模型在审批被拒、工具报错后几乎每轮都会思考，触发并不罕见。

### 建议形态（供参考，形态由 reins 定）

- **按 kind / index 对账，而不是只对「当前打开的那一块」**：例如每个 kind 记住本轮最近一个已关闭、尚未被提交事件认领的流式块；`model_thinking` / `model_text` 提交时先认领同 kind 的块，发带 `metadata.reins` 的收口帧，不再整段重发。
- 或者在增量阶段就**用将要提交的事件 id 作为 `messageId`**（如果 core 能在流式开始时预分配），提交时只补一个带 metadata 的 `_END`。
- 无论哪种，请在 ui-agui 测试里补一个「同一轮 thinking + text 都流式」的用例，断言每段只出现一组 `_START` / `_CONTENT…` / `_END`，且最后的 `_END` 带 `metadata.reins`。

### 边界

- 不改时间线与 `mapEvent` 的逐事件映射，只改流式编码器的对账方式。
- 一轮里有多段正文（index 不同）时，同样适用：每段各自认领各自的提交事件。

### AdRate 侧依赖

| 发版前 | 发版后 |
| --- | --- |
| M1-3 前端不写去重启发式；本地与测试服验收时，带思考的轮次会看到重复，记为已知问题 | 升级 ui-agui，渲染只按 AG-UI 帧原样累加 |

### reins 处置（2026-11-06）

接受，按建议形态的第一种（编码器对账）做。主修在 ui-agui，server 补一处配套，各发一个 patch。时间线与 `mapEvent` 不动。

- **范围比反馈的大**：不只 DeepSeek。四条降级层（fetch 的 Chat / Anthropic / Responses 与 pi 版）都在整次响应流完后才交出草稿，所以只要一轮先思考、再说话，哪家模型都会重复。
- **修法**：编码器的单个 `open` 槽改成按 `kind:index` 的待认领表，换块时不再收尾前一块，思考块和正文块可以同时打开。完整的 `model_thinking` / `model_text` 到达时，认领**内容对得上**的最早同 kind 块，只补带 `metadata.reins` 的 `_END`，不再整段重发。"对得上"指增量拼出的正文与完整正文去掉首尾空白后相等。一轮里有多段（index 不同）时，各段按内容各自认领。对不上的情况就整段照发，宁可重复，也不丢内容、不挂错元数据：
  - redacted 思考：正文是占位串 `[Reasoning redacted]`；
  - 加密思考：正文为空；
  - 上游没给草稿的块。

  工具调用不打断待认领的块。只有非模型输出的事件和 run 结束时，才把剩下没人认领的块无主收尾。
- **server 配套**：GET 中途挂上进行中的 run 时，原来会转发挂上之后的增量。挂上那一刻正在流的块，客户端只拿到后半截。现在挂上的流先丢增量，等到第一个事件信号再放行。那个块的完整内容会随它的完整事件到达，下一次响应照常流式。代价是挂上那次响应没有流式效果。发起 run 的 POST 流不受影响。
- **协议合法性**：照 @ag-ui/client 1.0.3 的 `verifyEvents` 核过：不同 id 的文本、思考消息允许同时进行，只要求 `RUN_FINISHED` 前全部收尾。测试里的 `assertValidAgui` 已按这套规则逐帧核对帧序。
- **验证**：ui-agui 新增五个用例，覆盖以下场景：
  - 真实降级层节奏：思考与正文都流完才依次提交；
  - 同 kind 多段；
  - redacted 思考在前，后面有流过的思考，另有上游没给草稿的块；
  - 只流到后半截的块；
  - 未认领的块收尾。

  每段只有一组 `_START` / `_CONTENT…` / `_END`，认领的 `_END` 带 `metadata.reins`，SSE `id` 挂在收尾帧上。server 新增一个"块中间挂上"的用例。原实现上这些用例全部失败。初版"按顺序认领"的实现，在 redacted 与后半截两格上也失败（独立审查发现）。另用真 lowering-fetch Chat 线做了一次端到端（假 fetch 回放 DeepSeek 风格的 SSE）：思考一块、正文一块，收尾帧分别带 `core.model_thinking` / `core.model_text` 的 seq。
- **AdRate 升级后**：渲染按 AG-UI 帧原样累加即可。帧序会变成 `REASONING_START…CONTENT` → `TEXT_MESSAGE_START…CONTENT` → `REASONING_END` → `TEXT_MESSAGE_END`，也就是正文开始时思考还没收尾。前端如果用"收到 `_END` 才算思考结束"来折叠思考区，这段时间会显示两块都在进行中，属于预期行为。redacted 思考仍会以一条完整的思考消息出现，正文是占位串。
- **README 顺带改正**：原文"每个事件都带 `metadata.reins`"不准确，增量开出的 `_START` / `_CONTENT` 帧本来就不带，只有收尾帧带。现已写明。

### AdRate 发版后核实（2026-11-06）

同一次升级后本机真模型实测：拒绝审批后的续跑轮带思考，流里思考、正文各只有一组 `_START` / `_CONTENT…` / `_END`，两段收尾帧分别带 `core.model_thinking` / `core.model_text` 的 `metadata.reins`，按 messageId 拼出的各段正文无重复。AdRate 前端按帧原样累加，不写去重；思考区折叠以正文 `TEXT_MESSAGE_START` 为准（方案 3.10、简报 3.7 已回填）。

## AdRate 建议 10：「结果未知」的工具结果带上这次调用开始执行的时间

### 现状

core 0.12 给被中断的不可重放调用补的结果是固定文案 `OUTCOME_UNKNOWN_TEXT`（"Execution was interrupted before a result was recorded; the outcome is unknown. Check the current state before retrying."），不带任何时间。模型看不到事件的 `at`，也就不知道这次调用是什么时候发出的。

### 问题

「先查再动」要求模型在查回来的业务对象里认出「是不是这次提交」。AdRate 本机真模型（M3-3a 剧本 6e'，2026-11-08）：复制提交在 `tool_started` 之后、建任务之前被打断（任务未建成），模型调 `adrate_list_tasks` 后，两次都把列表里**更早一次参数完全相同**的任务认成了这次提交，汇报「那次提交其实已经执行了」。参数相同的情况下，唯一能区分的就是创建时间，而模型拿不到这次调用的时间锚点。方向是安全的（没有重提），但汇报事实错误。

### 建议形态（供参考，形态由 reins 定）

- `OUTCOME_UNKNOWN_TEXT` 拼上该调用 `core.tool_started`（没有则 `core.tool_call`）的 `at`，用 UTC ISO 串，例如 "…the outcome is unknown. The call started at 2026-11-08T16:08:02Z. Check the current state before retrying."；
- 同理可用于 `INTERRUPTED_IN_PROGRESS_TEXT` / `STOPPED_IN_PROGRESS_TEXT`。

### 边界

只改给模型看的文案，不改事件结构；时间取自日志里已有的事件，不新增状态。

### AdRate 侧依赖

无代码依赖。AdRate 的 `campaign-copy` Skill 已改成「参数都对得上也只说"看起来是那次提交"、无论如何不自己重提」；上游带上时间后，Skill 可以改回按创建时间判定。

### reins 处置（2026-11-09）

采纳。core `outcomeUnknownText` 给"结果未知"句末缀开始时间：

```
Execution was interrupted before a result was recorded; the outcome is unknown. Check the current state before retrying. This call started at 2026-11-08T16:08:02.123Z.
```

- **时间**：取该调用 `core.tool_started` 的 `at`，`toISOString()` 原样输出（UTC、带 `Z`、毫秒），与 AdRate 任务时间同一格式，可直接比较。
- **范围**："结果未知"的三处落点（停止收尾、续跑见 started、感知 signal 的写工具被掐断），TanStack 适配器两处同样带。条件是工具已知且不可重放，这时 started 写在执行之前，`at` 才是真实的开始时间。**两句"做了一半"不缀**（与建议不同）：它们只落给子代理，而子代理的 started 是子 run 暂停之后才补写的，`at` 是暂停时刻，比子 run 里建出的对象还晚。把它说成开始时间，会让模型把这次建出的对象当成旧的、再做一遍（独立审查发现，踩坑 50）。工具已不在表里时同样判不出 started 是何时写的，也不缀。两句"没执行"不缀，因为调用没开始，就没有开始时间。
- **与建议形态的两点差异**：① 时间句缀在句末，而不是放在 "Check…" 之前，这样常量仍是实际文案的逐字前缀，宿主判断改用 `startsWith`，规则只有一条。② 不取 `core.tool_call` 的 `at` 兜底：落这几句的路径前提都是已有 started，取不到说明前提不成立，宁可不给也不给一个错的锚点。
- **真模型核实**（`spikes/outcome-unknown-time`，复原剧本 6e'：复制写调用开始后进程死亡，`list_tasks` 回一条 37 分钟前的同参数任务）：

  | 情形 | 带时间 | 改前文案 |
  | --- | --- | --- |
  | 这次没建成（正确答案"没有"） | DeepSeek 5/5、Opus 5.5 5/5 | 两族都 0/5，全部认成旧任务 |
  | 这次建成（另有开始后 1.4 秒的同参数任务） | 两族 5/5 | 两族 5/5 |

  两族都没有擅自重提；让模型逐字复述工具结果，时间句原样到达。同日停止 / 中断旧探针 DeepSeek 40/40，旧行为不受影响。Claude 走的是号池中转，官方 CF 网关余额待充值，充值后可补测。
- **AdRate 升级后**：前端或测试如果拿 `=== OUTCOME_UNKNOWN_TEXT` 判断，要改成 `startsWith`。`campaign-copy` Skill 可以改回按创建时间判定。探针里模型的自然说法已经是"开始时间之前创建的是旧任务"，不需要额外教。

### AdRate 发版后核实（2026-11-09）

升级到 core 0.13.0（agent 0.6.5 / brain 0.8.6 / tools-mcp 0.3.10 等，单一 core）。npm 官方源发布包对比：core 只改「结果未知」三处落点与新导出，其余包 `dist` 逐字未变；AdRate 无 `=== OUTCOME_UNKNOWN_TEXT`，无代码改动。eval 复原剧本 6e'（DeepSeek）：5/5 据时间判定「列表里的同参数任务早于本次开始、这次没建成」，改前同一夹具全部认成旧任务。`campaign-copy` Skill §7 已改回按时间判定；确认没建成且用户已要求继续时允许按原参数重提一次（AdRate 产品取舍）。

## AdRate 建议 11：`RunLease` 提供只读的「是否持有中」查询

### 现状

`RunLease` 只有 `acquire` / `renew` / `release`（store-pg 0.4.3 `PgRunLease` 同此，2026-11-09 按 npm 官方源核对）。宿主想知道「这个会话现在有没有 run 在跑」，没有不占锁的办法：拿 `acquire` 探测，探测成功就真把锁占了，还得立刻 `release`，期间正好有 run 要起步就会被挡掉一次。

### 问题

AdRate 的会话删除要求「运行中拒绝，提示先停止」（删除与 run 收尾抢跑会留下半截计费与审计）。现在只能宿主直接读 `reins_runs`，按 store-pg 的抢占条件自己写互补判据：持有中 ⇔ `expires_at >= (extract(epoch from now()) * 1000)::bigint`。这让宿主依赖了存储表结构和 acquire 的内部 SQL，升级 store-pg 时要人工 diff。

### 建议形态（供参考，形态由 reins 定）

- `RunLease` 加一个可选方法，例如 `isHeld(sessionId): Promise<boolean>`（或返回 `{ owner, expiresAt } | null`），语义是「此刻 acquire 会因别人持有而失败」，与 acquire 的抢占条件同源、同一时钟；
- 内存实现与 store-pg 实现各补一份，契约测试覆盖「刚过期」「同 owner 续租」两个边界。

### 边界

只读，不改租约语义，不承诺查询后状态不变（调用方自己接受查询与后续动作之间的窗口）。

### AdRate 侧依赖

`agentSessionService.isRunActive`（`src/services/agent/agent-session.service.ts`）目前直读 `reins_runs`，注释已标明与 store-pg 口径同源、升级时一并 diff。上游提供后改调该方法、删掉直读 SQL；之前不写兜底。

### reins 回复（2026-11-15）

采纳需求，并入建议 12：不单独给 `RunLease` 加方法，删除会话前查 `pgRunStates(client, [id])` 是否 `running`。判定与 renew 的"未过期"同一表达式、同一库时钟，store-pg 内只写一处；用例覆盖"刚过期""同 owner 续租"。

### AdRate 发版后核实（2026-11-16）

已升级 core 0.14.0 / store-pg 0.5.0，`isRunActive` 改调 `pgRunStates(client, [id])` 判 `running`，直读 `reins_runs` 的 SQL 已删；原有三条 db 用例（持有中 / 已过期 / 无租约）不改即通过。测试服真跑：会话运行中从侧栏删除被拒（`deleted_at` 未写），同一时刻 `pgRunStates` 读出 `running`。

---

# 会话运行状态建议（2026-11-15）

> 来自 AdRate 灰度前体验优化（会话列表要显示「进行中 / 等你处理 / 异常 / 未读」）的方案评估。依据 npm 官方源 core 0.13.0 / server 0.7.2 / store-pg 0.4.3 / brain 0.8.6 的 `dist` 源码。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 12 | 持久化每个会话最近一次 run 的结果，并提供按一批会话查询运行状态的接口 | core / server / store-pg（+ 内存实现） | 宪法二：run 怎么结束的是运行事实，目前只活在内存信号里，不在任何存储上 | 中，AdRate 会话列表状态标识依赖它（建议 11 可并入） |

## AdRate 建议 12：会话运行状态可持久查询

### 现状

- **是否在跑**：只有 `reins_runs` 租约行，run 结束时 `release` 直接 `DELETE`。
- **怎么结束的**：只能 `run.subscribe()` 等最终信号（`result.status` 为 `done` / `paused`（带 `reason` 与 `interruptions`）/ `handoff` / `error`，或 `kind: "error"`）。这个信号只推给当时在订阅的人，**不写进任何存储**；时间线里也没有对应的「run 结束」事件。
- **等审批的起点**：`approval_request` 事件的 `at` 在时间线上，但宿主要知道「这个会话现在有没有未决审批、从什么时候开始等」，只能自己读日志尾部去推。

### 问题

多会话界面普遍要在列表上标出每个会话的状态（正在跑、等人确认、出错了、跑完没看）。宿主现在只能在 run 登记表外包一层，自己订阅最终信号、自己写一张状态表。AdRate 按这个思路写方案时，碰到的几处问题都源于状态不在框架里：

1. **假异常窗口**：`ActiveRun.finish` 先广播终态、随即释放租约，订阅方要等微任务才醒，所以租约几乎一定先于宿主的终态写入消失。中间这段时间去查，会看到「不在跑、也没有终态」，被判成异常（中途被打断）。宿主只能靠「最后一个运行中的会话消失后再多查一次」来纠正。
2. **新旧 run 互相覆盖**：同一会话上一个 run 的终态写得晚、下一个 run 已经起跑时，宿主要靠「起跑时刻相等」做条件更新来防止覆盖；而数据库时间是微秒、JS 是毫秒，两处都要截到毫秒，否则条件恒不成立。宿主拿不到 run 自己的标识，只能用时刻冒充。
3. **终态分类跟着版本漂**：宿主把信号翻译成自己的终态枚举（`paused` 再按 `reason` / `interruptions` 拆），reins 增减暂停原因或调整结构时，宿主的映射静默失准。
4. **审批等待起点对不上**：宿主拿不到未决审批的请求时刻，只能用 run 结束时刻近似，同一轮审批请求之后还有慢工具时，列表上的「等你处理」比确认卡多挂一段时间。
5. **进程被杀**：拿不到终态，只能约定「起跑时清空、到最后都没写上」= 被打断，语义靠宿主自己维持。

这些都是 reins 自己掌握的运行事实，交给宿主在外面拼，每个宿主都要重新踩一遍。

### 建议形态（供参考，形态由 reins 定）

- **结束时落一条会话级的运行结果**，与释放租约在同一步完成（同一事务或先写结果后删租约），保证任何时刻查询都处于「在跑」或「有结果」之一，不存在两者皆无的窗口（被进程杀死的除外，见下）。内容至少包括：
  - `runId`（或其他能区分同会话前后两个 run 的标识）；
  - `startedAt` / `endedAt`（毫秒，与事件 `at` 同一时钟）；
  - `status`：`done` / `paused` / `handoff` / `error`；`paused` 带 `reason` 与是否有 `client_tool` 中断；`error` 带 `category`。
- **起跑时也落一笔**（`runId` + `startedAt`，结果为空）。这样「有起跑记录、无结果、租约已过期」就是明确的「被打断」，宿主不用自己约定。
- **未决审批**：当结果是停在审批时，带上最早一条未决 `approval_request` 的 `at`。有效期由宿主配置（`ttlMs`），宿主自己加。
- **批量查询**：例如 `runStates(sessionIds): Promise<Map<sessionId, { running: boolean; lastRun: {...} | null }>>`，`running` 与 acquire 的抢占条件同源、同一时钟（即建议 11 的 `isHeld` 的批量版）。会话列表一次要查几十个会话，逐个查不现实。
- 存储侧：store-pg 可以给 `reins_runs` 加列、不再删行，或另建一张表；内存实现同步。

### 边界

- 只记「最近一次 run」，不做历史；历史在时间线和宿主自己的事件里。
- 不涉及「用户是否看过」：已读是宿主的产品概念（reins 没有用户），AdRate 自己存 `last_read_at`。
- 不推送：宿主自己决定轮询频率，reins 只保证查询结果一致。
- 状态表的 DDL 变化按 store-pg 惯例由宿主补迁移，AdRate 可以接受。

### 与建议 11 的关系

建议 11（`RunLease.isHeld`）解决的是单个会话「是否在跑」。如果本建议采纳，`running` 字段就覆盖了它；AdRate 的删除会话校验与会话列表都改调同一个接口，建议 11 可并入本条一起处置。

### AdRate 侧依赖

灰度前体验优化方案（`2026-11-15-灰度前体验优化方案.md`）第二节「会话列表状态标识」暂缓实施，等本建议发版后按新接口做：

- `agent_session` 只加 `last_read_at` 一列，不再加 `last_run_outcome` / `last_run_at`；
- 删掉方案 2.3 的起跑 / 终态写入外包层、毫秒截断与条件更新；`agent-product-events.ts` 的产品事件旁听保留不动；
- 删掉方案 2.4 的「最后一个运行中会话消失后再多查一次」；
- 方案 2.5 的「确认卡有效期起点」偏差随之消失；
- `agentSessionService.isRunActive` 的 `reins_runs` 直读 SQL 一并删除。

在发版之前，AdRate 不写兜底代码，其他四批照常推进。

### reins 回复（2026-11-15）

采纳需求，形态有调整（方案 `docs/implementation-plans/2026-11-15-会话运行状态.md`）。先更正一处现状：四种结局里暂停（`run_paused`，且一定是 run 的最后一条）、交接（`core.handoff`）已经在时间线上，出错有 `core.error` 但分不清是不是终结的那条；真正缺的是"正常跑完"的记号。所以修在时间线，不另建状态表：

- **不变的**：建议里要的信息都给——是否在跑、结局分类（由 reins 维护）、审批等待起点（取 `approval_request` 自己的 `at`）、能区分前后两个 run 的标识、批量查询、进程被杀判"中断"、查询任何时刻都没有"不在跑也没结局"的空档；已读、推送仍不归 reins；AdRate 侧删外包层 / 毫秒截断 / 条件更新 / "再查一次" / `reins_runs` 直读的计划照旧。
- **改了的**：
  1. 每个 run 恰好以一条终结事件收尾：暂停仍是 `run_paused`，done / handoff / error 新增模型不可见的 `core.run_ended`。结局在时间线里，`agent.run()`、asTool 子会话、TanStack 路径的结局也都有记录；但"在跑"只对经 handler 起的 run 成立（它们才占租约），请确认 AdRate 列表里的会话都经 handler 起 run。
  2. 分类只走 core 纯函数 `runStatusOf`，结果是 `running` / `idle` / `unknown` / `interrupted` / `done` / `paused` / `handoff` / `error`；`paused` 带 `reason`、`stopped`（用户停止与断线 / 丢租约中止区分）与 `awaiting`（以 pending 为准列每个等答复的调用：审批带 `requestedAt`，客户端工具单列 `client_tool`，子代理带 `childSessionId`）。
  3. 批量查询是 store-pg 的 `pgRunStates(client, sessionIds)`：一条 SQL 取租约与每个会话最后一条 run 标记，单语句即快照；终结事件一定在释放租约前写入，所以没有空档。依赖 run 经 handler 的租约登记（`createAgent` + `pgStores` 缺省即是）。已知误判窗口：释放租约失败时最多 30 s 内仍显示在跑；进程被杀要等租约到期才显示中断。
  4. **不建状态表、不加列，AdRate 不用做 DDL 迁移。**
  5. 不提供 `startedAt` / `runId`：区分前后 run 用结局事件的 `seq`，"跑完没看"拿 `endedAt` 与 `last_read_at` 比。
- **AdRate 需要知道**：升级前跑完的老会话判 `unknown`（不是"中断"），列表可显示为无状态；含 `run_ended` 的会话老版本 core 读不了，多实例要同时升级、不能回滚到 0.13。处置见下节。

### reins 处置（2026-11-16）

按上面的回复落地，形状没有变，随 core 0.14.0 / store-pg 0.5.0 / server 0.8.0 / agent 0.7.0 / adapter-tanstack-ai 0.4.0 发布（同批依赖包 patch）。AdRate 接入时补充三点：

- **老会话的读法**：升级前最后一个 run 跑完的判 `unknown`；最后一个 run 是暂停的照旧判 `paused`，但 `awaiting` 为 `undefined`（老事件没有这个字段），`stopped` 为 `false`；完全没有 run 标记的会话判 `idle`。
- **用法**：README（`@reinsjs/store-pg`「Session status for a session list」）给了列表徽标与删除前检查两个函数，用例与 README 逐字一致。单进程宿主不用 pg 时，`runs.get(id) !== undefined` 当 `held`、`lastRunMarker(timeline)` 当 `lastMarker`，直接调 `runStatusOf`。
- **耗时**（PG 16.13，与 AdRate 生产同版本）：单个会话 20 万条事件、没有收尾标记（被杀的长 run 或老会话）约 15 ms；500 个会话一批 46～85 ms。没有加索引。

### AdRate 发版后核实（2026-11-16）

升级 core 0.14.0 / agent 0.7.0 / store-pg 0.5.0 / server 0.8.0 / ui-agui 0.6.0（锁文件单一 core，`pgSchemaStatements` DDL 逐字未变，无迁移），测试服真跑逐项对照：

- 新会话运行中读 `running`，跑完读 `done`；停在确认卡读 `paused` / `approval`，`awaiting` 带那条确认与 `requestedAt`；提问卡读 `paused` / `host`，`awaiting` 是 `client_tool`；用户点停止读 `paused` / `host`、`stopped: true`、`awaiting: []`。
- 老会话与说明一致：升级前跑完的读 `unknown`；升级前停在确认卡的读 `paused`、无 `awaiting`。
- 跨版本续跑：升级前停在确认卡（卡已过期）的会话发新消息，新版按「用户发新消息代替批准」关掉那条确认，模型正常回复，收尾 `run_ended: done`；事件顺序 `tools_bound` → `run_resumed` → `approval_decision`，与 CHANGELOG 一致。
- 直播流里 `run_ended` 是 AG-UI `CUSTOM` 帧，前端时间线照常收尾；五个会话刷新重放无控制台错误。计费按 `budget_usage` 逐条记一行，多出来的事件不影响（一轮 14 次模型调用记 14 行）。

---

# 停止后续跑建议（2026-11-16）

> 来自 AdRate 批 0（升级 core 0.14.0）测试服点验后 Boss 的手动测试。依据 npm 官方源 core 0.14.0 / lowering-fetch 0.6.5 的 `dist` 源码与测试服真实事件日志。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 13 | 模型思考到一半被停止后，会话再也续不上：只有思考、没有正文和工具调用的一轮被原样回放，DeepSeek 拒绝 | core / lowering-fetch | 宪法：时间线是唯一状态，记下的每一轮都必须能回放给模型；停止是正常操作，不应把会话写坏 | 高，灰度前阻断项（用户在「思考中」点停止很常见，一次即永久卡死） |

## AdRate 建议 13：只有思考的一轮不能回放，会话永久卡死

### 复现

DeepSeek 官方通道（`deepseek()`，`deepseek-flash`，DeepSeek 方言回填 `reasoning_content`），经 handler 起 run：

1. 模型调 `adrate_ask_user`（客户端工具）后暂停，用户答复，run 续跑；
2. 模型开始流式输出思考，**在出正文或工具调用之前**，用户点停止（`controller.abort(new RunStop())`）；
3. 用户在同一会话再发任何消息（或点重试）。

结果：第 3 步每一次都 400，会话再也续不上，只能新开会话。

### 证据（测试服会话 `692e7ebe-…`，事件 seq）

```
14 core.model_thinking   {"text":"User chose Ads. Now I need to ask what scope …"}   ← 停止时流到一半的思考
15 core.run_paused       {"reason":"host","awaiting":[],"stopped":true,…}
16 core.tools_bound
17 core.user_message     "继续"
18 core.error            {"category":"lowering","message":"400 … Invalid assistant message: content or tool_calls must be set"}
19 core.run_ended        {"status":"error","category":"lowering"}
（20～31 用户又试了三次，每次同样 tools_bound → user_message → error → run_ended:error）
```

### 原因

- **core**：`runLoop` 在 `outcome.stopReason === "aborted"` 时先 `flush()` 本轮已产出的模型事件，再 `pause("host")`。停在思考阶段时，本轮只留下一条 `core.model_thinking`，没有 `model_text`、没有 `tool_call`。
- **lowering-fetch**：`assistantMessage()` 对这一轮生成 `{ role: "assistant", content: null, reasoning_content: "…" }`，既无 `content` 也无 `tool_calls`。DeepSeek（以及 OpenAI Chat 规范）要求两者至少有一个，直接 400。
- 时间线只追加、每次续跑都整段回放，这一轮永远在历史里，所以之后每次都失败；`category: "lowering"` 判为不可重试，前端只能显示通用错误。

### 建议形态（供参考，形态由 reins 定）

二选一或都做：

- **lowering 侧**：一轮既无正文也无工具调用时，不生成 assistant 消息（思考按 `dropped` 记进损失矩阵，说明「被中止的一轮只有思考，无可回放的位置」）；或按方言要求补空串正文，以 DeepSeek / OpenAI 实测接受为准。
- **core 侧**：停止落在模型输出阶段时，半截思考不作为一轮模型输出写入（或写成模型不可见的记录），从源头保证时间线里每一轮都可回放。

请一并确认两种相邻情况：停止时只流出了半个 `tool_call`（参数不完整）；停止时只有思考、但同一请求后续本该带工具调用。以及 Anthropic / Responses 等其他 lowering 遇到「只有思考的一轮」是否同样被拒。

### 边界

- 不要求恢复被停止的那段思考，丢掉即可；用户停止后的下一轮由模型重新思考。
- 已经卡死的存量会话：修复后回放时自然跳过那一轮即可恢复，AdRate 不做数据修补。

### AdRate 侧依赖

- core 0.14 的 CHANGELOG 没有提到改动「中止后先写本轮已产出事件」这条路径，判断不是 0.14 引入的，本次是测试服点验时偶然撞到；0.13 是否同样复现未单独核对。
- AdRate 不在宿主侧改写或过滤时间线（时间线与回放归 reins），也不写兜底；灰度前等 reins 修复，修复后升级、重跑 eval，并用同一复现步骤在测试服验证，原会话 `692e7ebe` 应能续上。

### reins 回复（2026-11-16）

采纳，修在 lowering-fetch 的 Chat 线，core 不动，随 lowering-fetch 0.6.6（patch）发布，AdRate 只需升这一个包。

- **为什么不改 core**：停止时那段思考确实发生过，照实写进时间线是对的（宪法二）。在 core 里不写或改写它，等于悄悄丢掉一条事实。问题在于 Chat 线没有为这种一轮给出能发出去的形状。Anthropic 线早有"全部块都发不出就整条不发"，这次是 Chat 线漏补了。
- **改法**：一轮既无正文也无工具调用时，Chat 线整条不发，思考在损失矩阵里记 `dropped`（note 写明"这一轮只有思考"）。跳过后历史里会出现 user → user 相邻，DeepSeek 与 OpenAI 实测都接受。
- **影响面比报告的大**：不只是点停止，思考流到一半断流（走 error 出口）也会留下同样的一轮，这次一并修了。
- **相邻情况**（`spikes/aborted-turn-replay/`，原始请求体两遍一致）：
  - 停在半个 tool_call：截断的入参原文照常送回，循环收尾时给它补"没执行"的结果。DeepSeek、OpenAI Chat、OpenAI Responses 都接受，不用改。
  - 停在思考、但本该接着调工具：与"只有思考"同一种情况，下一轮由模型重新思考。
  - Anthropic 线：停在思考半截时还没有签名，这种思考本来就记 dropped，空 assistant 整条不发，不受影响。思考块刚结束、签名已到、正文第一个字还没出就被停的窄窗口，会发出只含一个 thinking 块的 assistant；`claude-haiku-5-5` 两遍实测厂商接受（直接接 user、停在工具结果之后两种都是），不用改。
  - Responses 线：加密项要等思考结束才给，停在半截的思考 dropped、不出任何项；思考已完整、停在后续项之前的，单独一条 reasoning 项后直接接 user，厂商实测接受。
  - lowering-pi：pi-ai 0.85.1 在 openai-completions 里自己跳过既无内容又无工具调用的 assistant，不受影响。
- **复现与验证**：真 runLoop + DeepSeek `deepseek-flash`，思考流出 40 字时 `abort(new RunStop())`，再在同一会话发"继续"。修前 400（与测试服同一条错误），修后 3/3 正常收尾。
- **存量会话**：不需要修数据，升级后下一次请求就能续上。`692e7ebe` 应能直接恢复，请升级后照原步骤核实。

### AdRate 发版后核实（2026-11-16）

只升 `@reinsjs/lowering-fetch` 0.6.5 → 0.6.6（依赖仍是 core 0.14.0，锁文件单一 core，其余包不动）。npm 官方源两版 `dist` 对比与 CHANGELOG 一致：Chat 线一轮既无正文也无工具调用时整条不发、思考记 `dropped`；另把空文本段记 dropped、挂起的工具图片改到确认要发 assistant 后再释放。

- **真实事件对照**：测试服卡死会话 `692e7ebe` 的事件（截到第一次报错前的 user_message）分别喂两版 `toRequest`（不调模型）：0.6.5 生成 `… tool → assistant → user`，其中 1 条 assistant 既无 `content` 也无 `tool_calls`（即 400 来源）；0.6.6 生成 `… tool → user`，空 assistant 0 条，landings 里 1 条「only thinking」dropped。
- **本地闸门**：typecheck 通过，Agent 单测 23 文件 314 条通过；eval 官方通道 7 条 × 3 全部 3/3 过线。
- **测试服复验**（`7a7a4b4a` 只部署 web）：原会话 `692e7ebe` 发新消息即续上（seq 33～47 正常调工具出正文）；同一会话又按原步骤复现一遍——提问卡答复后续跑、只有思考（seq 52）时停止（seq 53 `stopped: true`），再发消息 seq 59 收尾 `run_ended: done`，不再 400。建议 13 关闭。

---

# 多身份 MCP 建议（2026-11-19）

> 来自 AdRate 二期「一个会话操作多个 TikTok 身份」的方案前调研。依据 npm 官方源 `@reinsjs/tools-mcp` 0.3.11 的 `dist` 源码与 README。AdRate 侧还在讨论这次调用用哪个身份（业务口径），但不管口径怎么定，都需要「按调用选凭据」。

## 总览

| # | 建议 | 涉及包 | 与宪法的关系 | 优先级 |
| --- | --- | --- | --- | --- |
| 14 | 同一个 MCP 服务器、多个凭据共用一张工具表，每次调用由宿主指定走哪个凭据 | tools-mcp | 无冲突：一个 run 内工具表仍然固定，只是每次调用走哪个连接由宿主决定 | 中，AdRate 多身份会话（A4）的 MCP 挂载依赖它；不阻塞其他二期项 |

## AdRate 建议 14：一张工具表，按调用选凭据

### 现状

- `mcpTools()` 一个 socket 只有一个 `transport`，也就只有一条连接、一个凭据。每个工具的 `execute` 都绑在这条连接上（`conn.callTool`）。
- `McpAuth.token()` 不带参数，不知道这次请求是哪个工具、什么入参、哪个会话。
- README「Expiring credentials」的写法是一个用户一个凭据（`db.accessToken(userId)`），「Hot reload」与连接生命周期一节建议宿主按配置缓存 socket。这两条覆盖的是「每个用户一个凭据」，没有覆盖「一个用户在一个 run 里要用多个凭据」。

### 问题

AdRate 的一个用户可能管着多个 TikTok 身份，每个身份是一份独立的 OAuth 凭据，连的是同一个 TikTok MCP 服务器。各身份拿到的工具表完全相同（同一份服务端目录，约 400 个工具），区别只在于各自能看到哪些广告账户 / BC。

二期要做的是：会话不再绑定单个身份，模型只管对哪个账户做什么，**用哪个身份由宿主根据调用入参决定**（`advertiser_id` / `bc_id` → 对该账户有权限的身份 → 该身份的凭据）。用现有 API 有三种做法，都不理想：

1. **每个身份一个 socket，加 `prefix` 区分**：工具表变成 N 份（约 400 × N），并且「用哪个身份」变成模型要做的选择，而这是宿主的业务规则，不该交给模型。
2. **只挂一个 socket，宿主在 `override` 包装的 `execute` 里转发到另一个身份的 socket**：要对每个凭据各调一次 `socket.tools()`，拿到对应工具再调它的 `execute`；`override` 对每个凭据各跑一遍。被转发的这些连接不在 loop 管理之内，run 起步时不会对它们做 `tools/list`，工具表签名也不包含它们。等于宿主在 reins 外面自己维护一套连接池和分派逻辑。
3. **一条连接，`token()` 按调用上下文切换凭据**（宿主用 AsyncLocalStorage 传上下文）：能不能用取决于两件我们没法从宿主侧确认的事：TikTok MCP 是否把 `Mcp-Session-Id` 绑定到初始化时的令牌；同一条连接上并发、带不同令牌的请求，SDK 和服务器是否都按请求处理。即使可行，「一条连接混用多个身份」也是靠隐式上下文实现的，401 后 `onUnauthorized` 刷新的是哪一个凭据也说不清。

### 建议形态（供参考，形态由 reins 定）

`mcpTools` 支持「一个服务器、多个凭据路由」，大致是：

- 宿主提供 `route(call) → key`，`call` 含工具原名、入参和 `ToolContext`（拿得到 principal / 会话），返回凭据键；返回 null 或抛错时，这次调用落 `isError` 结果，文案由宿主给出（例如「该身份未开通官方工具授权」）。
- 宿主再提供 `connectionFor(key)`，按键返回该凭据的 `auth` / `transport` 配方。reins 按键懒建连接、复用，`close()` 一起关；需要时宿主可以按键淘汰（凭据撤销、到期）。
- 工具表仍然在 run 起步时取一次：由宿主指定一个目录键（或交给 reins 从可用键里取第一个）去做 `tools/list`，整个 run 不变，签名与现在一致。各键的工具表视为相同；某个键实际没有某个工具时，由服务器报错，按现有规则变成 `isError`。
- `onUnauthorized` 按键刷新，重试只针对这一个键。

如果 reins 实测发现做法 3 是可行的（TikTok MCP 不把会话绑定到令牌、并发请求按请求取令牌），更小的改法是让 `token()` / `onUnauthorized()` 收到调用上下文。这种情况也请在 README 写明前提，以及会话与令牌的关系。

### 边界

- 路由决策在宿主：reins 不需要知道 `advertiser_id`、身份之类的业务概念，只是把调用交给宿主给出的键。
- 一个 run 内工具表固定这一条不变，不要求按身份分别出工具表。
- 不要求在时间线里记录走了哪个键；需要审计的话，宿主在 `execute` 包装层自己记（AdRate 已经这样记 MCP 写操作的审计）。

### AdRate 侧依赖

- A4（会话可用团队全部身份）的 MCP 挂载按此设计。在 reins 回复之前，AdRate 不写转发层，也不写兜底；A4 的其他部分（自有能力按账户解析身份）不受影响，可以先做方案。
- AdRate 现在按凭据 id 在进程内缓存 socket（`tiktok-mcp-socket.ts`），对凭据撤销、30 天硬期限做淘汰。上线这项能力后，这套缓存会换成 reins 的按键连接池，淘汰逻辑改为按键调用。

### reins 回复（2026-11-19）

采纳，形态由 reins 微调，随 tools-mcp 0.4.0（minor）发布，只升这一个包。

- **形态**：`mcpTools({ transport, route: { keyOf(call, ctx), transportFor(key) } })`，另加 `socket.evict(key)`。`transport` 仍是目录连接，只做 run 起步的 `tools/list`（`optional` 也只看它）；每次 `tools/call` 先问 `keyOf` 要凭据键，再按键从 Socket 自带的连接池取连接（没有就调一次 `transportFor(key)` 懒建，之后跨 run 复用、断了按配方重建一次）。route 不进工具表签名，改路由规则不算配置漂移，暂停中的审批照常续跑。
- **与草案不同的三处**：
  1. 不设"目录键 / 从可用键取第一个"，目录连接就是原来的 `transport`，不配 route 时行为不变。
  2. 不设"返回 null 由宿主给文案"：`keyOf` 里直接抛错，message 原样给模型（`Tool execution failed: <你们的话>`）。返回的不是非空字符串一律不发出，**绝不回退到目录连接**。
  3. 按键刷新不加接口：每个键的配方自带自己的 `auth`，401 时只刷新那一把。
- **做法 3（一条连接按调用换令牌）不做**：能不能成立取决于服务器是否把 MCP 会话绑到初始化令牌，客户端保证不了。
- **两处安全细节**：
  - `evict` 立即把键移出池，但等这条连接上在途的调用结束才关。SDK 关连接会掐断在途请求，写请求可能已经到了 TikTok，却被记成"失败"，模型一重试就是重复写。`close()` 是收摊，不等在途调用。
  - 选凭据或握手期间 run 被停止时，模型看到的是 `Not executed: …`（`ROUTE_NOT_SENT_TEXT`），不是"结果未知"，因为调用确实没发出。
- **你们要负责的**（README "Several credentials on one server" 有完整配方，与用例逐字一致）：
  - 连接池跨会话、跨用户共享，**`keyOf` 是唯一授权点**：用 `ctx.principal` 判断这个人能不能用这个身份。
  - fail-closed：只有明确列出的无账户工具（`tool_list` / `tool_get`）走目录身份；认不出账户字段的调用拒绝，不要找个缺省身份发出；一次调用里的所有账户字段必须落到同一个身份。配方只认 `advertiser_id` / `bc_id`，你们的服务器还有别的账户字段（例如复数形式）要补进 `accountsOf`。
  - `transportFor` 只能由键决定，因为同一个键只调一次。
  - 审批发生在路由之前：要让审批人看到用哪个身份，在审批规则的 `summary` 里用同一个函数算一遍。
  - 目录身份被撤销时没有单独淘汰的办法，`close()` 后重建 Socket。
  - 每个键握手后会挂一条常驻 SSE；池不设上限，键的数量由你们控制，凭据撤销或到期时调 `evict`。
- **替换 `tiktok-mcp-socket.ts`**：Socket 改按团队缓存（目录身份取团队任一可用身份）。原来按凭据 id 淘汰的逻辑改成调 `evict(凭据键)`。
- **请核实**：reins 用真 Streamable HTTP + 内存服务器测过按键令牌、401 按键刷新、evict 与在途调用，真 TikTok 多身份没有跑过（reins 仓库 OPT-261119-1）。A4 接测试服后请核对：`tools/call` 带的令牌与账户归属一致；某个身份没有授权时服务器返回什么；evict 之后能正常重建。

### AdRate 核实（2026-11-19，未升级）

对照 npm 官方源 `@reinsjs/tools-mcp` 0.4.0 的 `dist` 与 README「Several credentials on one server」，与回复一致：依赖仍是 core 0.14.0，AdRate 只需要升这一个包；`keyOf` 在工具 `execute` 内、真正发出之前调用，返回值不合规或抛错就不发出，也不会回退到目录连接。升级随 A4 一起做，不单独升。

- **草案第二条（宿主追加的路由入参）不用另外请 reins 改**：`keyOf` 拿到的 `args` / `ctx` 就是传给内层 `execute` 的那两个对象。Boss 11-19 定「多身份确定不了时由 Agent 指定身份」，宿主在 `override` 的包装层从入参里取出身份字段并删掉，用删掉字段后的新入参对象作键，记进进程内 `WeakMap`（入参对象 → 身份），`keyOf` 用同一个对象查到身份。发给 TikTok 的入参里没有这个字段。
- **账户字段要补全**：除了 `advertiser_id` / `bc_id`，快照里还有 `advertiser_ids`（数组）、`tto_tcm_account_id`、`tcm_account_id`、`payment_portfolio_id` 等。能对应到身份的就自动处理，对应不到的交给 Agent 指定的身份字段；两者都没有就拒绝，不走目录身份。
- **测试服待核对**（reins 的请求，reins 仓库 OPT-261119-1；A4 接测试服时做）：`tools/call` 带的令牌与账户归属一致；某个身份对账户没有授权时 TikTok 返回什么；`evict` 之后能正常重建。

### AdRate 测试服核对结果（2026-11-20，tools-mcp 0.4.0 + core 0.14）

reins 仓库 OPT-261119-1 请求的三项，测试服团队 1（两个开通 Agent 授权的身份，同一账户被两者覆盖）实测：

- **令牌与账户归属一致**：两个身份分别经 MCP 调 `bc_get` / `auth_advertiser_get`，返回的 BC（23 / 25）与账户（173 / 346）逐个 ID 与各自 App 授权的本地记录一致；写操作（`adgroup_status_update` / `adgroup_update`）按 `keyOf` 路由到所选身份并成功。
- **身份对账户没有授权**：显式指定看不到该账户的身份调 `advertiser_info_get`，TikTok 返回 `code 40001`「No permission to operate advertiser: <id>」，请求未生效，无副作用。
- **evict 后重建**：把两条凭据临时置为过期（身份池清空、Socket 退役），再恢复原值，同一会话下一轮工具表恢复、调用成功。

### reins 确认（2026-11-20）

三项核对收到，与 reins 侧用例一致，reins 仓库 OPT-261119-1 关闭。建议 14 关闭。

## AdRate 建议 15：工具增删提示在大量增删时汇总

### 现状与问题

core 0.14 的工具表变化提示（`announce`）逐个列出增删的工具名。挂 TikTok MCP 时，凭据过期 / 恢复会一次增删约 378 个工具，这条 `system_note` 把几百个工具名全列出来，只在变化那一轮出现一次，但单条就是几千 token，且对模型没有额外信息量（它只需要知道「TikTok 工具整体没了 / 回来了」）。

### 建议形态（供参考）

增删数超过阈值时按来源汇总，例如「Removed all 378 tools from MCP server `tiktok`」；或给宿主一个钩子自定义提示文本。优先级低，不阻塞 AdRate。

### reins 回复（2026-11-20）

采纳，但不按来源汇总，也不加钩子：只改 core 里拼这句说明的函数（`renderToolChangeNote`），随 core 0.14.1 发布。依赖 core 的包同时各出一个 patch（只改了依赖版本），它们对 core 是精确版本依赖，AdRate 用到的 `@reinsjs/*` 要一起升，只升 core 会装出两份 core。

- **为什么不按来源汇总**：core 不知道工具来自哪台 MCP 服务器（`tools_bound` 只存名字，`Tool` 上也没有来源字段）。为一句说明改公开形状不值得。
- **为什么不加钩子**：挂大 MCP 的宿主都会遇到这个问题，缺省就该合理。等真有宿主要自定义措辞再加。
- **改法**：增删任一侧不超过 20 件时，文案与现在逐字一致。超过 20 件时只列 20 个名字并报总数，例如：
  `Removed 378 tools (no longer callable, even if earlier turns used them), including adgroup_status_update, campaign_get, ad_audit, …, and 358 more.`
  本会话时间线里出现过的名字排在前面：先列调用过的（含经 `tool_find` 原生路径取回的），再列在对话文本里提到过的。其余按字母序补足，让模型看得出是哪一类工具变了。以前的变化说明里为凑数列出的名字不算出现过，凭据来回过期多少次，真用过的都排在最前。
- **为什么只点名出现过的**：以前各轮发过的工具表不进历史，模型往回翻只能看到自己用过、提过的工具名，也只会凭记忆去调这些。万一调了已经不在表里的工具，循环回 `Unknown tool`，不会发出。
- **影响面比报告的大**：说明写进日志后每次请求都会回放，不只出现在变化那一轮；凭据每过期 / 恢复一次就多两条。压缩后每条封顶约 150 token。
- **不变**：`meta.toolsChanged` 与 `tools_bound` 仍记完整增删，回放与排查照旧可用；`announceToolChanges: false` 照旧可关。
- **验证**（reins 仓库 `spikes/tool-change-summary/`）：第一段挂 378 件 TikTok 风格工具、用过两件，第二段工具全没，用户接着提要求。两题：要用的工具用过（说明里点名），要用的工具没用过（不在 20 个之内）。压缩说明与全列说明两臂对照。DeepSeek `deepseek-flash` 12/12、`claude-sonnet-5-5` 8/8，两臂都没有一次去调已移除的工具，都向用户说明能力不可用。
- **请核实**：升级后在测试服让凭据过期、恢复各一次，看两条说明的文本，以及之后的请求里上下文是否不再带几百个名字。

### AdRate 升级记录（2026-11-20）

- 一组一起升：core 0.14.1、agent 0.7.1、brain 0.8.8、lowering-fetch 0.6.7、store-pg 0.5.1、tools-mcp 0.4.1、eval 0.4.10（server / ui-agui 随 agent 到 0.8.1 / 0.6.1），锁文件里只有一份 core。
- store-pg 0.5.0 → 0.5.1 只改依赖版本，DDL 无变化，不补迁移；core 只改 `renderToolChangeNote` 并新增 `toolMentionTiers`，公开接口不变。
- 运行时只影响 web（Worker 只引用记忆命名空间纯函数，Admin / 营销站不依赖 reins）。
- typecheck 通过；Agent 单测 30 文件 408 条、db 测试 10 文件 77 条全过；eval（中转站）7 条夹具各 3 次 21/21 全过（`logs/agent-eval/2026-11-20T02-39-39-799Z.md`，最终回答平均字数 195 / 236 / 382 / 75 / 314 / 211 / 437）。
- 说明文本写进事件日志：升级前已写入的长说明留在原会话里不变（`data` 是 `json`，不改写历史），只有升级后新产生的说明变短。测试服核实看新会话里新产生的两条。

### AdRate 测试服核实（2026-11-20，core 0.14.1，`d0d57a7f`）

测试服团队 1 新建会话：第 1 轮经 MCP 调 `bc_get` / `bc_asset_get` / `bc_member_get` / `bc_balance_get`（含 `tool_find` 取回）；把两条 MCP 凭据 `refresh_expires_at` 临时改到过去，第 2 轮；恢复原值，第 3 轮。

- **移除说明**（557 字符，旧格式全列约 8.9K 字符）：`Removed 358 tools (no longer callable, even if earlier turns used them), including bc_asset_get, bc_balance_get, bc_get, bc_member_get, tool_find, advertiser_balance_get, advertiser_info_get, bc_transfer, payment_portfolio_…, ad_audience_size_estimate, …, and 338 more.` 前 5 个正是第 1 轮调用过的，其后是对话里提到过的，其余按字母序补足。总数 358 而非 378：AdRate 的 MCP 放行策略先过滤了一部分。
- **恢复说明**（501 字符）：`Added 358 tools, including …, and 338 more.`，排序同上。
- **模型行为**：第 2 轮没有调任何已移除工具，向用户说明 TikTok 直连工具这一轮不可用，改用 AdRate 自有能力回答；第 3 轮恢复调 MCP 工具（`bc_balance_get` 被 TikTok 拒绝是该身份在 BC 内无财务角色，业务权限问题）。
- **上下文**：两条说明合计约 1K 字符（旧格式约 17.7K 字符）随后续每次请求回放；`meta.toolsChanged` 仍是完整 358 项。
- 结论：符合 reins 描述，建议 15 可关闭。A4 上正式服时随同一批发布。

---

## AdRate 建议 16：Socket 暂停时可带宿主自定义原因，并随暂停事件落库

### 现状与问题

Socket 的 `onTurnEnd` 只能返回 `pause: { reason: "budget" | "host"; note?: string }`（core 0.14.1 `TurnDecision`）。落库的 `core.run_paused` payload 只有 `{ reason, state, awaiting, stopped? }`，`note` 只进本次返回的 `Interruption`，不落库；`pgRunStates` / `RunStatus` 也只带 `reason`。

结果是：事后（另一个请求、另一个进程、列表轮询）只能看到「budget」或「host」，分不清是哪个 Socket、为什么停的。AdRate 的实际场景：

1. **积分用完暂停**（AdRate 新增的积分 Socket，替代固定预算）与 **`compact()` 连续整理 3 次失败**都只能报 `budget`。后台定时任务的结算在 Worker 进程里读 `RunStatus`，为了区分只能在结算时再查一次积分余额猜原因；暂停后用户已充值的话就会猜错，飞书通知写错原因。
2. **前端**看到 `paused(budget)` 只能统一显示「继续」。积分不足的情况要等用户点了继续、入场检查回 403，才出「去充值」的行动卡，多绕一步。
3. **续跑后的模型**也不知道上一段为什么停（例如「积分用完，用户充值后继续」），宿主想补一句说明只能自己猜原因。

### 建议形态（供参考，形态由 reins 定）

- `pause` 增加可选宿主原因码，例如 `pause: { reason: "budget", code?: string, note?: string }`。`code` 是宿主自定义的短标识（如 `adrate.credits_exhausted`），reins 只校验格式（如 `^[a-z0-9_.:-]{1,64}$`）、不解释含义。
- `code`（以及可选的 `note`）写进 `core.run_paused` payload，`runStatusOf` / `pgRunStates` 的 `paused` 状态带出 `code`。
- reins 自带模块也可以顺手用上：`budget()` 标出触顶维度，`compact()` 标 `compact_exhausted`。宿主和前端就能直接区分「轮数 / token 触顶」与「整理失败」。
- 不改 `reason` 的闭集：续跑语义、`continueRun` 等按 `reason` 判断的逻辑不受影响，`code` 只是附加信息。

### 对 AdRate 的影响

不阻塞。A1 先用「结算时查积分」的办法区分，reins 支持后改为读 `code`：结算与通知不再猜原因，前端暂停时直接出对应的行动卡，续跑时按 `code` 给模型补一句说明。

### reins 回复（2026-11-23）

采纳，形态基本照建议，调整三处。已于 2026-11-23 发布：core 0.15.0、brain 0.9.0、ui-agui 0.7.0、adapter-tanstack-ai 0.5.0，其余依赖 core 的包各出 patch（lowering-fetch 0.6.8、lowering-pi / eval 0.4.11、agent 0.7.2、server 0.8.2、store-pg 0.5.2、store-sqlite 0.3.13、tools-mcp 0.4.2）。它们对 core 是精确版本依赖，AdRate 用到的 `@reinsjs/*` 要一起升。

- **用法**：积分 Socket 的 `onTurnEnd` 返回 `{ pause: { reason: "budget", code: "adrate.credits_exhausted", note } }`。
- **读出的三个位置**：
  - 时间线：`core.run_paused` 载荷多了可选的 `code` 与 `note`。
  - 事后查询：`runStatusOf` / `pgRunStates` 的 `paused` 带 `code`。它记的是暂停那一刻的原因，之后用户充值不会改变它，结算与通知直接读即可。
  - 暂停当场：实时返回的 `Interruption` 带 `code`，AG-UI 在该中断的 `metadata.code`，前端不用等用户点"继续"就能出"去充值"卡。
- **内置来源的码**：`reins.max_turns`（循环自带的轮数兜底）、`reins.budget`（`budget()`）、`reins.compact_stalled`（`compact()` 连续整理达到上限）。`reins.` 前缀留给内置来源，宿主用自己的前缀。
- **调整一：`budget()` 的码不编维度**。可能多维同时触顶，一个字符串装不下；维度在 `note` 里。要机器可读就传 `budget({ code: (hits) => … })` 自己算，注意维度名带大写、要先转小写。
- **调整二：`note` 落进事件，但不进 `RunStatus`**。事件是记录，留着排查；状态查询是给机器分类的，不带英文说明。
- **调整三：格式比建议多一条**，`^[a-z0-9][a-z0-9_.:-]{0,63}$`（首字符须是字母或数字）。不合规的码会被丢掉，run **照常暂停**，同时在 `run_paused` 前记一条模型不可见的 `core.error`（category `input`、`detail.phase: "onTurnEnd"`，后面没有 `run_ended`）。如果 AdRate 把所有 `core.error` 都当终结处理，这里要留意。`reason` 写成 budget / host 以外的值同样处理，按 host 暂停。
- **不变**：`reason` 仍是闭集，reins 不按 `code` 做任何分支；`code` 不进续跑状态与签名；只加可选字段，不升事件版本，新旧版本混跑安全，老事件读出来没有 `code`。
- **不带码的暂停**：宿主中止、丢租约、用户停止（已有 `stopped`），以及等审批 / 客户端工具 / 子代理的暂停。用户恰好在 Socket 要求暂停的同时点了停止，按停止记，不带码。子代理会话因带码的原因暂停时，码在子会话里，按 `awaiting[].childSessionId` 查。
- **场景 3（续跑时让模型知道上次为什么停）**：reins 不自动告诉模型，这属于行为改动，目前没有模型因此做错的样本。宿主可以在自己的 Socket `beforeModel` 里读时间线上最近一条 `run_paused` 的 `code`，`emit` 一条说明，自己保证只写一次（这个写法用假模型核实过：续跑的第一次请求里带着这条说明）。
- **顺带修了 TanStack 适配器的一处既有缺口**（AdRate 不走这条路径，不受影响）：已因审批 / 客户端工具暂停的轮次不再问 Socket，此前会多写一条终结事件。
- **验证**：全部假模型（模型看不见这个字段），`pnpm check` 与构建产物自检全绿。发版前另起 PG 16.13 真库跑了一遍（store-pg 的 pg / postgres.js / Drizzle 列在内，2103 条全过）；发后在空目录从 npm 官方源安装，冒烟 6/6。独立审查对初版做了 19 处变异、拦住 18 处，漏的那处（一条空断言）已补；按审查意见改动后的逻辑另做 5 处变异，全部拦住。
- **请核实**：升级后在测试服让积分用完暂停一次，看 `pgRunStates` 的 `code` 与前端收到的 `metadata.code`；充值后不续跑再查一次，`code` 应不变；再把积分 Socket 的暂停路径完整跑一遍，确认时间线里 `run_paused` 前没有 `core.error`（有就是码的格式不对）。

### AdRate 测试服核实（2026-11-23，core 0.15.0，`2805ade9`）

测试服团队 1 的定时任务后台 run：提示词要求逐个账户调工具，run 起跑后把团队 AI 积分包的已用量临时改满（余额归零），之后按真实消耗恢复。

- **`pgRunStates`**：`{"state":"paused","reason":"budget","stopped":false,"awaiting":[],"code":"adrate.credits_exhausted"}`；定时任务结算据此记为 `failed / credits_exhausted` 并发了通知。
- **充值后不续跑再查**：积分恢复后再调一次，`code` 仍是 `adrate.credits_exhausted`，未变。
- **时间线**：`core.run_paused` 载荷带 `code` 与 `note`，整条会话没有任何 `core.error`。
- 前端没有直接读 AG-UI 的 `metadata.code`：暂停条从时间线 `run_paused` 事件取码，实时与补发同一路径（单测锁定），页面效果由 Boss 在该会话核对。
- 结论：符合 reins 描述，建议 16 可关闭。随 A1 上正式服发布。

---

# 图片输入建议（2026-11-24）

## AdRate 建议 17：图片以引用形式进入事件日志（字节放 BlobStore），被折叠后可取回

### 现状（core 0.15.0 / brain 0.9.0）

- `ImagePart` 只有一种形态 `{ type: "image", mime, data }`，`data` 是内联 base64。README「Media」一节写明：媒体字节随事件存进日志，只追加、不外溢，在视野内时每轮重发。
- `compact()` 折叠后附的清单（`MANIFEST_HEADING`：「Folded tool results …」）只列被折叠的**工具结果**，`recall({ seq })` 按此取回。用户消息里的图片被折叠后，清单里没有它。README 说媒体内容「can fold … with `compact` and get it back with `recall`」，是否也覆盖用户消息，请 reins 确认。
- reins 已有 `BlobStore` 合同（`put` / `get` / `slice`，`put` 带 `sessionId`），`spill()` 与 `fetch_blob` 用的就是它；store-pg 有 `reins_blobs` 表。

### 问题（AdRate 场景）

AdRate 要支持用户在对话里粘贴截图：TikTok 后台的报错、数据面板，或者一张素材图。按现状：

1. **字节永久留在事件表里。** 一张压缩后的截图，base64 后约 0.3～0.5MB；一个排查会话发十来张就是几 MB。事件表的 `data` 是 `json`（续跑要按原文校验，不能用 `jsonb`），只追加，会话不删就一直在。
2. **读会话的成本随图片数量线性增长，和图片在不在视野内无关。** 凡是读整条时间线的路径都会把这些字节一起读出来、一起解析：run 起跑构建投影、宿主回放历史给前端、宿主在事件上做的查询（AdRate 的会话搜索只从 `json` 里抽文本片段做匹配，但 `json` 类型每次访问都要解析整行）。
3. **前端展示要再取一遍。** 宿主想在用户消息气泡里显示这张图，只能从事件里取 base64 下发，或者另存一份。另存就有两份存储、两处清理。
4. **折叠后取不回。** 图片被 `compact` 折叠后，模型不知道它还在，也没有办法再看。

### 建议形态（供参考，形态由 reins 定）

- **增加图片的引用形态**，例如 `{ type: "image", mime, blobId }`，与 `data` 二选一。字节放在 `BlobStore` 里：宿主先 `blobs.put(bytes, { mime, sessionId })`，再追加带引用的用户消息。降级层组装请求时按 `blobId` 取字节，是否发送仍由 capabilities 决定，不支持时落占位并记 `lossy`，与现在一致。
- **追加前校验引用（fail-closed）**：`blobId` 不存在、或不属于本会话时，追加前就拒绝，不写入任何事件。
- **工具结果里的图片也能用引用**：AdRate 打算给模型一个「重新查看某张图」的工具，它返回引用，不再重复存一份字节；`liftToolImages` 照常生效。
- **折叠后能找回**：被折叠的图片（用户消息里的和工具结果里的）进入清单，`recall` 能取回；或者另给一个按引用取回图片的入口。形态由 reins 定。
- **token 估算**：引用形态下 reins 看不到字节，估算可能需要宽高。可以由 `put` 的 meta 或 part 自带 `width` / `height`，具体由 reins 定；也请顺带说明现在图片是怎么估算的。

### 边界

- 只加可选形态，内联 `data` 照旧可用，老事件不受影响。
- 确定性：事件里存的是引用，blob 写入后不可改，续跑的原文校验依然成立。如果「媒体不外溢」原本就是为续跑校验或别的原因刻意设计的，请说明。
- 会话分叉（fork）后，引用的 blob 归属哪个会话、校验时怎么判，由 reins 定。
- 视频 / 音频要不要一起做，由 reins 定。AdRate 目前只需要图片。

### 对 AdRate 的影响

- 不阻塞其他二期工作。A12 等这一条发版后再实施，发版前 AdRate 先做前端上传交互、暂存区，以及单张大小和张数上限的实测。
- 生命周期 AdRate 这边已经覆盖：会话的物理清理按 `session_id` 在同一个事务里删除 `reins_events` / `reins_blobs` / `reins_runs`。
- 预上传在 AdRate 侧处理：用户粘贴时先传到 AdRate 自己的暂存区，发送时再 `put` 进 `BlobStore`。所以不需要 reins 支持「会话还没有事件时先 `put`」。如果 reins 本来就允许，请告知，AdRate 可以省掉一次搬运。
- **AdRate 实测供参考（2026-11-24，DeepSeek 官方 `deepseek-flash`）**：单图 token 随尺寸增长，长边 768 ≈ 240、1024 ≈ 420、1568 ≈ 940，长边 2048 及以上恒 ≈ 960（服务端缩图）；core 现按每图固定 1600 估算，偏高约 1.6 倍，方向安全。一条请求带 20 张图（约 21MB）照常返回。

### reins 回复（2026-11-24）

采纳，分两步做完。第一步（折叠后能找回）已随 `12d9343` 落地；两步于 2026-11-24 一起发布（v0.20.0）：core 0.16.0、brain 0.10.0、server 0.9.0、lowering-fetch 0.7.0、lowering-pi 0.5.0、adapter-tanstack-ai 0.5.1，其余依赖 core 的包各出 patch（agent 0.7.3、eval 0.4.12、store-pg 0.5.3、store-sqlite 0.3.14、tools-mcp 0.4.3、ui-agui 0.7.1）。它们对 core 是精确版本依赖，AdRate 用到的 `@reinsjs/*` 要一起升。

- **用法**：`blobs.put(原始字节, { mime, sessionId })`（传字节，不要传 base64 串），再发 `{ type: "image", mime, blobId }`，`mime` 要与 put 时一致。内联 `data` 照旧可用，同一条消息里可以混用。
- **可以先 put**：`put` 不检查会话是否已有事件，新会话可以先 put 再发第一条消息，暂存区那次搬运可以省掉。
- **模型看到的不变**：每次调模型前，循环把视野内的引用换回内联，请求体与内联写法逐字节相同（三条 fetch 线与 pi 版都有用例锁住）；被折叠的图一个字节都不读；同一张图一个 run 只读一次。`liftToolImages` 照常生效。
- **写入前校验（fail-closed）**：起步 input、run 中途投递、工具结果、HTTP 四个入口用同一个函数。不存在、属于别的会话、`mime` 与 blob 不一致、没配 BlobStore，一律回同一句 `Blob <id> not found in this session`，不给探测别的会话的机会。HTTP 回 400、一条不写，进行中投递也在入箱前判（不会先回 202 再让 run 报错）；校验时存储故障回 503。工具结果里不合规的只换掉那一段，其余内容照留。
- **折叠后能找回**：清单与 `recall({ seq })` 照第一步；取回的结果里仍是引用，不重复存字节。**不需要"重新查看某张图"的工具**：模型给不出 blobId（降级层不把它给模型），要重看就是 `recall`。如果 AdRate 仍想做这个工具，它返回引用即可，走工具结果那道校验。
- **token 估算**：每张图固定 1600，与字节、宽高无关，引用形态不变，不需要宽高。按 AdRate 的实测偏高约 1.6 倍，方向安全。
- **"媒体不外溢"的原因**：只是上下文层面的取舍（一张图对模型是固定开销，没有分页读的意义），与续跑校验无关，续跑签名不算消息内容。改成引用不影响续跑。
- **fork**：只复制事件，blob 不复制、归属不变。子会话凭"本会话时间线已图片引用过"使用父会话的图；按 `session_id` 物理清理父会话后，子会话里这些图在模型那边变成 `[image unavailable]` 占位，run 照跑。
- **取不到时**：blob 已被删（或没配 BlobStore）落 `[image unavailable]` 占位、记 lossy；其它存储错误按模型调用失败处理（瞬断会重试），不会让模型对着占位作答。
- **前端显示**：handler 不下发字节。server README「Images by reference」给了一段下发路由配方：先过 AdRate 自己的会话鉴权，再用 `blobUsableBy` 判（不要只比 `meta.sessionId`，否则 fork 出的会话显示不了父会话的图）。blob 写后不改，可以长缓存。
- **请留意**：
  - **不能回滚**：`core.user_message` / `core.tool_result` 升为 schema v2（v1 读出时恒等升级），0.16 写过的会话 0.15 及以前读不了。全实例同时升级。
  - **进程内宿主的中途队列**：`pullInput` 拉到一条引用失效的消息，run 以 error 收口（与形状不合规同口径）；那条消息若还留在 AdRate 的队列里，下一个 run 会再拉到、再失败。HTTP 投递在入箱前就 400，不受影响。
  - 只做了图片。视频 / 音频仍是内联，等有真实样本再按同一套机制扩展。
- **验证**：全部假模型（引用只是存储形态，模型看到的请求逐字节相同），`pnpm check` 与构建产物自检全绿；发版前另起 PG 16.13 真库跑全量（2196 条过），发后在空目录从 npm 官方源安装，冒烟 7/7。独立审查拦下两处缺陷，均已修复并补用例（变异核对能拦住旧写法）：TanStack 路径曾能把别的会话的 blobId 写进日志（AdRate 不走这条路径）；校验缓存只按 blobId 放行，同一张图换个 `mime` 能写进日志。
- **请核实**：升级后在测试服贴两张图 → 让模型整理（折叠）→ `recall` 取回，看模型能否描述图片内容；查事件表里该会话的 `data` 不含 base64；再用别的会话的 blobId 发一次，应得 400 与上面那句话。


## AdRate 建议 18：图片引用的读取改为并发，写入校验只读元信息

### 现状（core 0.16.0 / server 0.9.0）

- **换回内联是逐张串行读**：`hydrateImageRefs` 对视野内的图片引用逐个 `await loadImage(...)`（`dist/index.js` 约 730～760 行）。run 级缓存保证同一张图一个 run 只读一次，但第一次模型请求前，视野内没进缓存的图是一张一张读的。
- **写入校验也是串行，而且读的是整份字节**：`checkImageRefs` 逐个 `await blobs.get(...)`，拿到字节后其实只用到 `meta`（判归属、比 mime），字节顺手放进缓存。
- **同一条消息的新图会被完整读两遍**：HTTP handler 预校验用的是一份新的空缓存（server `dist/index.js` 约 533 行 `cache: new Map()`），run 起步时 `runLoop` 再用自己的 `imageCache` 校验一次 input（core 约 1684～1692 行）。两份缓存不相通，所以一条带 N 张新图的消息，起跑前要串行读 2N 次整份字节，然后视野里的旧图再串行读一遍。

### 问题（AdRate 实测）

AdRate 把图片字节放在对象存储（Cloudflare R2），宿主机房在欧洲，`BlobStore` 由宿主实现，读的是 R2。在生产机上用 10 个 250～460KB 的现有对象实测 `GetObject`（读完整个 body）：

| 读法 | 10 张合计 | 单张 |
|---|---|---|
| 串行，冷连接 | 7.7s | 590～1070ms |
| 串行，热连接 | 4.3s | 355～630ms |
| 10 张并发 | 0.38s | 270～385ms |

单流吞吐只有约 1MB/s，并发几乎不叠加延迟。按现在的读法：

- 用户发一条带 10 张截图的消息（AdRate 上限就是每条 10 张，压缩后每张约 0.5～0.7MB），起跑前串行读 20 次，首字前要多等大约 **10 秒以上**。
- 会话里已有几张图时，之后每条消息都要再串行读一遍视野内的图，每张多 0.4～0.8 秒。

PG 版的 `BlobStore` 和本机存储的宿主不容易察觉这个问题，但凡 `BlobStore` 背后是对象存储或网络存储，都会碰上。

### 建议形态（供参考，形态由 reins 定）

1. **并发读取**：`hydrateImageRefs` 先收齐视野内还没缓存的、去重后的 `blobId`，并发 `get`，再按原顺序换回。`checkImageRefs` 也一样。并发数设一个上限（比如 8），可配置。错误语义不变：`not_found` 照样落占位或回 `Blob <id> not found in this session`，其他存储错误照样按模型调用失败或 503 处理。多张同时失败时，取哪一个错误由 reins 定。
2. **写入校验只读元信息**：给 `BlobStore` 加一个可选的 `meta?(id): Promise<BlobMeta>`（或 `head`），没有 `not_found` 时抛错，语义同 `get`。宿主实现了它，`checkImageRefs` 就只取元信息，不下载字节；没实现就退回 `get`，与现在一样。AdRate 的元信息存在自己的登记表里，读一行 DB 就够，不用碰 R2。
3. **（可选）handler 预校验与 run 共用结果**：如果第 2 条做了，预校验只读元信息，代价很小，可以不改。如果不做第 2 条，请考虑让 handler 预校验读到的字节传进 run 的缓存，至少别让同一张新图读两遍。

### 边界

- 不改事件形态，不改模型看到的请求。只改读取的顺序和次数，请求体仍逐字节相同。
- 缓存仍然按 run，不要求 reins 跨 run 缓存。跨 run 要不要缓存，由宿主在自己的 `BlobStore` 里决定（字节不可变，宿主做起来是安全的）。

### 对 AdRate 的影响

- A12 选定存 R2（宿主自实现 `BlobStore`：图片走 R2 + 登记表，其他外溢仍走 store-pg）。这一条决定带图消息的首字延迟：做完第 1 条，视野内无论几张图大约只多 0.4 秒；做完第 2 条，新消息的校验基本不碰 R2。
- 不阻塞 A12 其他准备，实施时一起升级。

### reins 回复（2026-11-24）

采纳第 1、2 条，第 3 条不需要做。随 v0.21.0 发布：core 0.17.0、server 0.10.0、store-pg 0.6.0、store-sqlite 0.4.0，其余依赖 core 的包各出 patch（agent 0.7.4、brain 0.10.1、eval 0.4.13、lowering-fetch 0.7.1、lowering-pi 0.5.1、adapter-tanstack-ai 0.5.2、tools-mcp 0.4.4、ui-agui 0.7.2）。它们对 core 是精确版本依赖，AdRate 用到的 `@reinsjs/*` 要一起升。

- **并发读取**：写入校验与换回共用一个读取池：先收齐未缓存的、去重后的 blobId，并发读，再按原顺序判定或换回。上限定为 **16、不开配置**：AdRate 每条最多 10 张，一波就能读完，同时防止长会话视野里几十张图一次全打出去。要更低的上限，请在 AdRate 自己的 `BlobStore` 里限流。起步 input 和一次 `pullInput` 拉到的全部消息合成一批，工具结果整条一起预读。
- **多张同时失败**：按片段顺序（换回时按视野顺序）报第一个，与哪张先失败无关。全部合规时结局与串行逐张读完全一样，只是快了。
- **只读元信息**：`BlobStore` 加了可选的 `stat(id): Promise<BlobMeta>`（建议里叫 `meta` / `head`，我们取 `stat`）。**它只给 HTTP 预校验用**；run 内写入前的校验仍用 `get`，读到的字节进 run 缓存、换回时直接用。原因有两条：新图马上要换回内联，run 里先 `stat` 一波再 `get` 一波，反而多一次往返；而且最终裁决与发给厂商的字节必须出自同一次读取。若登记表与 R2 对象不一致（比如 mime 记错），只按登记表判就会让引用写进日志，之后每轮都被厂商 400，会话卡死。所以一条带 N 张新图的 HTTP 消息：预校验 `stat` N 次（读登记表），run 内 `get` N 次（读 R2），换回 0 次。没实现 `stat` 时是 `get` 2N 次，但两波都是并发的。
- **第 3 条**：预校验改为只读元信息后，共用结果几乎没有收益，还要给循环配置加一个跨层的公开字段，所以不做。另外顺手修了一处：开着 `midRunInput` 且会话里没有在跑的 run 时，handler 会把同一批引用校验两遍，现在只校验一遍。
- **请留意**：
  - AdRate 的 `stat` 读登记表。登记表必须与 R2 对象同批写入，`sessionId` / `mime` 要与 put 时一致。不一致时以 `get` 为准，这条请求会从 400 变成 200 + error 帧，不会写进日志。
  - 对象不存在时 `stat` 必须**抛 `StoreError("not_found")`，不能返回 null**（照 R2 `head()` 的习惯很容易写成返回 null）。reins 对返回非对象的情况也按"不存在"处理，避免泄露别的会话的 blob 是否存在，但请照合同写。请用 `@reinsjs/core/testing` 的 `blobStoreConformance` 跑一遍自己的实现，新加的那条会检查这两点。
  - 行为变化：同一条工具结果里同一张图出现两次、读取瞬断时，现在两段都回 storage error（这张图只读一次）。一批里出了第一个问题后，剩下的引用也会被读（并发读），所以失败场景下的读取次数会比以前多。
- **验证**：全部用假模型与带延迟的计数存储测，判据是"耗时 < 2 倍单次延迟"和在途峰值，不看墙钟绝对值。覆盖：10 张一波读完、40 张时在途峰值 16、去重、失败顺序、返回 null、`stat` 与 `get` 不一致、HTTP 读取次数（有 / 无 `stat`）、合批入口、工具结果。把并发上限改成 1 做变异核对，并发那几条用例会挂。`pnpm check` 全绿；发版前在 PG 16.13 真库上跑全量（2225 条通过）。发布后在空目录从 npm 官方源安装，冒烟 8/8：只有一份 core；内存、SQLite、PG 三个存储的一致性套件（含 `stat`）全过；40 张图同时在读最多 16 张；HTTP 发 3 张新图，`stat` 3 次、`get` 3 次。
- **请核实**：升级后在测试服发一条带 10 张新图的消息，看首字延迟（预期比现在少约 10 秒）。

## AdRate 建议 19：AG-UI 帧带上图片引用，前端能显示用户发过的图

### 现状（ui-agui 0.7.2 / core 0.17.0）

- 用户消息里的图片引用 `{ type: "image", mime, blobId }` 已能写进事件日志，模型侧完整（建议 17）。
- 但 `@reinsjs/ui-agui` 把 `core.user_message` 编成 AG-UI 帧时，`partsToText` 把每张图换成一行文字占位 `[image <mime>]`，`metadata.reins.dropped` 里只记 `image:<mime>`，**不带 `blobId`**（`dist/index.js` 约 35～55、65～77 行）。`core.tool_result` 同样经 `partsToText`，`TOOL_CALL_RESULT` 也只剩占位。
- `@reinsjs/agent` 的 `createAgent` 缺省用 `aguiEncoding()`，GET 补发历史与 POST 实时流都走它。

### 问题

AdRate 前端按 AG-UI 帧建会话时间线。用户发了图之后：

- 实时流与刷新后补发的历史里，用户气泡只能显示文字 `[image image/jpeg]`，看不到自己发过的截图；
- 前端拿不到 `blobId`，也就无法去宿主自己的鉴权路由取图（server README「Images by reference」建议的显示方式需要这个 id）；
- 若前端按占位文字去猜，与用户恰好打出的同样文字无法区分。

宿主可以替换 `encode` 自己包一层补上，但等于在宿主里改 reins 的编码，每次升级都要跟着核对。凡是用 ui-agui、又让用户发图的宿主都会碰到，放在 reins 里做更合适。

### 建议形态（供参考，形态由 reins 定）

1. **用户消息的 `TEXT_MESSAGE_START` 带上不含字节的内容片段**：例如 `metadata.reins.parts`，按原顺序列出 `{ type: "text", text }` 与 `{ type: "image", mime, blobId }`；内联图片（带 `data`）只给 `{ type: "image", mime }`，**永不输出字节**。前端有它就按片段渲染（文字 + 图片位置），没有它就照旧读 `TEXT_MESSAGE_CONTENT`。
2. **文字占位保持不变**：`TEXT_MESSAGE_CONTENT` 照旧带 `[image <mime>]`，不认识新字段的前端行为不变。
3. **（可选，一致性）`TOOL_CALL_RESULT` 同样带上片段**：工具结果里的图片引用（如 MCP 返回的截图）也能被前端显示。AdRate 这一期只用用户消息，这条可以按 reins 的节奏做。

### 边界

- 只加只读的附加信息，不改事件日志、不改模型请求、不改现有帧的字段与顺序。
- 只输出 `blobId` 与 `mime`，不输出字节、不输出存储位置。取图由宿主路由按 README 的方式鉴权（会话归属 + `blobUsableBy`）。

### 对 AdRate 的影响

- A12 的会话页依赖它：用户气泡按片段显示缩略图，点开看大图，图片走宿主鉴权路由（按 `blobId` 取）。
- 不阻塞 A12 方案与后端实施，前端显示已发图片的那一批需要它，实施时与 core 0.17 一起升级。

### reins 回复（2026-11-24）

采纳第 1、2、3 条，形态稍有调整。待发布：ui-agui 0.8.0，agent 随依赖出 patch（0.7.5）；core 不变。AdRate 用 `createAgent` 的话把这两个包一起升。

- **字段**：`metadata.reins.parts`，按原顺序列出 `{ type: "text", text }`；图片引用是 `{ type: "image", mime, blobId }`；内联的图片、视频、音频只给 `{ type, mime }`，永不带字节；工具卡片（`tool_reference`）按正文的写法转成文字。只在消息里有图片、视频或音频时才出现（与 `dropped` 同出同缺），纯文字消息不带。`TEXT_MESSAGE_CONTENT` 的占位文字、`dropped`、帧的类型与顺序都不变。
- **位置有一处与建议不同：用户消息的 `TEXT_MESSAGE_START` 和 `TEXT_MESSAGE_END` 都带**，而且是同一份完整的 `metadata.reins`。原因：AG-UI 客户端（`@ag-ui/client`）把一条消息几帧的 metadata 合并时，同名的顶层键是"后到的整个替换前面的"，只挂在 START 上，到 END 就被冲掉了。审查时发现这个问题早就存在：进行中投递用来对账的 `provenance` 也只挂在 START 上，按 `messages` 状态渲染的前端一直拿不到。这次一并修了。AdRate 前端若是按原始帧读，START 上本来就有；若是用 AG-UI 客户端拼好的消息，现在也有了。
- **工具结果（第 3 条）这次一起做了**：`TOOL_CALL_RESULT` 只有一帧，`parts` 与 `isError` / `spilled` 并存。两边共用同一个函数，只做一边反而要留一处没有道理的差异。自己写编码器的宿主可以直接用导出的 `displayPartsOf(content)`。
- **请留意**：
  - `blobId` 到了浏览器，但它本身不给权限。取图路由的三道检查缺一不可：先过会话鉴权，再用 `blobUsableBy`，最后看 `meta.mime` 是否以 `image/` 开头。`blobUsableBy` 对本会话自己的任何 blob 都放行，包括外溢的文本 blob，而外溢 blob 的 id（`spilled.blobId`）和图片 id 出现在同一个 `metadata.reins` 里。server README 的配方里已经有 mime 检查，请别删。
  - AdRate 的 `BlobStore` 不要用 R2 的对象路径或签名 URL 当 id。
  - 以下情况前端要能退回占位显示：内联图片没有 `blobId`；blob 被保留策略清掉后路由回 404。`blobId` 当作不透明字符串，拼进 URL 时要 `encodeURIComponent`。
  - 行为变化：带 `provenance` 或带媒体的用户消息，`TEXT_MESSAGE_END` 现在多了这些字段；依赖"END 只有 seq / eventId / type"的前端代码需要调整。
- **验证**：全部用假数据测，不涉及真模型。覆盖：混排顺序、纯文字不带字段、内联字节（用独特标记串）在所有帧里都搜不到、畸形片段只出白名单字段、工具结果三个字段并存、用 `@ag-ui/core` 官方 `mergeMetadata` 把三帧折叠一遍后字段还在、正文块还开着时到达带图消息、经 server 实际 POST 再 GET 补发两条路径的帧相同且带 `blobId`。做了三项变异核对（去掉挂 `parts`、END 退回只带基础字段、视频带出 `durationSec`），测试都能抓到。`pnpm check` 全绿。
- **请核实**：升级后在测试服发一条带图的消息，看实时流里和刷新后的用户气泡是否都显示缩略图、点开能看大图。
