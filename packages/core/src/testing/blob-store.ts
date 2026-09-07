/** BlobStore 一致性套件。 */
import type { BlobStore } from "../store/types.js"
import { assert, assertEqual, assertThrowsCode, type TestHarness } from "./harness.js"

export function blobStoreConformance(t: TestHarness, factory: () => BlobStore | Promise<BlobStore>): void {
  t.describe("BlobStore 一致性", () => {
    t.it("put 字节 → get 原样取回，meta 带 size 与 mime", async () => {
      const store = await factory()
      const bytes = new Uint8Array([1, 2, 3, 250])
      const { id } = await store.put(bytes, { mime: "application/octet-stream", sessionId: "s1" })
      assert(typeof id === "string" && id.length > 0, "id 应为非空字符串")
      const got = await store.get(id)
      assertEqual(Array.from(got.bytes), [1, 2, 3, 250], "字节内容")
      assertEqual(got.meta.mime, "application/octet-stream", "mime")
      assertEqual(got.meta.sessionId, "s1", "sessionId")
      assertEqual(got.meta.size, 4, "size")
      assert(typeof got.meta.createdAt === "number", "createdAt 应为数字")
    })

    t.it("put 字符串按 UTF-8 存储", async () => {
      const store = await factory()
      const { id } = await store.put("你好, world", { mime: "text/plain", sessionId: "s1" })
      const got = await store.get(id)
      assertEqual(new TextDecoder().decode(got.bytes), "你好, world", "解码后文本")
      assertEqual(got.meta.size, new TextEncoder().encode("你好, world").byteLength, "size 为 UTF-8 字节数")
    })

    t.it("每次 put 得到不同 id", async () => {
      const store = await factory()
      const a = await store.put("x", { mime: "text/plain", sessionId: "s1" })
      const b = await store.put("x", { mime: "text/plain", sessionId: "s1" })
      assert(a.id !== b.id, "相同内容两次 put 也应得到不同 id")
    })

    t.it("get 不存在的 id → not_found", async () => {
      const store = await factory()
      await assertThrowsCode(() => store.get("no-such-id"), "not_found", "缺失 blob")
    })

    t.it("get 返回的字节是副本", async () => {
      const store = await factory()
      const { id } = await store.put(new Uint8Array([9, 9]), { mime: "x", sessionId: "s1" })
      const first = await store.get(id)
      first.bytes[0] = 0
      const again = await store.get(id)
      assertEqual(Array.from(again.bytes), [9, 9], "外部修改不应影响存储")
    })

    t.it("slice（若实现）返回 [start, end) 且越界截断", async () => {
      const store = await factory()
      if (!store.slice) return
      const { id } = await store.put(new Uint8Array([0, 1, 2, 3, 4]), { mime: "x", sessionId: "s1" })
      assertEqual(Array.from(await store.slice(id, { start: 1, end: 3 })), [1, 2], "中段")
      assertEqual(Array.from(await store.slice(id, { start: 3, end: 99 })), [3, 4], "尾部越界截断")
      assertEqual(Array.from(await store.slice(id, { start: 5, end: 9 })), [], "起点越界得空")
    })
  })
}
