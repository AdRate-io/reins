# examples/team —— 多角色团队：子代理即工具

任务 P3 的验收示例（技术方案 §10.1）。三个角色、一套 Postgres 存储、**不改 core**：专家就是编排者工具表上的一个 `Tool`。要不要叫专家、叫它做什么、结果信不信，都是编排者的模型在判断——库不做编排器（宪法一）。

| 文件 | 管什么 |
| --- | --- |
| `subagent-tool.ts` | **范式本体** `expertTool()`：把一个 `Agent` 包成 `Tool`，逐条标号示范手写时容易漏的五件事（见下）；`childSessionsOf()` 从父时间线找回子会话 id |
| `agents.ts` | 三个 `createAgent`：`analyst`（两个只读数据工具）、`writer`（品牌语气指南）、`lead`（编排者，工具表上只有 `ask_analyst` / `ask_writer`）。同一套 `pgStores`，记忆按 `namespace` 前缀分角色再分用户 |
| `run.ts` | 跑一条真实任务 → 审批逐条问（`--approve-all` 全批）→ 父会话与顺着结果找到的每个子会话各写一份 JSONL |
| `replay.ts` | **验收**：只凭父 JSONL 找到并校验每个子 JSONL，不要 key、不碰库 |
| `subagent-tool.test.ts` | 五件事的机制用例（脚本化降级层，确定性） |
| `data/catalog.json` | 8 个 SKU 的库存与六周销量 |

```bash
pnpm build
node examples/team/run.ts "下周要做一次清库存促销。请先让分析师找出最该清的 3 个 SKU……" --approve-all
node examples/team/replay.ts examples/team/recordings/<父会话 id>.jsonl
```

缺省模型 DeepSeek（`REINS_PROVIDER=aireiter` 换 Claude），密钥从仓库根《模型API测试信息.md》读；存储缺省 PGlite 文件库 `data/team.pgdata`，真 Postgres 把 `new pg.Pool(...)` 传给 `pgStores` 即可。

## 手写一个子代理工具要做对的五件事

`expertTool()` 的 `execute` 就是 `agent.run({ input: task, principal, signal })` 跑到底再把结果交给父模型，五处标号与代码一一对应：

1. **中止传递由使用者自决。** `abort: "linked"`（缺省）把父的 `ctx.signal` 传给子：父停子停，省钱。`abort: "detached"` 不传：父中止时子做完为止——循环层保证正在执行的工具跑完、结果落进父日志，父才 `paused(host)`。示例里"问分析师"是问答，用 linked；"交给文案"是接力，用 detached。联停与否是编排语义的一部分，不是库该替你定的。
2. **身份传递。** `principal` 原样下传。子会话的鉴权、以及记忆前缀 `(ctx) => /roles/analyst/users/${ctx.principal.id}` 才对得上——三个角色共用一张记忆表，靠前缀隔离；要按角色分表，`pgStores(client, { memoryTable })` 各建一套（P2）。
3. **时间线关联。** 子会话的 `sessionId` 写进父 `tool_result` 的 JSON（模型可见）。`replay.ts` 只凭父录像就能顺着它找到子录像；eval 同理。
4. **预算合算。** 子 run 的 `budget_usage` 记在子会话里，父的 budget 模块看不见。范式把子用量（请求数、token、工具次数）汇总写进父结果，让父模型与人都看得到。**已知缺口**：父的 budget 上限管不到子——0.2 的 `asTool` 助手做合算。
5. **审批。** 子 run 返回 `paused`（审批 / 预算 / 中止）时，工具**不**替人批、不自己循环，以 `isError` 把状态和原因交给父模型决定。信任边界收在父的工具表上：专家不装 approval 模块，专家的每个工具调用都算父的一次 `ask_*`；专家一旦带写工具，把 `ask_*` 的 `risk` 提到 high 让父侧问人。

深度守卫靠工具表：专家的工具表里没有 `expertTool` 类工具，所以不会无限套娃。每次调用一个全新的子会话；要与同一个专家多轮对话，把 `childSessionId` 回传做 `sessionId` 即可。

## 记忆隔离在这里长什么样

一张 `reins_memory` 表，三个角色、每个 principal 各一块。模型看到的永远是 `/memories`：

