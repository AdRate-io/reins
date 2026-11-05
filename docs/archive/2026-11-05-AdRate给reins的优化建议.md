# AdRate 对 reins 的优化建议（2026-11-05）

> **来源**：AdRate（投放工具，reins 的 dogfood 宿主）在正式接入前，对照 reins `main@11c160f`（core 0.9.0 / server 0.4.3 / brain 0.8.2）核实出的问题。由 Boss 带到 reins 项目评估、实施、发版；AdRate 侧不写兜底代码，等发版后再调整接入方案。
> **编号**：「AdRate 建议 1～4」，与 reins 文档中的「OnSet 建议 N」同一用法。
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
