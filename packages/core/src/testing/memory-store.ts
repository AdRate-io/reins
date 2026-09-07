/** MemoryStore 一致性套件。 */
import type { MemoryStore } from "../store/types.js"
import { assertEqual, type TestHarness } from "./harness.js"

export function memoryStoreConformance(
  t: TestHarness,
  factory: () => MemoryStore | Promise<MemoryStore>,
): void {
  t.describe("MemoryStore 一致性", () => {
    t.it("read 不存在的路径返回 null", async () => {
      const store = await factory()
      assertEqual(await store.read("/memories/none.md"), null, "缺失路径")
    })

    t.it("write 后 read 原样返回；再次 write 覆盖", async () => {
      const store = await factory()
      await store.write("/memories/a.md", "v1")
      assertEqual(await store.read("/memories/a.md"), "v1", "首次写")
      await store.write("/memories/a.md", "v2")
      assertEqual(await store.read("/memories/a.md"), "v2", "覆盖写")
    })

    t.it("list 按前缀过滤并按字典序返回", async () => {
      const store = await factory()
      await store.write("/memories/b.md", "")
      await store.write("/memories/a.md", "")
      await store.write("/memories/sub/c.md", "")
      await store.write("/other/z.md", "")
      assertEqual(
        await store.list("/memories/"),
        ["/memories/a.md", "/memories/b.md", "/memories/sub/c.md"],
        "前缀 /memories/",
      )
      assertEqual(await store.list("/memories/sub/"), ["/memories/sub/c.md"], "子目录前缀")
      assertEqual(await store.list("/nope/"), [], "无匹配")
    })

    t.it("delete 后 read 为 null、list 不再出现；删除不存在的路径不报错", async () => {
      const store = await factory()
      await store.write("/memories/a.md", "x")
      await store.delete("/memories/a.md")
      assertEqual(await store.read("/memories/a.md"), null, "删除后 read")
      assertEqual(await store.list("/memories/"), [], "删除后 list")
      await store.delete("/memories/a.md") // 幂等
    })

    t.it("空字符串是合法内容，与不存在区分", async () => {
      const store = await factory()
      await store.write("/memories/empty.md", "")
      assertEqual(await store.read("/memories/empty.md"), "", "空内容应返回空串而非 null")
    })
  })
}
