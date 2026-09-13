/**
 * `@reins/brain/node` 的 fsSkillSource：真实临时目录上跑。这里只验载体本身（列 / 读 / 越界 / 隐藏文件），
 * 菜单与 skill_read 的逻辑在 skills/skills.test.ts 用内存载体验过，两者只通过 SkillSource 契约相接。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryEventLog, resolveSocketContributions } from "@reins/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fsSkillSource } from "./node.js"
import { loadSkillMenu, SKILL_READ_TOOL_NAME, skills } from "./skills/index.js"

const md = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

let dir: string
let outside: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "reins-skills-"))
  outside = await mkdtemp(join(tmpdir(), "reins-outside-"))
  await mkdir(join(dir, "adrate-ads", "reference"), { recursive: true })
  await writeFile(join(dir, "adrate-ads", "SKILL.md"), md("adrate-ads", "Ads."))
  await writeFile(join(dir, "adrate-ads", "reference", "errors.md"), "# errors\n")
  await mkdir(join(dir, "adrate-shared"))
  await writeFile(join(dir, "adrate-shared", "SKILL.md"), md("adrate-shared", "Shared."))
  await mkdir(join(dir, ".git"))
  await writeFile(join(dir, ".git", "SKILL.md"), md("git", "hidden"))
  await writeFile(join(dir, "adrate-ads", ".DS_Store"), "junk")
  await writeFile(join(dir, "README.md"), "not a skill\n")
  await writeFile(join(outside, "secret.txt"), "top secret")
  // 技能目录里一个指向外面的符号链接：不能借它读到目录之外
  await symlink(join(outside, "secret.txt"), join(dir, "adrate-ads", "leak.md"))
  // 指向根外的符号链接目录、指向根内的合法链接、成环的链接
  await symlink(outside, join(dir, "linkdir"))
  await mkdir(join(dir, "linked"))
  await symlink(join(dir, "adrate-shared", "SKILL.md"), join(dir, "linked", "SKILL.md"))
  await symlink(join(dir, "adrate-ads", "loop.md"), join(dir, "adrate-ads", "loop.md"))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe("fsSkillSource", () => {
  it("list：目录树映射成 /skills/<相对路径>，隐藏文件与目录、符号链接不列，按字典序", async () => {
    const source = fsSkillSource(dir)
    expect(await source.list("/skills/")).toEqual([
      "/skills/README.md",
      "/skills/adrate-ads/SKILL.md",
      "/skills/adrate-ads/reference/errors.md",
      "/skills/adrate-shared/SKILL.md",
    ])
    expect(await source.list("/skills/adrate-shared/")).toEqual(["/skills/adrate-shared/SKILL.md"])
    expect(await source.list("/memories/")).toEqual([])
  })

  it("read：存在的文件原文返回；不存在、目录、root 之外、穿越、隐藏、符号链接逃逸 → null", async () => {
    const source = fsSkillSource(dir)
    expect(await source.read("/skills/adrate-ads/reference/errors.md")).toBe("# errors\n")
    expect(await source.read("/skills/adrate-ads/nope.md")).toBeNull()
    expect(await source.read("/skills/adrate-ads")).toBeNull()
    expect(await source.read("/skills/adrate-ads/reference")).toBeNull()
    expect(await source.read("/memories/x.md")).toBeNull()
    expect(await source.read("/skills/../secret.txt")).toBeNull()
    expect(await source.read("/skills/adrate-ads/../../secret.txt")).toBeNull()
    expect(await source.read("/skills/.git/SKILL.md")).toBeNull()
    expect(await source.read("/skills/adrate-ads/.DS_Store")).toBeNull()
    expect(await source.read("/skills/adrate-ads/leak.md")).toBeNull()
  })

  it("发前审查补的边界：链接目录不递归、根内链接“不在菜单但可读”、成环与超长名字当不存在且不泄露宿主路径", async () => {
    const source = fsSkillSource(dir)
    const keys = await source.list("/skills/")
    expect(keys.some((k) => k.startsWith("/skills/linkdir/"))).toBe(false)
    expect(keys).not.toContain("/skills/linked/SKILL.md")
    expect(await source.read("/skills/linkdir/secret.txt")).toBeNull()
    // 指向根内的合法链接：菜单不列（isFile 为 false），猜到名字能读——保守方向，锁住语义
    expect(await source.read("/skills/linked/SKILL.md")).toBe(md("adrate-shared", "Shared."))
    expect((await loadSkillMenu(source)).skills.map((s) => s.name)).toEqual(["adrate-ads", "adrate-shared"])
    // ELOOP / ENAMETOOLONG：null，而不是把带宿主绝对路径的错误抛给模型
    expect(await source.read("/skills/adrate-ads/loop.md")).toBeNull()
    expect(await source.read(`/skills/adrate-ads/${"a".repeat(300)}`)).toBeNull()
  })

  it("自定义 root 与不存在的目录", async () => {
    const source = fsSkillSource(dir, { root: "/team" })
    expect(await source.list("/team/adrate-shared/")).toEqual(["/team/adrate-shared/SKILL.md"])
    expect(await source.read("/skills/adrate-shared/SKILL.md")).toBeNull()
    expect(await fsSkillSource(join(dir, "missing")).list("/skills/")).toEqual([])
  })

  it("接到 skills() 上：菜单只含两份合规技能，skill_read 注册", async () => {
    const socket = skills({ source: fsSkillSource(dir), warn: () => {} })
    expect((await loadSkillMenu(fsSkillSource(dir))).skills.map((s) => s.name)).toEqual([
      "adrate-ads",
      "adrate-shared",
    ])
    const { tools, systemPrompt } = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: { provider: "scripted", id: "scripted" },
      sockets: [socket],
    })
    expect(tools.map((t) => t.name)).toEqual([SKILL_READ_TOOL_NAME])
    expect(systemPrompt).toContain("- adrate-ads: Ads.\n- adrate-shared: Shared.")
  })
})
