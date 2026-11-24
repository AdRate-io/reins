/**
 * 白名单外的旧图片（全库审查 2026-11-25 追加项）：core 自 0.x 起拦住新写入的 svg / heic / 错标 mime 图片，
 * 但白名单之前写进日志的仍在、每轮整段回放——照发厂商 400，会话永久卡死。三条线都落 core 同一句说明
 * （`unsupportedImageText`）、记 lossy；模型不收图时仍是"不收图"那句。合规图片的请求体不受影响
 */
import {
  type ContentPart,
  createCoreEvent,
  createCoreRegistry,
  type Event,
  type LandingRecord,
  unsupportedImageText,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { FetchLowering } from "./lowering.js"
import { IMAGE_UNSUPPORTED_NOTE } from "./media.js"
import type { FetchApi, FetchModel } from "./models.js"

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
const registry = createCoreRegistry()
const SVG = { type: "image", mime: "image/svg+xml", data: "PHN2Zy8+" } as ContentPart
const PNG = { type: "image", mime: "image/png", data: "iVBORw0KGgo=" } as ContentPart

function mk(seq: number, type: Event["type"], payload: unknown, actor: Event["actor"]): Event {
  return createCoreEvent(registry, {
    type: type as "core.user_message",
    payload: payload as never,
    actor,
    sessionId: "s1",
    seq,
    at: seq,
    id: `e${seq}`,
  })
}

function lower(api: FetchApi, images: boolean, events: Event[]): { body: string; landings: LandingRecord[] } {
  const m = model(api, images)
  const lowering = new FetchLowering({ apiKey: () => "k", models: [m] })
  const req = lowering.toRequest({ events, model: { provider: m.provider, id: m.id } })
  return { body: JSON.stringify((req.payload as { body: unknown }).body), landings: req.landings }
}

describe("白名单外的旧图片落占位、记 lossy", () => {
  for (const api of APIS) {
    it(`${api}：user_message 里的 svg → core 同一句说明，合规图片照发`, () => {
      const { body, landings } = lower(api, true, [
        mk(1, "core.user_message", { content: [{ type: "text", text: "看" }, SVG, PNG] }, "user"),
      ])
      expect(body).toContain(JSON.stringify(unsupportedImageText("image/svg+xml")).slice(1, -1))
      expect(body).not.toContain("PHN2Zy8+")
      expect(body).toContain("iVBORw0KGgo=")
      const user = landings.find((l) => l.type === "core.user_message")
      expect(user?.kind).toBe("lossy")
      expect(user?.note).toContain(IMAGE_UNSUPPORTED_NOTE)
    })

    it(`${api}：tool_result 里的 svg → 占位、不上浮、记 lossy`, () => {
      const { body, landings } = lower(api, true, [
        mk(1, "core.user_message", { content: [{ type: "text", text: "hi" }] }, "user"),
        mk(2, "core.tool_call", { toolCallId: "c1", name: "f", args: {} }, "model"),
        mk(3, "core.tool_result", { toolCallId: "c1", name: "f", content: [SVG], isError: false }, "tool"),
      ])
      expect(body).toContain(JSON.stringify(unsupportedImageText("image/svg+xml")).slice(1, -1))
      expect(body).not.toContain("PHN2Zy8+")
      expect(body).not.toContain("Attachments from tool result")
      const result = landings.find((l) => l.type === "core.tool_result")
      expect(result?.kind).toBe("lossy")
      expect(result?.note).toContain(IMAGE_UNSUPPORTED_NOTE)
    })

    it(`${api}：模型不收图时仍是"不收图"那句`, () => {
      const { body } = lower(api, false, [mk(1, "core.user_message", { content: [SVG] }, "user")])
      expect(body).toContain("[image omitted: this model does not accept images]")
      expect(body).not.toContain("not a supported image type")
    })
  }
})
