import {
  type CoreEvent,
  type CoreEventOf,
  type Event,
  InMemoryBlobStore,
  InMemoryEventLog,
  InMemoryMemoryStore,
  type LoopConfig,
  type RunResult,
  resolveSocketContributions,
  runLoop,
  type Tool,
} from "@reins/core"
import { callTool, ScriptedLowering, say } from "@reins/core/testing"
import { describe, expect, it } from "vitest"
import { spill } from "../spill/index.js"
import { MAX_SKILL_DESCRIPTION_CHARS, parseSkillMarkdown } from "./frontmatter.js"
import { inlineSkills } from "./inline.js"
import { renderSkillMenu, SKILL_READ_TOOL_NAME, SKILL_RULES } from "./rules.js"
import {
  DEFAULT_MAX_READ_CHARS,
  DEFAULT_SKILLS_ROOT,
  loadSkillMenu,
  parseSkillReadInput,
  type SkillReadInput,
  skills,
} from "./skills.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
type ToolResultEvent = CoreEventOf<"core.tool_result">

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
const textOf = (r: ToolResultEvent) =>
  r.payload.content.map((p) => (p.type === "text" ? p.text : "")).join("")
const resultOf = (events: readonly CoreEvent[], toolCallId: string) =>
  events.find(
    (e): e is ToolResultEvent => e.type === "core.tool_result" && e.payload.toolCallId === toolCallId,
  ) as ToolResultEvent

const md = (name: string, description: string, body = `# ${name}\n\nDo the thing.\n`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`

/** 两份合规技能（其中一份带附件）+ 一份 name 与目录不一致 + 一份缺 description */
function sampleSource() {
  return inlineSkills({
    "adrate-ads": {
      "SKILL.md": md("adrate-ads", "Inspect and change TikTok campaigns safely."),
      "reference/errors.md": "# Error codes\n\nRATE_LIMITED: wait.\n",
    },
    "adrate-shared": md(
      "adrate-shared",
      "Operate AdRate CLI authentication, pagination and rate limits safely.",
      `# Shared\n\n${Array.from({ length: 400 }, (_, i) => `rule ${i + 1}`).join("\n")}\n`,
    ),
    mismatch: md("other-name", "name does not match the folder"),
    "no-desc": "---\nname: no-desc\n---\n# nothing\n",
  })
}

/** 直接调用工具（不经循环） */
function tool(socket: ReturnType<typeof skills>, setup: Parameters<typeof resolveSocketContributions>[0]) {
  return async () => {
    const { tools } = await resolveSocketContributions(setup)
    return tools.find((t) => t.name === SKILL_READ_TOOL_NAME) as Tool<SkillReadInput> | undefined
  }
}

function setupWith(socket: ReturnType<typeof skills>, extra: Partial<LoopConfig> = {}) {
  return { log: new InMemoryEventLog(), model: MODEL, sockets: [socket], ...extra }
}

const ctx = { sessionId: SESSION, toolCallId: "c1", log: new InMemoryEventLog(), emit: () => {} }

// ---------------------------------------------------------------------------

