# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成记录：M0 / M1 / M2 见 `docs/归档/2026-09-10-任务记录-M0-M2.md`；0.1 发前清单与发布见 `docs/归档/2026-09-14-任务记录-0.1发布.md`。

## 状态一句话

**0.1 已发布（2026-09-14，当前 0.1.1）**：11 个包在 npm 官方源 `@reinsjs/*`（总包 `@reinsjs/agent`；0.1.1 是只改文档的同号补丁，把 tarball 里的旧总包名改掉），源码在 GitHub `AdRate-io/reins`（Release v0.1.0），MIT，版权 NewRate Limited。760 个用例全绿。公开类型已冻结：改公开行为要走 changeset，破坏性变更升 minor。下一步从「0.1 之后」取。

## 0.2 候选（2026-09-14 AdRate 接入评估提出，按顺序；全是加法，不改已发布形状；细节见 DECISIONS 同日"AdRate 接入六条评估"）

- [ ] **D1 工具懒发现**：brain 第十个模块（形态照 skills：菜单进系统提示，`tool_find` 取回完整 schema 后该工具在后续轮可见；绑定表 `tools_bound` 仍 run 内固定，只是逐轮暴露不同子集）。动手前核实：逐轮变动请求工具集对 prompt cache 的影响（spike）；"模型能否靠菜单找到该用的工具"要过 eval（fixture 用 `examples/adrate/capabilities.json` 的 200 个工具造），无 eval 不默认开。消费 `Tool.lazy`
- [ ] **D2 handler 旁路观测钩子** `onEvent(event, ctx)`：只观测不改事件，给 HTTP 路径接 traceId / userId 打日志用（`agent.run()` 本身是生成器已可见，README 把这点写显眼）
- [ ] **D3 审批过期** `approval({ ttl })`：按 `approval_request` 时间戳，过期批准自动转拒绝并留 `approval_decision(by: "reins")`
- [ ] **D4 跨进程 run 登记**：`RunRegistry` 从类改成接口（handler 已有 `runs` 注入口），store-pg 出 advisory lock 实现；README 先写"多实例部署须提供共享登记表"红线。今天双实例只浪费一次模型调用、不坏数据（seq_conflict 兜底）
- [ ] **D5 脱敏配方入 README**（文档，不加接口）：工具结果在 `afterTool` 草稿上脱敏；其他事件包一层 `log.append`。若 AdRate 接入时包 store 太别扭，再考虑核心加极小的 `redactingLog(log, fn)` 助手
- 不做（记 DECISIONS）：规范化 JSON 序列化算 digest 以放开 jsonb——改的是状态格式，等真有"全库禁 json"硬约束再随版本一起升

## 0.1 之后（纯新增或有外部依赖）

- [ ] `@reinsjs/lowering-fetch` 零依赖降级层（装机 65 M 的 pi-ai 之外的可选项）——新包，不动已有接口
- [ ] 四环境验证：Bun / Deno / Vercel Edge 未实测（edge-runtime-check 只测了 Cloudflare workerd）——验证不改接口
- [ ] tools-mcp 后续：官方 Anthropic 直连对"历史含已移除工具"的接受度未测（无 key；DeepSeek Anthropic 协议与 OpenAI Responses 已实测接受）；OAuth 流程、sampling / elicitation / resources / prompts 待真需求
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做
- [ ] 运行时告警与构造期错误文案英文化（全包十几处字符串，含 memory / spill / budget / skills）——审查指出英文 README + 中文告警对非中文用户是死路；0.1 保持中文（DECISIONS 2026-09-13）

## 待 Boss 本人操作（不挡开发）

- [ ] npm 组织 `reinsjs` 目前只有 `adrate-io` 一个 owner；若要让别的账号也能发版，在 npmjs.com/org/reinsjs 邀请
