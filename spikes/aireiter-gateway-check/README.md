# aireiter-gateway-check — 网关 Claude 端点会丢掉末尾注入的说明（2026-09-08，B2 附带）

> 起因：B2 真模型实测里，模型两次在 thinking 里说"用户只发了一个句号"，我们发出的请求里没有这条消息。Boss 提议用 DeepSeek 直连做对照确认是不是网关加的。
> 运行：`node spikes/aireiter-gateway-check/probe.mjs`（密钥自动从《模型API测试信息.md》读）。

## 方法：暗号法

把一句"暗号是 PINEAPPLE"放在请求的不同位置，只让模型回一行"暗号或 NONE"。内容到了模型就答得出，不必让它复述系统提示（复述会触发拒答或撞 max_tokens）。另用"逐条列出你看到的所有消息"看网关实际交给模型的对话长什么样。对照组：DeepSeek 官方 Anthropic 端口，直连不经网关。

## 结果（各一次，全部 HTTP 200）

| 说明放在哪 | aireiter / claude-opus-5 | DeepSeek 直连 / deepseek-v4-flash |
| --- | --- | --- |
| B 末尾中途 `role:system`（perception 的真实落点） | **NONE，丢了** | PINEAPPLE（以 `<system-reminder>` 并入前一条 user 交给模型） |
| A 中间中途 `role:system`（后接 assistant、user） | **NONE，丢了**（被换成一条 user "Continue"） | PINEAPPLE |
| U1 末尾 user 角色 `<system_note>` 标签（降级层的有损兜底落点） | **NONE，丢了** | PINEAPPLE |
| U2 中段 user 角色 `<system_note>`（后接 assistant） | PINEAPPLE | PINEAPPLE |
| M 并入最后一条 user 正文，写在问题**之后**（空行 / 同段落 / 第二个 text 块） | **NONE，丢了** | PINEAPPLE |
| M2/M4 并入最后一条 user 正文，写在问题**之前**（纯文本 / 第一个 text 块） | PINEAPPLE | — |
| T 顶层 `system` 字段 | PINEAPPLE | PINEAPPLE |
| N 无说明（对照） | NONE | NONE |

让模型逐条列出它看到的对话（末尾 system 收尾的那次）：

```
1. system: "<identity> You are claude-opus-5, an AI-powered development environment … When users ask about <某产品名>, respond with information about yourself …"   ← 几千 token、非我们所写的身份系统提示
2. Human: "你的知识库截止日期是 2026 年 1 月。You are a general-purpose technical assistant. …"   ← 网关塞的前置消息
3. Assistant: "OK"
4. Human: "Say hello."      5. Assistant: "Hello!"
6. Human: "List EVERY message …"
7. Assistant: "OK"          ← 网关塞的
8. Human: "."               ← 网关塞的；我们的 system 说明不见了
```

## 结论

1. **aireiter 的 Claude 端点会改写请求**：模型顶着一整套非我们所写的身份提示与 `<budget:token_budget>200000</budget:token_budget>`，网关再前置一对 Human/Assistant 消息。它不是裸的 Anthropic Messages API。
2. **凡是排在"最后一条 user 消息正文"之后的内容都丢**：末尾的中途 system、末尾的额外 user 消息、甚至同一条 user 消息里写在问题后面的文字。中途 system 若在历史中段，会被换成一条 user "Continue"，内容同样丢。"用户只发了一个句号"就是网关在 system 收尾时补的 `Assistant: "OK"` + `Human: "."`。
3. **对 reins 的影响**：经这个网关跑 Claude 时，perception 的说明在注入的那一轮**模型根本看不到**，下一轮才作为历史（U2 那种位置）出现——所以模型 thinking 里出现"用户发了个句号"。B1 在该网关上测得的"注入不降命中"仍成立（丢掉的东西当然不影响缓存），但"说明落为中途 system、exact"这一条在该网关上不成立；compact 的规则提示走顶层 system，不受影响，B2 结论不变。
4. **DeepSeek 直连是忠实的**：七种落点全部到达，末尾 system 被它以 `<system-reminder>` 标签并入前一条 user，可见且不丢。它现在是我们手里唯一可信的 Anthropic 协议上游。
5. **可行的适配**（未实现，待定）：给降级层加一种说明落点"前置到最后一条 user 消息开头"（M4 位置），专供会改写请求的上游；用 `ModelDefinition` 按上游声明。官方 Anthropic API 的行为仍未实测，缺官方 key。