describe("SKILL.md 头部解析", () => {
  it("认出 name / description，值两端的引号去掉，嵌套的 metadata 与私有字段忽略，正文是头部之后的内容", () => {
    const r = parseSkillMarkdown(
      [
        "---",
        'name: "adrate-shared"',
        'description: "Operate AdRate CLI safely."',
        "metadata:",
        '  version: "1.6.1"',
        '  cliHelp: "adrate skills read adrate-shared"',
        "allowed-tools: Bash",
        "---",
        "",
        "# AdRate Shared",
        "",
      ].join("\n"),
    )
    expect(r).toEqual({
      ok: true,
      skill: {
        name: "adrate-shared",
        description: "Operate AdRate CLI safely.",
        body: "\n# AdRate Shared\n",
      },
    })
  })

  it("CRLF 与无正文都能解析；重复键以第一个为准", () => {
    expect(parseSkillMarkdown("---\r\nname: a\r\ndescription: x\r\n---")).toMatchObject({
      ok: true,
      skill: { name: "a", description: "x", body: "" },
    })
    expect(parseSkillMarkdown("---\nname: a\nname: b\ndescription: x\n---\n")).toMatchObject({
      ok: true,
      skill: { name: "a" },
    })
  })

  it.each([
    ["没有头部", "# just markdown", "must start with"],
    ["头部没收口", "---\nname: a\ndescription: x\n", "not closed"],
    ["收口不独占一行", "---\nname: a\ndescription: x\n---- more\n", "not closed"],
    ["缺 name", "---\ndescription: x\n---\n", "no `name`"],
    ["缺 description", "---\nname: a\n---\n", "no `description`"],
    ["name 大写", "---\nname: Ads\ndescription: x\n---\n", "must match"],
    ["name 带下划线", "---\nname: a_b\ndescription: x\n---\n", "must match"],
    ["name 连字符开头", "---\nname: -a\ndescription: x\n---\n", "must match"],
    ["name 超长", `---\nname: ${"a".repeat(65)}\ndescription: x\n---\n`, "must match"],
    [
      "description 超长",
      `---\nname: a\ndescription: ${"x".repeat(MAX_SKILL_DESCRIPTION_CHARS + 1)}\n---\n`,
      "at most 1024",
    ],
  ])("拒绝：%s", (_label, content, why) => {
    const r = parseSkillMarkdown(content)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain(why)
  })
})

describe("菜单加载", () => {
  it("只认 <root>/<name>/SKILL.md，name 须与目录一致；不合规的单独列在 rejected；结果按 name 排序", async () => {
    const menu = await loadSkillMenu(sampleSource())
    expect(menu.skills.map((s) => s.name)).toEqual(["adrate-ads", "adrate-shared"])
    expect(menu.skills[0]).toEqual({
      name: "adrate-ads",
      description: "Inspect and change TikTok campaigns safely.",
      path: "/skills/adrate-ads/SKILL.md",
    })
    expect(menu.rejected.map((r) => r.path).sort()).toEqual([
      "/skills/mismatch/SKILL.md",
      "/skills/no-desc/SKILL.md",
    ])
    expect(menu.rejected.find((r) => r.path.includes("mismatch"))?.reason).toContain(
      "does not match its folder",
    )
  })

  it("任何 MemoryStore 都是载体：写进 /skills 的技能被列出，/memories 与更深层的 SKILL.md 不算技能", async () => {
    const store = new InMemoryMemoryStore()
    await store.write("/skills/a/SKILL.md", md("a", "A."))
    await store.write("/skills/a/deeper/SKILL.md", md("deeper", "not a skill"))
    await store.write("/memories/notes.md", "私人笔记")
    await store.write("/skills/README.md", "not a skill either")
    const menu = await loadSkillMenu(store)
    expect(menu.skills.map((s) => s.name)).toEqual(["a"])
    expect(menu.rejected).toEqual([])
  })

  it("自定义 root", async () => {
    const source = inlineSkills({ x: md("x", "X.") }, { root: "/team/skills" })
    expect((await loadSkillMenu(source, "/team/skills")).skills.map((s) => s.name)).toEqual(["x"])
    expect((await loadSkillMenu(source)).skills).toEqual([])
  })

  it("菜单排版：一行一项，description 里的换行折成空格", () => {
    expect(renderSkillMenu([{ name: "a", description: "line one\n  line two" }])).toBe(
      "Available skills:\n- a: line one line two",
    )
  })
})

