# spikes — 进代码前的核实脚本

> 这些脚本只是证据，不是产品代码；不在 pnpm workspace 内，不参与 `pnpm check`。
> 结论已写入 `docs/DECISIONS.md`，脚本留下是为了将来上游升级时能一键复核。

| 目录 | 对应任务 | 运行 | 结论摘要 |
| --- | --- | --- | --- |
| `t7-live-roundtrip/` | T7 | 仓库根 `pnpm build`，然后 `ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node spikes/t7-live-roundtrip/live.mjs` | 真实联网跑两轮：模型调工具 → 回传结果 + 中途 system_note → 回放上一轮 thinking 再作答。单测已用假 fetch 覆盖请求体与响应；此脚本用于带 key 的最终核实 |
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
