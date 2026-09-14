# spikes — 进代码前的核实脚本

> 这些脚本只是证据，不是产品代码；不在 pnpm workspace 内，不参与 `pnpm check`。
> 结论已写入 `docs/DECISIONS.md`，脚本留下是为了将来上游升级时能一键复核。

| 目录 | 对应任务 | 运行 | 结论摘要 |
| --- | --- | --- | --- |
| `gateway-check/` | T7 附带 | `node spikes/gateway-check/probe.mjs <messages\|chat\|responses>` | 聚合网关 aireiter.com 三协议核实：依赖特性全部标准；伪造 thinking 签名 / encrypted_content 被接受，说明网关不校验历史推理块。详见目录内 README |
| `t7-live-roundtrip/` | T7 | 仓库根 `pnpm build`，然后 `ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node spikes/t7-live-roundtrip/live.mjs` | 真实联网跑两轮：模型调工具 → 回传结果 + 中途 system_note → 回放上一轮 thinking 再作答。单测已用假 fetch 覆盖请求体与响应；此脚本用于带 key 的最终核实 |
| `b1-perception-cache/` | B1 | 仓库根 `pnpm build`，然后 `REINS_GATEWAY_BASE=… ANTHROPIC_API_KEY=… node spikes/b1-perception-cache/measure.mjs anthropic <标签>`；`summarize.mjs` 汇总 | 分档感知注入对 prompt cache 的实测：Anthropic 不注入 91.8%~93.3%，默认档位 92.9%、每轮变档 93.9%，不降；OpenAI 亦不降。顺带比较殿后 system_note 的三种断点处置，定缺省 `automatic`。详见目录内 README |
| `b2-compact-live/` | B2 | 仓库根 `pnpm build`，然后 `node spikes/b2-compact-live/run.mjs [natural\|pressured\|asked\|all]`（`REINS_B2_WINDOW` 改声明窗口）；密钥自动从信息文件读 | compact 工具在 claude-opus-5 上的核实：入参全合法；整理后请求（摘要 user 文本 → assistant thinking+tool_use → 回执）与阈值兜底摘要都被接受；抓到"最近一条用户消息被折进摘要"的缺陷并改为缺省幸存。详见目录内 README |
| `aireiter-gateway-check/` | B2 附带 | `node spikes/aireiter-gateway-check/probe.mjs` | 暗号法 + DeepSeek 直连对照：aireiter 的 Claude 端点会改写请求，最后一条 user 正文之后的一切（末尾中途 system、末尾 user、问题之后的文字）都丢，中途 system 在中段被换成 "Continue"，末尾被换成 "OK" + "."；顶层 system 与历史中段可达。DeepSeek 直连七种落点全到。详见目录内 README |
| `deepseek-anthropic-check/` | B1 附带 | `node spikes/deepseek-anthropic-check/probe.mjs` | DeepSeek 的 Anthropic 兼容端口：块级 / 顶层 `cache_control`、中途 system、thinking + 工具全部接受；自动缓存翻译成 `cache_read_input_tokens`（`cache_creation` 恒 0），不认断点位置，所以只能作第二家上游的兼容性与"注入不降命中"对照，不能替代官方 Anthropic。详见目录内 README |
| `edge-runtime-check/` | 发布前核实 | 仓库根 `pnpm build`，然后 `NO_PROXY=127.0.0.1,localhost node spikes/edge-runtime-check/run.mjs [--live]` | Cloudflare workerd 运行时兼容性：lowering-pi 的 **dist** 四层探测 × 三档配置 12 格全过，**不需要 `nodejs_compat`**，两条协议路径各自真打过线上 API。判据取最严档（2023 compat date，`process` / `Buffer` 不存在）。密钥自动从信息文件读。**2026-09-10 P1 追加 `/mcp` 探测**（`@reinsjs/tools-mcp` dist 在 workerd 里连本地假 MCP 服务器 `fake-mcp.mjs` 做 list + call，服务端用 `createMcpHandler` 按请求建实例）与 `--only-old`（只跑最严档）：最严档 load / mcp / fake 全过。详见目录内 README |
| `mcp-removed-tool-history/` | P1 ⑧ | 仓库根 `pnpm build`，然后 `node spikes/mcp-removed-tool-history/probe.mjs`；密钥自动从信息文件读 | 历史含已移除工具的 tool_use / tool_result 时：DeepSeek（Anthropic 协议直连）与 aireiter gpt-5.5（OpenAI Responses）在"工具表里有别的工具"与"工具表为空"两个变体下都接受且模型正确作答、只列当前工具；aireiter 的 Claude 端点两变体都回 "stream ended without a stop reason"（网关改写截断，非协议拒绝）；官方 Anthropic 直连未测。结论：平台不需要"删工具新会话生效"的不对称规则；判据是模型产出而非状态码 |
| `d1-lazy-tools-cache/` | D1 | 仓库根 `pnpm build`，然后 `node spikes/d1-lazy-tools-cache/measure.ts <relay\|deepseek> [eager\|lazy\|all]`；密钥自动从信息文件读 | 200 件工具、同会话 6 个任务、eager vs lazy 两臂：Claude 官方 API 上每次取回工具后的第一个请求缓存**整段重写**（7 次变动 = 7 个 read 0 的请求），未加权总 token −37% 但按价目加权贵 1.7 倍（最坏情形：每个任务都换工具表）；DeepSeek 自动缓存保住系统提示那段、其余重算，总 token −40%、加权打平。粗算一次取回要约 7 个后续请求回本；长任务赢、频繁换任务亏。详见目录内 README |
| `s1-mid-system/` | S1 | `cd spikes/s1-mid-system && pnpm i --ignore-workspace && pnpm start` | pi-ai 0.85.1 无 system 角色，只把注入内容当 user 发出；用其公开的 `onPayload` 钩子可改写为 Anthropic 官方支持的中途 `role:"system"` 文本消息，摆放规则需降级层保证 |

## S1 实测输出（2026-09-08，pi-ai 0.85.1，模型 claude-opus-5）

```
=== A. pi-ai 原样降级 ===
anthropic-beta 头： mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01
system 字段： [{"type":"text","text":"你是代码评审员。","cache_control":{"type":"ephemeral"}}]
  {"role":"user","content":"请评审这个函数。"}
  {"role":"assistant","content":[{"type":"text","text":"看起来没问题。"}]}
  {"role":"user","content":"[[reins:system_note]]从现在起，所有建议必须带显式类型标注。"}
  {"role":"user","content":[{"type":"text","text":"再看一遍。","cache_control":{"type":"ephemeral"}}]}
  {"role":"system","content":[],"output_config":{"effort":"high"}}
→ 出现 role:system？true（仅 effort 专用、content 为空）；messages 条数 5

=== B. onPayload 改写为中途 system ===
  {"role":"user","content":"请评审这个函数。"}
  {"role":"assistant","content":[{"type":"text","text":"看起来没问题。"}]}
  {"role":"system","content":[{"type":"text","text":"从现在起，所有建议必须带显式类型标注。"}]}
  {"role":"user","content":[{"type":"text","text":"再看一遍。","cache_control":{"type":"ephemeral"}}]}
  {"role":"system","content":[],"output_config":{"effort":"high"}}
→ 改写成功；但 system 后紧跟 user 违反官方摆放规则（须后接 assistant 或收尾），降级层需归位
```

S2~S4 是读上游源码与文档得出的结论，无需脚本，见 DECISIONS.md 对应行。