describe("skill_read 入参", () => {
  it("path 缺省 SKILL.md；相对路径规范化；range 同 memory view", () => {
    expect(parseSkillReadInput({ name: "adrate-ads" })).toEqual({ name: "adrate-ads", path: "SKILL.md" })
    expect(parseSkillReadInput({ name: "adrate-ads", path: "reference//errors.md/" })).toEqual({
      name: "adrate-ads",
      path: "reference/errors.md",
    })
    expect(parseSkillReadInput({ name: "a", path: "/x.md" })).toEqual({ name: "a", path: "x.md" })
    expect(parseSkillReadInput({ name: "a", range: [3, -1] })).toEqual({
      name: "a",
      path: "SKILL.md",
      range: [3, -1],
    })
  })

  it.each([
    ["非对象", 1, "expects an object"],
    ["name 缺", {}, "`name` must be"],
    ["name 不合规", { name: "../etc" }, "`name` must be"],
    ["name 大写", { name: "Ads" }, "`name` must be"],
    ["path 非字符串", { name: "a", path: 1 }, "`path` must be a string"],
    ["path 穿越", { name: "a", path: "../b/SKILL.md" }, "`.` and `..` segments"],
    ["path 反斜杠", { name: "a", path: "..\\x" }, "backslashes"],
    ["path 百分号编码", { name: "a", path: "%2e%2e/x" }, "percent-encoded"],
    ["path 指向技能本身", { name: "a", path: "/" }, "not the skill itself"],
    ["range 形状", { name: "a", range: [1] }, "`range` must be"],
    ["range 起点 0", { name: "a", range: [0, 5] }, "start_line must be ≥ 1"],
    ["range 倒序", { name: "a", range: [5, 2] }, "end_line must be ≥ start_line"],
  ])("拒绝：%s", (_label, input, why) => {
    expect(() => parseSkillReadInput(input)).toThrow(why)
  })

  it("穿越被拒的错误里说的是技能自己的根，不泄露别的技能", () => {
    expect(() => parseSkillReadInput({ name: "a", path: "../b/SKILL.md" })).toThrow("stay under /skills/a")
  })
})

describe("skills(): 静态贡献", () => {
  it("有 source：规则提示 + 菜单进系统提示，skill_read 工具注册且 risk=low、resultTrust=system；不合规的技能各告警一次", async () => {
    const warnings: string[] = []
    const socket = skills({ source: sampleSource(), warn: (m) => warnings.push(m) })
    const setup = setupWith(socket, { systemPrompt: "宿主提示" })
    const { tools, systemPrompt } = await resolveSocketContributions(setup)
    expect(tools.map((t) => t.name)).toEqual([SKILL_READ_TOOL_NAME])
    // resultPolicy 的 maxTokens 等于字符上限：token 数不会超过字符数，spill 不会再把技能正文外溢成 blob
    expect(tools[0]).toMatchObject({
      risk: "low",
      resultTrust: "system",
      resultPolicy: { maxTokens: DEFAULT_MAX_READ_CHARS, overflow: "spill" },
    })
    expect(systemPrompt).toBe(
      `宿主提示\n\n${SKILL_RULES}\n\nAvailable skills:\n- adrate-ads: Inspect and change TikTok campaigns safely.\n- adrate-shared: Operate AdRate CLI authentication, pagination and rate limits safely.`,
    )
    expect(warnings).toHaveLength(2)
    expect(warnings.every((w) => w.includes("跳过不合规的技能"))).toBe(true)
    // 第二个 run 同一实例：菜单重读，但告警不重复
    await resolveSocketContributions(setupWith(socket))
    expect(warnings).toHaveLength(2)
  })

  it("菜单进 configHash 的前提：同一 source 两次解析系统提示逐字相同；技能表变了系统提示就变", async () => {
    const store = new InMemoryMemoryStore()
    await store.write("/skills/a/SKILL.md", md("a", "A."))
    const socket = skills({ source: store })
    const first = (await resolveSocketContributions(setupWith(socket))).systemPrompt
    const again = (await resolveSocketContributions(setupWith(socket))).systemPrompt
    expect(again).toBe(first)
    await store.write("/skills/b/SKILL.md", md("b", "B."))
    const changed = (await resolveSocketContributions(setupWith(socket))).systemPrompt
    expect(changed).not.toBe(first)
    expect(changed).toContain("- b: B.")
  })

  it("缺 source：工具与菜单都不注册，告警一次", async () => {
    const warnings: string[] = []
    const socket = skills({ warn: (m) => warnings.push(m) })
    const r1 = await resolveSocketContributions(setupWith(socket))
    const r2 = await resolveSocketContributions(setupWith(socket))
    expect(r1.tools).toEqual([])
    expect(r1.systemPrompt).toBeUndefined()
    expect(r2.tools).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("没有给 source")
  })

  it("source 下没有一份合规技能：同样不注册，告警一次（含只有不合规技能的情况）", async () => {
    const warnings: string[] = []
    const socket = skills({
      source: inlineSkills({ bad: "no frontmatter" }),
      warn: (m) => warnings.push(m),
    })
    const r = await resolveSocketContributions(setupWith(socket))
    expect(r.tools).toEqual([])
    expect(r.systemPrompt).toBeUndefined()
    expect(warnings.some((w) => w.includes("没有任何合规的 SKILL.md"))).toBe(true)
    expect(warnings.some((w) => w.includes("跳过不合规的技能"))).toBe(true)
  })

  it("rules 可替换或关掉；关掉时工具仍注册", async () => {
    const source = inlineSkills({ a: md("a", "A.") })
    const custom = await resolveSocketContributions(setupWith(skills({ source, rules: "自定义规则" })))
    expect(custom.systemPrompt).toBe("自定义规则\n\nAvailable skills:\n- a: A.")
    const off = await resolveSocketContributions(setupWith(skills({ source, rules: false })))
    expect(off.systemPrompt).toBeUndefined()
    expect(off.tools.map((t) => t.name)).toEqual([SKILL_READ_TOOL_NAME])
  })

  it("构造期校验：root 形状、maxReadChars", () => {
    expect(() => skills({ root: "skills" })).toThrow("skills.root")
    expect(() => skills({ root: "/skills/" })).toThrow("skills.root")
    expect(() => skills({ root: "/a//b" })).toThrow("skills.root")
    expect(() => skills({ maxReadChars: 0 })).toThrow("skills.maxReadChars")
    expect(DEFAULT_SKILLS_ROOT).toBe("/skills")
    expect(DEFAULT_MAX_READ_CHARS).toBe(40_000)
  })
})

