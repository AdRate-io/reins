/**
 * S1 spike：pi-ai 0.85.1 对 Anthropic "中途 system 消息" 的支持现状，以及用 onPayload 补齐的可行性。
 *
 * 做法：用假 fetch 截获 pi-ai 发往 Anthropic 的请求体，不真正联网、不花钱。
 *  步骤 A：把 system_note 按 pi-ai 唯一可用的方式（user 角色）放进 Context，看 pi-ai 原样送出什么。
 *  步骤 B：在 onPayload 里把带标记的 user 消息改写成 {role:"system", content:[{type:"text"}]}，看最终请求体。
 */
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const MARK = "[[reins:system_note]]"; // 降级层内部标记，只在 onPayload 里消费，不会送到线上
const model = getBuiltinModel("anthropic", "claude-opus-5");

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const context = {
  systemPrompt: "你是代码评审员。",
  messages: [
    { role: "user", content: "请评审这个函数。", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "看起来没问题。" }], api: "anthropic-messages", provider: "anthropic", model: model.id, usage: zeroUsage, stopReason: "stop", timestamp: 2 },
    // 这就是 reins 的 system_note（perception 注入）：pi-ai 没有 system 角色，只能先当 user
    { role: "user", content: MARK + "从现在起，所有建议必须带显式类型标注。", timestamp: 3 },
    { role: "user", content: "再看一遍。", timestamp: 4 },
  ],
};

/** 假的 Anthropic SSE 响应，让 pi-ai 的流正常结束 */
function fakeSse() {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const body =
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }) +
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
    ev("message_stop", {});
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function run(label, onPayload) {
  let sent;
  let sentHeaders;
  const fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    sentHeaders = init.headers;
    return fakeSse();
  };
  const s = anthropicStream(model, context, { apiKey: "sk-test", fetch, onPayload });
  for await (const _ of s) { /* 排空 */ }
  console.log(`\n=== ${label} ===`);
  const beta = sentHeaders?.["anthropic-beta"] ?? sentHeaders?.get?.("anthropic-beta");
  console.log("anthropic-beta 头：", beta ?? "(无)");
  console.log("system 字段：", JSON.stringify(sent.system));
  for (const m of sent.messages) console.log(" ", JSON.stringify(m));
  return sent;
}

// 步骤 A：pi-ai 原样
const a = await run("A. pi-ai 原样降级");
const aHasSystem = a.messages.some((m) => m.role === "system");
console.log(`→ 出现 role:system？${aHasSystem}；messages 条数 ${a.messages.length}`);

// 步骤 B：onPayload 改写
const b = await run("B. onPayload 改写为中途 system", (payload) => {
  const messages = [];
  for (const m of payload.messages) {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === "text" ? m.content[0].text : null;
    if (m.role === "user" && text && text.startsWith(MARK)) {
      messages.push({ role: "system", content: [{ type: "text", text: text.slice(MARK.length) }] });
    } else {
      messages.push(m);
    }
  }
  return { ...payload, messages };
});
const bSys = b.messages.findIndex((m) => m.role === "system");
const okPlacement = bSys > 0
  && b.messages[bSys - 1].role === "user"
  && (bSys === b.messages.length - 1 || b.messages[bSys + 1].role === "assistant");
console.log(`→ system 位于索引 ${bSys}；满足官方摆放规则（前一条 user，后一条 assistant 或结尾）？${okPlacement}`);
console.log("   注意：本例中 system 后面紧跟 user，官方规则判为 400。真实降级层需要把 system_note 与下一条 user 的顺序调整为 user→system 或合并。");
