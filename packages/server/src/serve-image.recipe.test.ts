/**
 * 图片下发路由配方（server README "Images by reference"）的可执行版本：宿主自建 GET 路由把会话里的图片字节给前端。
 * 判归属必须用 core 的 `blobUsableBy`，只比 `meta.sessionId` 的话 fork 出的会话显示不了父会话的图（2026-11-24 媒体引用方案）。
 */
import {
  type BlobMeta,
  type BlobStore,
  blobUsableBy,
  createCoreRegistry,
  type EventLog,
  InMemoryBlobStore,
  InMemoryEventLog,
  readTimeline,
  runLoop,
  StoreError,
} from "@reinsjs/core"
import { ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"

const registry = createCoreRegistry()

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

/** Raster formats only: an SVG opened from your origin runs its scripts there, with the viewer's credentials. */
const SERVABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** GET /images?sessionId=…&id=… — call it only after your own session check (the same one as `authorizeSession`). */
async function serveImage(log: EventLog, blobs: BlobStore, sessionId: string, id: string): Promise<Response> {
  const notFound = () => new Response("not found", { status: 404 })
  let blob: { bytes: Uint8Array; meta: BlobMeta }
  try {
    blob = await blobs.get(id)
  } catch (err) {
    if (err instanceof StoreError && err.code === "not_found") return notFound()
    throw err
  }
  const timeline = await readTimeline(log, sessionId, { registry })
  if (!blobUsableBy(sessionId, blob.meta, id, timeline)) return notFound()
  if (!SERVABLE_IMAGES.has(blob.meta.mime)) return notFound()
  return new Response(blob.bytes.slice(), {
    headers: {
      "content-type": blob.meta.mime,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  })
}

// ---- 配方本体结束 ----

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

async function chat(
  log: InMemoryEventLog,
  blobs: InMemoryBlobStore,
  sessionId: string,
  blobId: string,
  mime = "image/png",
) {
  const gen = runLoop({
    sessionId,
    log,
    blobs,
    lowering: new ScriptedLowering([{ drafts: [say("ok")] }]),
    model: { provider: "scripted", id: "scripted" },
    input: [{ type: "image", mime, blobId }],
  })
  for await (const _ of gen) {
    // 跑完即可
  }
}

describe("配方：图片下发路由", () => {
  it("本会话的图 200；别的会话的、不存在的、非图片的 404；fork 出的会话能取父会话已引用的图", async () => {
    const log = new InMemoryEventLog()
    const blobs = new InMemoryBlobStore()
    const own = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const foreign = await blobs.put(PNG, { mime: "image/png", sessionId: "s2" })
    const text = await blobs.put("spilled output", { mime: "text/plain", sessionId: "s1" })
    await chat(log, blobs, "s1", own.id)

    const ok = await serveImage(log, blobs, "s1", own.id)
    expect(ok.status).toBe(200)
    expect(ok.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG)
    // 浏览器不按内容嗅探、直接打开也不执行任何东西
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff")
    expect(ok.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
    for (const id of [foreign.id, "nope", text.id])
      expect((await serveImage(log, blobs, "s1", id)).status).toBe(404)

    const atSeq = (await log.tail("s1", 1))[0]?.seq ?? 0
    await log.fork("s1", atSeq, "child")
    expect((await serveImage(log, blobs, "child", own.id)).status).toBe(200)
    expect((await serveImage(log, blobs, "child", foreign.id)).status).toBe(404)
  })

  it("SVG 即使是本会话引用过的图也不下发：同源直接打开会执行其中的脚本（存储型 XSS）", async () => {
    const log = new InMemoryEventLog()
    const blobs = new InMemoryBlobStore()
    const svg = await blobs.put('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
      mime: "image/svg+xml",
      sessionId: "s1",
    })
    // 引用本身能通过 core 的图片引用校验（只要求 image/ 前缀）
    await chat(log, blobs, "s1", svg.id, "image/svg+xml")
    expect((await serveImage(log, blobs, "s1", svg.id)).status).toBe(404)
  })
})