describe("skill_read 执行", () => {
  const socket = skills({ source: sampleSource(), maxReadChars: 200, warn: () => {} })
  const getTool = tool(socket, setupWith(socket))
  const run = async (input: Record<string, unknown>) => {
    const t = await getTool()
    if (!t?.execute || !t.validate) throw new Error("skill_read 未注册")
    return (await t.execute(t.validate(input), ctx)) as {
      content: { type: "text"; text: string }[]
      isError?: boolean
    }
  }

  it("读 SKILL.md：带行号的全文（含头部，行号与文件一致）", async () => {
    const r = await run({ name: "adrate-ads" })
    expect(r.isError).toBeUndefined()
    expect(r.content[0]?.text).toBe(
      [
        "Here's the content of adrate-ads/SKILL.md with line numbers:",
        "     1\t---",
        "     2\tname: adrate-ads",
        "     3\tdescription: Inspect and change TikTok campaigns safely.",
        "     4\t---",
        "     5\t",
        "     6\t# adrate-ads",
        "     7\t",
        "     8\tDo the thing.",
      ].join("\n"),
    )
  })

  it("读附件：相对路径", async () => {
    const r = await run({ name: "adrate-ads", path: "reference/errors.md" })
    expect(r.content[0]?.text).toContain("Here's the content of adrate-ads/reference/errors.md")
    expect(r.content[0]?.text).toContain("RATE_LIMITED: wait.")
  })

  it("超过 maxReadChars 按行截断并提示 range 续读；带 range 就不截断", async () => {
    const first = await run({ name: "adrate-shared" })
    expect(first.content[0]?.text).toMatch(
      /\[Showing lines 1-\d+ of 407 \(.* total\)\. Use range, e\.g\. \[\d+, -1\], to read the rest\.\]$/,
    )
    const rest = await run({ name: "adrate-shared", range: [400, -1] })
    expect(rest.content[0]?.text).toContain("(lines 400-407 of 407)")
    expect(rest.content[0]?.text).toContain("   407\trule 400")
    const beyond = await run({ name: "adrate-shared", range: [999, -1] })
    expect(beyond.isError).toBe(true)
    expect(beyond.content[0]?.text).toContain("Invalid `range`: start_line 999 is beyond the end")
  })

  it("技能不存在、文件不存在、被跳过的不合规技能的附件：统一一句“不存在”", async () => {
    for (const input of [
      { name: "nope" },
      { name: "adrate-ads", path: "missing.md" },
      { name: "mismatch", path: "x.md" },
    ]) {
      const r = await run(input)
      expect(r.isError).toBe(true)
      expect(r.content[0]?.text).toMatch(/^Skill file .+ does not exist\.$/)
    }
  })
})

