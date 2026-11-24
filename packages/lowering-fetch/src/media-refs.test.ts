/**
 * 图片引用形态在 fetch 版三条线上（2026-11-24 媒体引用方案）：
 * - 等价：同一张图用引用写法与内联写法跑真 runLoop，三条线发出去的请求体逐字节相等；能力位关（模型不收图）时也相等
 * - 取不到：日志里的引用没换回（blob 不在了），收图的模型落 `[image unavailable]` 占位、落点 lossy、run 照跑
 */
import {
  type ContentPart,
  createCoreEvent,
  createCoreRegistry,
  type Event,
  InMemoryBlobStore,
  InMemoryEventLog,
  type LandingRecord,
  type LoweredRequest,
  runLoop,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { FetchLowering } from "./lowering.js"
import { IMAGE_UNAVAILABLE, IMAGE_UNAVAILABLE_NOTE } from "./media.js"
import type { FetchApi, FetchModel } from "./models.js"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80, 0x7f])
const PNG_B64 = btoa(String.fromCharCode(...PNG))

const model = (api: FetchApi, images: boolean): FetchModel => ({
  provider: "acme",
  id: `m-${api}-${images}`,
  api,
  baseUrl: "https://acme.invalid/v1",
  contextWindow: 100_000,
  maxOutputTokens: 1000,
  reasoning: false,
  images,
})

const APIS: FetchApi[] = ["openai-chat", "anthropic-messages", "openai-responses"]

/**
 * 跑一次真 runLoop，截下第一次请求的请求体与落点；fetch 一律回 400（不重试），run 以 error 结束。
 * `prepare` 拿到这次的日志与 BlobStore，可先写历史、先 put 图，返回起步 input
 */
async function firstBody(
  m: FetchModel,
  prepare: (log: InMemoryEventLog, blobs: InMemoryBlobStore) => Promise<ContentPart[]>,
): Promise<{ body: string; landings: LandingRecord[] }> {
  const log = new InMemoryEventLog()
  const blobs = new InMemoryBlobStore()
  const input = await prepare(log, blobs)
  const lowering = new FetchLowering({
    apiKey: () => "k",
    models: [m],
    fetch: async () => new Response("no", { status: 400 }),
  })
  let captured: { body: string; landings: LandingRecord[] } | undefined
  const gen = runLoop({
    sessionId: "s1",
    log,
    blobs,
    lowering,
    model: { provider: m.provider, id: m.id },
    ...(input.length > 0 ? { input } : {}),
    onLandings: (_losses, request: LoweredRequest) => {
      captured ??= {
        body: JSON.stringify((request.payload as { body: unknown }).body),
        landings: request.landings,
      }
    },
  })
  for await (const _ of gen) {
    // 跑完即可
  }
  if (!captured) throw new Error("no request was built")
  return captured
}

describe("等价：引用写法与内联写法发出去的请求体逐字节相等", () => {
  for (const api of APIS) {
    for (const images of [true, false]) {
      it(`${api}，images=${images}`, async () => {
        const m = model(api, images)
        const inline = await firstBody(m, async () => [
          { type: "text", text: "看图" },
          { type: "image", mime: "image/png", data: PNG_B64 },
        ])
        const byRef = await firstBody(m, async (_log, blobs) => {
          const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
          return [
            { type: "text", text: "看图" },
            { type: "image", mime: "image/png", blobId: id },
          ]
        })
        expect(byRef.body).toBe(inline.body)
        // 不是空对空：收图时请求体里真有这张图，不收时是占位
        expect(inline.body.includes(PNG_B64)).toBe(images)
        expect(byRef.landings.map((l) => [l.kind, l.landing, l.note])).toEqual(
          inline.landings.map((l) => [l.kind, l.landing, l.note]),
        )
      })
    }
  }
})

describe("取不到：没换回的引用落占位、记 lossy", () => {
  const registry = createCoreRegistry()
  /** 以前的 run 写下的用户消息，引用的 blob 已不在 */
  const gone = (content: ContentPart[], seq: number): Event =>
    createCoreEvent(registry, {
      type: "core.user_message",
      payload: { content },
      actor: "user",
      sessionId: "s1",
      seq,
      at: 1,
      id: `e${seq}`,
    })

  for (const api of APIS) {
    it(`${api}：user_message 里的引用 → 占位 + lossy`, async () => {
      const { body, landings } = await firstBody(model(api, true), async (log) => {
        await log.append([
          gone(
            [
              { type: "text", text: "旧图" },
              { type: "image", mime: "image/png", blobId: "x" },
            ],
            1,
          ),
        ])
        return []
      })
      expect(body).toContain(IMAGE_UNAVAILABLE)
      expect(body).not.toContain("blobId")
      const user = landings.find((l) => l.type === "core.user_message")
      expect(user?.kind).toBe("lossy")
      expect(user?.note).toContain(IMAGE_UNAVAILABLE_NOTE)
    })

    it(`${api}：模型不收图时仍是"不收图"那句（与内联同形）`, async () => {
      const { body } = await firstBody(model(api, false), async (log) => {
        await log.append([gone([{ type: "image", mime: "image/png", blobId: "x" }], 1)])
        return []
      })
      expect(body).toContain("[image omitted: this model does not accept images]")
      expect(body).not.toContain(IMAGE_UNAVAILABLE)
    })
  }
})
