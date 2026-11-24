/** BlobStore 一致性套件。 */
import type { BlobStore } from "../store/types.js"
import { assert, assertEqual, assertThrowsCode, type TestHarness } from "./harness.js"

export function blobStoreConformance(t: TestHarness, factory: () => BlobStore | Promise<BlobStore>): void {
  t.describe("BlobStore conformance", () => {
    t.it("put bytes -> get returns them verbatim, with size and mime in meta", async () => {
      const store = await factory()
      const bytes = new Uint8Array([1, 2, 3, 250])
      const { id } = await store.put(bytes, { mime: "application/octet-stream", sessionId: "s1" })
      assert(typeof id === "string" && id.length > 0, "id must be a non-empty string")
      const got = await store.get(id)
      assertEqual(Array.from(got.bytes), [1, 2, 3, 250], "byte content")
      assertEqual(got.meta.mime, "application/octet-stream", "mime")
      assertEqual(got.meta.sessionId, "s1", "sessionId")
      assertEqual(got.meta.size, 4, "size")
      assert(typeof got.meta.createdAt === "number", "createdAt must be a number")
    })

    t.it("a string is stored as UTF-8", async () => {
      const store = await factory()
      const { id } = await store.put("你好, world", { mime: "text/plain", sessionId: "s1" })
      const got = await store.get(id)
      assertEqual(new TextDecoder().decode(got.bytes), "你好, world", "decoded text")
      assertEqual(
        got.meta.size,
        new TextEncoder().encode("你好, world").byteLength,
        "size is the UTF-8 byte length",
      )
    })

    t.it("every put yields a different id", async () => {
      const store = await factory()
      const a = await store.put("x", { mime: "text/plain", sessionId: "s1" })
      const b = await store.put("x", { mime: "text/plain", sessionId: "s1" })
      assert(a.id !== b.id, "putting the same content twice must still yield different ids")
    })

    t.it("get on an unknown id -> not_found", async () => {
      const store = await factory()
      await assertThrowsCode(() => store.get("no-such-id"), "not_found", "missing blob")
    })

    t.it("get returns a copy of the bytes", async () => {
      const store = await factory()
      const { id } = await store.put(new Uint8Array([9, 9]), { mime: "x", sessionId: "s1" })
      const first = await store.get(id)
      first.bytes[0] = 0
      const again = await store.get(id)
      assertEqual(Array.from(again.bytes), [9, 9], "an outside mutation must not affect the store")
    })

    t.it(
      "stat (if implemented) equals get().meta field by field; an unknown id throws not_found",
      async () => {
        const store = await factory()
        if (!store.stat) return
        // 按方法调用（SQLite / PG 实现靠 this），与循环里的调用方式一致
        const stat = (id: string) => (store.stat as NonNullable<BlobStore["stat"]>).call(store, id)
        const { id } = await store.put(new Uint8Array([1, 2, 3]), { mime: "image/png", sessionId: "s1" })
        const meta = await stat(id)
        const viaGet = (await store.get(id)).meta
        assertEqual(meta.mime, viaGet.mime, "mime")
        assertEqual(meta.sessionId, viaGet.sessionId, "sessionId")
        assertEqual(meta.size, viaGet.size, "size")
        assertEqual(meta.createdAt, viaGet.createdAt, "createdAt")
        await assertThrowsCode(
          () => stat("no-such-id"),
          "not_found",
          "missing blob (must throw, not return null)",
        )
      },
    )

    t.it("slice (if implemented) returns [start, end) and clamps out-of-range bounds", async () => {
      const store = await factory()
      if (!store.slice) return
      const { id } = await store.put(new Uint8Array([0, 1, 2, 3, 4]), { mime: "x", sessionId: "s1" })
      assertEqual(Array.from(await store.slice(id, { start: 1, end: 3 })), [1, 2], "middle slice")
      assertEqual(Array.from(await store.slice(id, { start: 3, end: 99 })), [3, 4], "clamped at the end")
      assertEqual(
        Array.from(await store.slice(id, { start: 5, end: 9 })),
        [],
        "a start beyond the end gives nothing",
      )
      // 宿主"取到末尾"常写 Infinity / 很大的数：后端参数类型更窄（如 int4）时须自行截断，不能抛驱动原始错误
      assertEqual(
        Array.from(await store.slice(id, { start: 2, end: Number.POSITIVE_INFINITY })),
        [2, 3, 4],
        "end Infinity",
      )
      assertEqual(Array.from(await store.slice(id, { start: 0, end: 2 ** 40 })), [0, 1, 2, 3, 4], "end 2^40")
      assertEqual(
        Array.from(await store.slice(id, { start: Number.MAX_SAFE_INTEGER, end: Number.POSITIVE_INFINITY })),
        [],
        "start MAX_SAFE_INTEGER",
      )
    })
  })
}