describe("skills() 与 runLoop 集成", () => {
  it("模型先翻书再动手：skill_read 的 tool_result 进日志、trust=system（不套 untrusted）；调用 add 的结果仍是 untrusted", async () => {
    const add: Tool = {
      name: "add",
      description: "两数相加",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      execute: (input) => {
        const { a, b } = input as { a: number; b: number }
        return a + b
      },
    }
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", SKILL_READ_TOOL_NAME, { name: "adrate-ads" })] },
      { drafts: [callTool("c2", "add", { a: 1, b: 2 })] },
      { drafts: [say("done")] },
    ])
    const cfg: LoopConfig = {
      sessionId: SESSION,
      log,
      lowering,
      model: MODEL,
      tools: [add],
      sockets: [skills({ source: sampleSource(), warn: () => {} })],
      systemPrompt: "你是助手",
      input: "开始",
      ...deterministic(),
    }
    const { result } = await drain(runLoop(cfg))
    expect(result.status).toBe("done")
    const events = await all(log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "tool_result",
      "budget_usage",
      "tool_call",
      "tool_result",
      "budget_usage",
      "model_text",
      "budget_usage",
    ])
    const skillRead = resultOf(events, "c1")
    expect(skillRead.trust).toBe("system")
    expect(skillRead.provenance).toEqual({ source: SKILL_READ_TOOL_NAME })
    expect(textOf(skillRead)).toContain("Do the thing.")
    expect(resultOf(events, "c2").trust).toBe("untrusted")
    // 模型每轮看到的系统提示都带菜单，且逐字相同
    const prompts = lowering.requests.map((r) => r.systemPrompt)
    expect(prompts[0]).toContain("Available skills:\n- adrate-ads:")
    expect(new Set(prompts).size).toBe(1)
  })

  it("与 spill 同装：远超 spill 阈值的技能正文照样整段进时间线，不被外溢成 blob（resultPolicy 按字符上限放行）", async () => {
    const body = Array.from(
      { length: 600 },
      (_, i) => `rule ${i + 1}: keep campaign writes server-owned.`,
    ).join("\n")
    const source = inlineSkills({ big: md("big", "A long skill.", `${body}\n`) })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", SKILL_READ_TOOL_NAME, { name: "big" })] },
      { drafts: [say("done")] },
    ])
    await drain(
      runLoop({
        sessionId: SESSION,
        log,
        blobs: new InMemoryBlobStore(),
        lowering,
        model: MODEL,
        sockets: [skills({ source, warn: () => {} }), spill({ maxResultTokens: 2000 })],
        input: "开始",
        ...deterministic(),
      }),
    )
    const r = resultOf(await all(log), "c1")
    expect(r.payload.spilled).toBeUndefined()
    expect(textOf(r)).toContain("rule 600: keep campaign writes server-owned.")
    expect(textOf(r)).not.toContain("Showing lines")
    expect(r.trust).toBe("system")
  })

  it("入参不合法（穿越）与不存在：结果 isError 且 trust 仍是缺省 untrusted", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("c1", SKILL_READ_TOOL_NAME, { name: "adrate-ads", path: "../adrate-shared/SKILL.md" }),
        ],
      },
      { drafts: [callTool("c2", SKILL_READ_TOOL_NAME, { name: "nope" })] },
      { drafts: [say("done")] },
    ])
    await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: MODEL,
        sockets: [skills({ source: sampleSource(), warn: () => {} })],
        input: "开始",
        ...deterministic(),
      }),
    )
    const events = await all(log)
    const traversal = resultOf(events, "c1")
    expect(traversal.payload.isError).toBe(true)
    expect(textOf(traversal)).toContain("入参不合法")
    expect(textOf(traversal)).toContain("`.` and `..` segments")
    expect(traversal.trust).toBe("untrusted")
    const missing = resultOf(events, "c2")
    expect(missing.payload.isError).toBe(true)
    expect(missing.trust).toBe("untrusted")
  })
})
