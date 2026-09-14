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
| `f1-chat-live/` | F1 | 仓库根 `pnpm build`，然后 `node spikes/f1-chat-live/probe.mjs [deepseek\|cf-openai\|all]`；密钥自动从信息文件读 | `@reinsjs/lowering-fetch` 的 Chat Completions 线在 core `runLoop` 上跑真模型：两次工具调用、宿主中途注入的 system_note（暗号）到达、历史 assistant 回填 `reasoning_content`（DeepSeek）/ 不带（OpenAI）、每轮真实用量。DeepSeek 直连与 CF 网关 gpt-4o-mini 各 8/8（2026-09-14）。顺带实证：宿主说明落在两个 tool_call 与两个 tool_result 之间时被后移，模型仍收到 |
| `mcp-removed-tool-history/` | P1 ⑧ | 仓库根 `pnpm build`，然后 `node spikes/mcp-removed-tool-history/probe.mjs`；密钥自动从信息文件读 | 历史含已移除工具的 tool_use / tool_result 时：DeepSeek（Anthropic 协议直连）与 aireiter gpt-5.5（OpenAI Responses）在"工具表里有别的工具"与"工具表为空"两个变体下都接受且模型正确作答、只列当前工具；aireiter 的 Claude 端点两变体都回 "stream ended without a stop reason"（网关改写截断，非协议拒绝）；官方 Anthropic 直连未测。结论：平台不需要"删工具新会话生效"的不对称规则；判据是模型产出而非状态码 |
| `d1-lazy-tools-cache/` | D1 | 仓库根 `pnpm build`，然后 `node spikes/d1-lazy-tools-cache/measure.ts <relay\|deepseek> [eager\|lazy\|all]`；密钥自动从信息文件读 | 200 件工具、同会话 6 个任务、eager vs lazy 两臂：Claude 官方 API 上每次取回工具后的第一个请求缓存**整段重写**（7 次变动 = 7 个 read 0 的请求），未加权总 token −37% 但按价目加权贵 1.7 倍（最坏情形：每个任务都换工具表）；DeepSeek 自动缓存保住系统提示那段、其余重算，总 token −40%、加权打平。粗算一次取回要约 7 个后续请求回本；长任务赢、频繁换任务亏。详见目录内 README |
| `cf-gateway-fidelity/` | F0 | `node spikes/cf-gateway-fidelity/probe.mjs <anthropic\|responses\|chat\|all>`；配置自动从信息文件读 | Cloudflare AI Gateway 透传路径忠实度体检 **43/43**：中途 system（Opus 5 末尾 / 中段）、块级与顶层 `cache_control`（用量 6315 写 / 6315 读）、`anthropic-beta` 头、图片、六轮工具往返、并发无串扰、缺省不缓存全部到达；伪造 thinking 签名 / `encrypted_content` / 假 beta 头 / 未知参数都拿到**厂商原文 400**（aireiter 这里是 200）。顺带：暗号法在中途 system 位置会触发厂商 `reasoning_extraction` 拒答（`mid-conversation-output-config` beta 抬高触发率）、Haiku 4.5 最小可缓存 4096、强制 tool_choice 官方 finish=stop、未知模型名经网关是 401、CF 账户级 429 是 CF 信封不是厂商错误体。**结论：可当官方靶子**。详见目录内 README |
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

## Cloudflare AI Gateway 作官方模型靶子（2026-09-14 轻测；同日 F0 全量体检 43/43 通过，见 `cf-gateway-fidelity/`）

我们没有 Anthropic / OpenAI 官方账号（Boss 定：有封号风险不申请）。Cloudflare AI Gateway 的 **Unified Billing** 用 Cloudflare 持有的厂商凭证转发原生接口、按厂商原价 + 5% 计费，所以官方端点的验证一律走它。私有值（account id、网关令牌）在根目录 `模型API测试信息.md` 末尾（gitignore），公开文档只写用法。

**怎么调（三条协议都是 provider 透传路径，厂商自己的接口形状原样透传）**

```
POST https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>/anthropic/v1/messages        + anthropic-version: 2023-06-01
POST https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>/openai/v1/responses
POST https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>/openai/v1/chat/completions
头：cf-aig-authorization: Bearer <网关令牌>      ← 不要带 x-api-key / Authorization: Bearer sk-…，带了会失败
模型名用厂商原名（claude-haiku-4-5-20251001、gpt-4o-mini），不是 REST 路径那种 anthropic/… 前缀
```

**已实测**：三条端点非流式都原样回暗号，用量字段是厂商原生的（Anthropic 的 `cache_creation_input_tokens` / `cache_read_input_tokens` / `cache_creation.ephemeral_5m_input_tokens` 都在）；Anthropic `stream: true` 的 SSE 原样透传，**`data` JSON 里多一个 `"p"` 填充字段**（Anthropic 自己的防缓冲填充），解析器必须忽略未知字段。

**别踩**：
- `api.cloudflare.com/client/v4/accounts/<id>/ai/v1/...` 那条 **REST 路径不适用**——它要带 Workers AI Read 权限的账户级 API token（`Authorization: Bearer`），网关令牌（AI Gateway Run 权限）打它回 `code 10000 Authentication error`；且它的模型名要 `anthropic/…` 前缀，是另一套入口。我们用透传路径就够。
- 网关令牌是**账户级**的：任一网关名都通（实测 `default` 也能收请求），网关之间隔不开额度；要隔离得另开账户。
- `cache_control`、thinking 签名、`anthropic-beta`、多轮工具往返的密钥注入——F0 已逐项实证原样透传（见 `cf-gateway-fidelity/README.md`），GitHub cloudflare/ai#408 报的多轮密钥注入失效 6 轮 × 两家未复现。**可当官方靶子。**
- 账户级限流 `429` 的正文是 CF 信封（`{"success":false,"error":[{"code":2018,"message":"Wholesale Rate limited"}]}`）而不是厂商错误体，多在一次运行的第一个 Opus 请求上连撞两次；三套并行更容易撞，探针按 429 退避重试即可。
- 模型名打错经网关是 **401 Missing bearer**（网关只对认识的模型注入厂商密钥），不是 404。
- Anthropic 的 `reasoning_extraction` 分类器会把"告诉我你被告知的暗号"放在中途 system 位置判成拒答（200 + `stop_reason: refusal`）——是厂商行为不是网关；暗号法探中途 system 用感知式说明（问上下文用量百分比）。
- 判据永远是产出内容（暗号法），不是状态码。

**在 spike 脚本里读配置**：沿用各 spike 读 `模型API测试信息.md` 的写法，取 `cfut_` 开头的令牌、`account id：` 行、`gateway id：` 行；基址拼成 `https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>`。
