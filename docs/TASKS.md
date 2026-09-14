# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成记录：M0 / M1 / M2 见 `docs/归档/2026-09-10-任务记录-M0-M2.md`；0.1 发前清单与发布见 `docs/归档/2026-09-14-任务记录-0.1发布.md`。

## 状态一句话

**0.1.0 已发布（2026-09-14）**：11 个包在 npm 官方源 `@reinsjs/*`（总包 `@reinsjs/agent`），源码在 GitHub `AdRate-io/reins`（Release v0.1.0），MIT，版权 NewRate Limited。760 个用例全绿。公开类型已冻结：改公开行为要走 changeset，破坏性变更升 minor。下一步从「0.1 之后」取。

## 0.1 之后（纯新增或有外部依赖）

- [ ] `@reinsjs/lowering-fetch` 零依赖降级层（装机 65 M 的 pi-ai 之外的可选项）——新包，不动已有接口
- [ ] 四环境验证：Bun / Deno / Vercel Edge 未实测（edge-runtime-check 只测了 Cloudflare workerd）——验证不改接口
- [ ] tools-mcp 后续：官方 Anthropic 直连对"历史含已移除工具"的接受度未测（无 key；DeepSeek Anthropic 协议与 OpenAI Responses 已实测接受）；OAuth 流程、sampling / elicitation / resources / prompts 待真需求
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做
- [ ] 运行时告警与构造期错误文案英文化（全包十几处字符串，含 memory / spill / budget / skills）——审查指出英文 README + 中文告警对非中文用户是死路；0.1 保持中文（DECISIONS 2026-09-13）

## 待 Boss 本人操作（不挡开发）

- [ ] GitHub 仓库描述与 topics：`choodie-chen` 只有推送权限，请用 `AdRate-io` 账号在仓库 Settings 里填（描述可用根 package.json 的 description；topics 建议 agent、llm、typescript、event-sourcing、ag-ui、mcp）
- [ ] npm 组织 `reinsjs` 目前只有 `adrate-io` 一个 owner；若要让别的账号也能发版，在 npmjs.com/org/reinsjs 邀请
