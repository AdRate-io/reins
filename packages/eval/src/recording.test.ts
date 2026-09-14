/**
 * 去外溢与脱敏：用一段手搓的小录像验证分片拼回、缺口处理、逐字替换与命中统计。
 */
import {
  type CoreEventOf,
  type CoreEventPayloads,
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  type Event,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import {
  aliasTable,
  assembleChunks,
  jsonValuesAt,
  matchStrings,
  parseFetchChunk,
  scrubEvents,
  unspillRecording,
} from "./recording.js"

const S = "s1"
const registry = createCoreRegistry()
let seq = 0
let n = 0
const ev = <T extends CoreEventType>(draft: {
  type: T
  actor: Event["actor"]
  payload: CoreEventPayloads[T]
}): Event => createCoreEvent(registry, { ...draft, sessionId: S, seq: ++seq, at: 1000 + seq, id: `e${++n}` })

const FULL = `{"ok":true,"data":"${"x".repeat(60)}"}`
const BLOB = "b-1"

function recording(opts: { gap?: boolean } = {}): Event[] {
  seq = 0
  const header = (start: number, end: number, tail: string) =>
    `[blob "${BLOB}": characters ${start}–${end.toLocaleString("en-US")} of ${FULL.length} (1 lines total)${tail}]\n`
  return [
    ev({
      type: "core.user_message",
      actor: "user",
      payload: { content: [{ type: "text", text: "go 7123456789012345678" }] },
    }),
    ev({
      type: "core.tool_call",
      actor: "model",
      payload: { toolCallId: "c1", name: "list", args: { advId: "7123456789012345678" } },
    }),
    ev({
      type: "core.tool_result",
      actor: "tool",
      payload: {
        toolCallId: "c1",
        name: "list",
        isError: false,
        content: [{ type: "text", text: "[too large] preview…" }],
        spilled: { blobId: BLOB, summary: "big" },
      },
    }),
    ev({
      type: "core.tool_call",
      actor: "model",
      payload: { toolCallId: "c2", name: "fetch_blob", args: { id: BLOB, start: 0, end: 40 } },
    }),
    ev({
      type: "core.tool_result",
      actor: "tool",
      payload: {
        toolCallId: "c2",
        name: "fetch_blob",
        isError: false,
        content: [
          {
            type: "text",
            text: `${header(0, 40, "; clipped to fit 10 tokens. Continue with start: 40.")}${FULL.slice(0, 40)}`,
          },
        ],
      },
    }),
    ev({
      type: "core.tool_call",
      actor: "model",
      payload: { toolCallId: "c3", name: "fetch_blob", args: { id: BLOB, start: 30 } },
    }),
    ev({
      type: "core.tool_result",
      actor: "tool",
      payload: {
        toolCallId: "c3",
        name: "fetch_blob",
        isError: false,
        content: [
          {
            type: "text",
            text: `${header(opts.gap ? 50 : 30, FULL.length, ". This is the end of the output.")}${FULL.slice(opts.gap ? 50 : 30)}`,
          },
        ],
      },
    }),
    ev({
      type: "core.model_text",
      actor: "model",
      payload: { text: "广告主 7123456789012345678 的 Acme 团队" },
    }),
  ]
}

describe("unspillRecording：从 fetch_blob 分片拼回外溢结果", () => {
  it("分片重叠也能拼齐；tool_result 换成全文、去掉 spilled；fetch_blob 对被删掉", () => {
    const r = unspillRecording(recording())
    expect(r.restored).toEqual([BLOB])
    expect(r.incomplete).toEqual([])
    expect(r.droppedFetches).toBe(2)
    expect(r.events.map((e) => e.type)).toEqual([
      "core.user_message",
      "core.tool_call",
      "core.tool_result",
      "core.model_text",
    ])
    const res = r.events[2] as CoreEventOf<"core.tool_result">
    expect(res.payload.content).toEqual([{ type: "text", text: FULL }])
    expect(res.payload.spilled).toBeUndefined()
    expect(res.payload.toolCallId).toBe("c1")
  })

  it("有缺口就不硬凑：原样保留并列入 incomplete；dropFetchBlob=false 时分片也保留", () => {
    const r = unspillRecording(recording({ gap: true }), { dropFetchBlob: false })
    expect(r.restored).toEqual([])
    expect(r.incomplete).toEqual([BLOB])
    expect(r.droppedFetches).toBe(0)
    expect(r.events).toHaveLength(8)
    const res = r.events[2] as CoreEventOf<"core.tool_result">
    expect(res.payload.spilled?.blobId).toBe(BLOB)
  })

  it("parseFetchChunk / assembleChunks 的边界：千分位、非头文本、长度不符", () => {
    const c = parseFetchChunk(
      `[blob "x": characters 23,421–39,980 of 39,980 (1 lines total). This is the end of the output.]\nabc`,
    )
    expect(c).toMatchObject({ id: "x", start: 23421, end: 39980, total: 39980, text: "abc" })
    expect(parseFetchChunk("plain text")).toBeUndefined()
    // 声明 0–3 但正文只有 2 个字符：不信
    expect(assembleChunks([{ start: 0, end: 3, total: 3, text: "ab" }])).toBeUndefined()
    expect(assembleChunks([{ start: 0, end: 3, total: 3, text: "abc" }])).toBe("abc")
    expect(assembleChunks([])).toBeUndefined()
  })
})

describe("scrubEvents：JSON 文本层逐字替换", () => {
  it("入参、结果、正文一起换；长串优先；命中数按规则顺序返回", () => {
    const events = unspillRecording(recording()).events
    const { events: out, hits } = scrubEvents(events, [
      ["7123456789012345678", "7000000000000000001"],
      ["Acme", "user_1"],
      ["Acme 团队", "Team 1"], // 更长，先换，所以上一条在正文里不命中
      ["nothing-here", "x"],
    ])
    const text = JSON.stringify(out)
    expect(text).not.toContain("7123456789012345678")
    expect(text).not.toContain("Acme")
    // id 在 user_message、tool_call 入参、model_text 各出现一次
    expect(hits).toEqual([3, 0, 1, 0])
    const call = out[1] as CoreEventOf<"core.tool_call">
    expect(call.payload.args).toEqual({ advId: "7000000000000000001" })
    // 结构字段没被碰
    expect(out.map((e) => e.seq)).toEqual(events.map((e) => e.seq))
  })

  it("含引号 / 反斜杠的值按 JSON 写法匹配，替换后仍是合法事件", () => {
    seq = 0
    const e = ev({ type: "core.model_text", actor: "model", payload: { text: 'name "A\\B" here' } })
    const { events: out, hits } = scrubEvents([e], [['"A\\B"', "X"]])
    expect(hits).toEqual([1])
    expect((out[0] as CoreEventOf<"core.model_text">).payload.text).toBe("name X here")
  })
})

describe("收集待脱敏的值", () => {
  it("aliasTable 去重保序；matchStrings 按正则；jsonValuesAt 能钻进工具结果里的 JSON 文本", () => {
    expect(aliasTable(["a", "b", "a", ""], (i) => `v${i}`)).toEqual([
      ["a", "v1"],
      ["b", "v2"],
    ])
    const events = recording()
    expect(matchStrings(events, /\b7\d{18}\b/)).toEqual(["7123456789012345678"])
    seq = 0
    const withJson = [
      ev({
        type: "core.tool_result",
        actor: "tool",
        payload: {
          toolCallId: "c9",
          name: "identity_get",
          isError: false,
          content: [
            {
              type: "text",
              text: '{"ok":true,"data":{"subject":{"nickname":"Acme"},"team":{"teamName":"AdRate 团队"}}}',
            },
          ],
        },
      }),
      ev({ type: "core.model_text", actor: "model", payload: { text: "not json {nickname: nope}" } }),
    ]
    expect(jsonValuesAt(withJson, ["nickname", "teamName"])).toEqual(["Acme", "AdRate 团队"])
  })
})
