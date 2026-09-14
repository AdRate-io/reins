/**
 * approval 模块给模型的规则提示（技术方案 §9.7）。
 *
 * 只说模型需要知道的两件事：有些调用要等人批（run 会暂停，不是出错）；被拒的调用不要换个写法再试。
 * 英文：与其他模块的规则片段一致，规则提示对英语模型最稳；宿主可用 `rules` 选项替换或关闭。
 */
export const APPROVAL_RULES = `Tool permissions:
- Some tool calls require human approval before they run. When that happens the run pauses until a person decides; this is normal, not an error. Do not repeat the call while it is waiting.
- A call may be denied by policy. A denied call returns an error naming the policy; do not retry it with the same or a disguised input. Explain what you were trying to do and ask the user how to proceed.`

/** 设了 `ttlMs` 时追加：过期的批准会被拒，模型可以再调一次重新发起审批（与"被拒别重试"区分开） */
export const APPROVAL_EXPIRY_RULE = `- An approval can expire if it arrives too late. The call is then not run and the error says so; unlike a policy denial, you may make the same call again to request a fresh approval.`
