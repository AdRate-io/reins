/** MemoryStore 一致性套件。 */
import type { MemoryStore } from "../store/types.js"
import { assertEqual, type TestHarness } from "./harness.js"

export function memoryStoreConformance(
  t: TestHarness,
  factory: () => MemoryStore | Promise<MemoryStore>,
): void {
  t.describe("MemoryStore conformance", () => {
    t.it("read on an unknown path returns null", async () => {
      const store = await factory()
      assertEqual(await store.read("/memories/none.md"), null, "missing path")
    })

    t.it("read returns what write stored; a second write overwrites it", async () => {
      const store = await factory()
      await store.write("/memories/a.md", "v1")
      assertEqual(await store.read("/memories/a.md"), "v1", "first write")
      await store.write("/memories/a.md", "v2")
      assertEqual(await store.read("/memories/a.md"), "v2", "overwriting write")
    })

    t.it("list filters by prefix and returns paths in lexicographic order", async () => {
      const store = await factory()
      await store.write("/memories/b.md", "")
      await store.write("/memories/a.md", "")
      await store.write("/memories/sub/c.md", "")
      await store.write("/other/z.md", "")
      assertEqual(
        await store.list("/memories/"),
        ["/memories/a.md", "/memories/b.md", "/memories/sub/c.md"],
        "prefix /memories/",
      )
      assertEqual(await store.list("/memories/sub/"), ["/memories/sub/c.md"], "subdirectory prefix")
      assertEqual(await store.list("/nope/"), [], "no match")
    })

    t.it(
      "after delete, read is null and list no longer shows it; deleting an unknown path does not throw",
      async () => {
        const store = await factory()
        await store.write("/memories/a.md", "x")
        await store.delete("/memories/a.md")
        assertEqual(await store.read("/memories/a.md"), null, "read after delete")
        assertEqual(await store.list("/memories/"), [], "list after delete")
        await store.delete("/memories/a.md") // 幂等
      },
    )

    t.it("an empty string is valid content, distinct from absence", async () => {
      const store = await factory()
      await store.write("/memories/empty.md", "")
      assertEqual(
        await store.read("/memories/empty.md"),
        "",
        "empty content must read back as an empty string, not null",
      )
    })
  })
}