| 角色 | 存储键前缀 | 模型看到 |
| --- | --- | --- |
| lead | `/roles/lead/users/boss` | `/memories/...` |
| analyst | `/roles/analyst/users/boss` | `/memories/...` |
| writer | `/roles/writer/users/boss` | `/memories/...` |

角色不进事件、不进存储：哪个角色由"哪个 `createAgent`"已经决定（DECISIONS 2026-09-10「记忆隔离不加角色字段」）。

## 第一条真实任务

2026-09-10，DeepSeek deepseek-v4-flash，一次跑通、无人工干预（`--approve-all` 实际没有任何审批发生）。父录像 `recordings/01a089d5-6c80-73ad-8283-3eb5f08fe524.jsonl`，两份子录像同目录。

任务：找出最该清的 3 个 SKU（库存多、越卖越慢），按品牌语气写 80 字内七折文案，汇报表格、文案原文、每个专家的会话 id 与用量。

| 会话 | 事件 | 模型请求 | 工具调用 | 记忆 | tokens in + cache / out | 耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| lead（父） | 24 | 4 | 4（`memory` ×2、`ask_analyst`、`ask_writer`） | view + create `/memories/clearance-promo.md` | 6638 + 9216 / 2231 | 32 s 全程 |
| analyst（子，linked） | 31 | 3 | 10（`memory:view`、`list_skus`、`weekly_sales` ×8） | view | 3659 + 5248 / 1853 | |
| writer（子，detached） | 14 | 2 | 2（`brand_voice`、`memory:view`） | view | 2688 + 2432 / 871 | |

看到的模型行为：

- **编排者第一轮就并行**查自己的记忆与委派分析师；拿到 SKU 表后再委派文案，把三个 SKU、活动口径、字数限制**自包含**地写进任务（文案看不到父对话，这是范式要求的）。
- **分析师自己定了判据**（可售周数 = 库存 ÷ 近周均销）逐个 SKU 查了八次周销量，选出 J-201 / H-101 / S-301，并说明为什么排除库存最高但销量平稳的 A-401。
- **文案先读 `brand_voice`**，58 字，遵守"不用感叹号、点明清库存、只说一次折扣、结尾给行动"。
- **编排者照抄文案不改动**，末尾主动指出用户口径里"全场七折"与"仅限 3 个 SKU"自相矛盾，以及文案里露出了 SKU 编码——决策留给人。
- 编排者把结论写进了自己的记忆；库里的真实键是 `/roles/lead/users/boss/memories/clearance-promo.md`——前缀隔离按预期生效，两个专家只读了自己的（空）记忆没写。

`replay.ts` 验收：只凭父录像找到两份子录像，三份都通过 registry 读取与 seq 连续校验，父结果里的子用量汇总与子录像自算完全一致，退出码 0。

一个可改进处：编排者把两个专家的 `childSessionId` 原文写进了汇报和记忆——这是系统提示要求的，宿主 UI 若不想把内部 id 暴露给用户，把系统提示那句去掉即可，关联关系在 `tool_result` 里不受影响。

## 第二次真跑（同日，trust 标注落地之后，父录像 `recordings/01a089e3-1502-7077-b6bc-56d9f534ba8b.jsonl`）

R9 之后工具结果在线协议里被 `<untrusted source="tool:…">` 包住（日志里仍是原文，录像里一个标记字样都没有）。复跑同一任务验证行为不受影响，顺带看到了记忆跨 run 生效：

- 编排者先 `view` 自己上次留下的 `/memories/clearance-promo.md`，发现分析师这次的排名与记忆不一致（这次它把 A-401 排在了前面），**再问了分析师一次**，要它把"逐周单调下滑"当硬性条件重排——三个子会话（分析师 ×2、文案 ×1）都在父结果里可追溯。
- 最终交付明确写出"需你拍板的一处口径分歧"（按可售周数排 A-401 第一，按越卖越慢排 S-301 第三），把选择留给人；文案 46 字，对外不出现 SKU 编码（上次汇报里自己提的改进）。
- 父 40 事件 / 7 次请求，130 s；三个子会话 37 + 40 + 18 事件，`replay.ts` 全部找到、用量一致。
