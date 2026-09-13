/**
 * skills —— 技能模块（技术方案 §9.9，S1）：Agent Skills（SKILL.md）的加载与渐进式披露。
 *
 * 库只做两件事（宪法一）：
 * - **让它看见**：系统提示里一份菜单（每个技能的 name + description），run 起步从 `SkillSource` 读一次、run 内不变；
 *   菜单进 configHash，暂停期间技能表变了，续跑按配置漂移处理（与工具表同规则）
 * - **给它能力**：`skill_read({ name, path?, range? })` 翻书，正文以 `tool_result` 进时间线而不塞 system——
 *   compact 折叠、`recall` 取回、spill 外溢零改动自动适用（宪法二）
 * 读哪份、什么时候读是模型的判断；规则提示只给经验（rules.ts）。
 *
 * 载体接口不新造：`SkillSource = Pick<MemoryStore, "list" | "read">`，任何 MemoryStore 都是数据库载体，
 * 文件系统载体 `fsSkillSource(dir)` 在 `@reins/brain/node`，字符串预填用 `inlineSkills({...})`。
 * 布局 `${root}/<name>/SKILL.md` + 同目录附件，`root` 缺省 `/skills`；同一个 MemoryStore 同时给 memory（/memories）
 * 与本模块（/skills）时，模型的 memory 工具够不到技能——技能对模型天然只读、对宿主可写。
 *
 * trust：技能是宿主配置的说明书，视同系统提示可信，`skill_read` 声明 `resultTrust: "system"`，结果不套 untrusted 标记。
 * 第三期若允许模型写技能，模型写的必须回到 untrusted（届时收回这条豁免）。
 *
 * 缺 source、或 source 下没有一份合规的 SKILL.md：按 §5"缺则不注册"——工具与菜单都不出现，告警一次；
 * 注册一个空菜单加一个一用就"不存在"的工具只会让模型撞墙。不合规的技能单独跳过并告警一次，不拖垮整个菜单。
 * 不做：脚本执行（子进程越硬约束，技能要的动作宿主用普通 Tool 暴露）、热刷新、`allowed-tools` 等私有字段。
 */
import type { SkillSource, Socket, SocketSetup, Tool } from "@reins/core"
import { resolveRootedPath } from "../shared/paths.js"
import { formatFileView } from "../shared/view.js"
import { parseSkillMarkdown, SKILL_NAME_RE } from "./frontmatter.js"
import {
  renderSkillMenu,
  SKILL_READ_INPUT_SCHEMA,
  SKILL_READ_TOOL_DESCRIPTION,
  SKILL_READ_TOOL_NAME,
  SKILL_RULES,
  type SkillMenuEntry,
} from "./rules.js"

export interface SkillsOptions {
  /** 技能载体。不给则模块不注册任何东西并告警一次（宿主按环境有没有技能库时可以这样装） */
  source?: SkillSource
  /** 载体里技能的键前缀，缺省 `/skills`；须是 `/` 起、不以 `/` 收的规范路径 */
  root?: string
  /**
   * `skill_read` 单次最多返回的字符数（正文部分），超过按行截断并提示用 range 续读。缺省 40000：
   * Agent Skills 规范建议 SKILL.md 不超过 500 行（约 40k 字符），而两族真模型实测都不会按截断提示续读一份"动手前先读"的说明书
   * （2026-09-13 AdRate 24.5k 字符的 SKILL.md 在 16k 上限下被截掉 110 行，DeepSeek 与 Claude 都直接开工），
   * 所以缺省要让规范内的技能一次读完；比 memory view 的 16000 大是有意的
   */
  maxReadChars?: number
  /**
   * 规则提示的经验部分：缺省内置英文 `SKILL_RULES`；传字符串替换（菜单仍自动排在其后）；
   * false 则完全不碰系统提示——工具仍注册，菜单由宿主自己排（`renderSkillMenu` / `loadSkillMenu` 可用）
   */
  rules?: string | false
  /** 告警出口（缺 source、无合规技能、某份 SKILL.md 不合规），每个 skills() 实例对每个原因只告警一次。缺省 console.warn */
  warn?: (message: string) => void
}

export const SKILLS_SOCKET_NAME = "skills"
export const DEFAULT_SKILLS_ROOT = "/skills"
export const DEFAULT_MAX_READ_CHARS = 40_000
export const DEFAULT_SKILL_FILE = "SKILL.md"

/** 菜单里的一项：合规的技能 */
export interface LoadedSkill extends SkillMenuEntry {
  /** SKILL.md 在载体里的键 */
  path: string
}

export interface SkillMenu {
  skills: LoadedSkill[]
  /** 被跳过的 SKILL.md：键 → 原因 */
  rejected: { path: string; reason: string }[]
}

/**
 * 从载体读菜单：`${root}/<name>/SKILL.md` 每份读头部，`name` 须与目录名一致。纯函数（只读载体），菜单与测试共用。
 * 结果按 name 排序，与载体返回顺序无关——菜单进 configHash，顺序抖动会误判配置漂移。
 */
export async function loadSkillMenu(source: SkillSource, root = DEFAULT_SKILLS_ROOT): Promise<SkillMenu> {
  const prefix = `${root}/`
  const keys = (await source.list(prefix)).filter((k) => k.startsWith(prefix))
  const skillFile = new RegExp(`^${escapeRegExp(prefix)}([^/]+)/${escapeRegExp(DEFAULT_SKILL_FILE)}$`)
  const menu: SkillMenu = { skills: [], rejected: [] }
  for (const key of keys) {
    const m = skillFile.exec(key)
    if (!m) continue
    const dir = m[1] as string
    const content = await source.read(key)
    if (content === null) continue // list 与 read 之间被删了，当不存在
    const parsed = parseSkillMarkdown(content)
    if (!parsed.ok) {
      menu.rejected.push({ path: key, reason: parsed.reason })
      continue
    }
    if (parsed.skill.name !== dir) {
      menu.rejected.push({
        path: key,
        reason: `frontmatter \`name\` ${JSON.stringify(parsed.skill.name)} does not match its folder ${JSON.stringify(dir)}`,
      })
      continue
    }
    menu.skills.push({ name: parsed.skill.name, description: parsed.skill.description, path: key })
  }
  menu.skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return menu
}

export interface SkillReadInput {
  name: string
  /** 相对技能目录的文件路径，已规范化（如 `SKILL.md`、`reference/api.md`） */
  path: string
  range?: [number, number]
}

/** 解析并校验模型给的入参：name 按规范正则，path 经共用的路径规范化（拒绝 `..` 等穿越），range 同 memory view */
export function parseSkillReadInput(raw: unknown, root = DEFAULT_SKILLS_ROOT): SkillReadInput {
  if (typeof raw !== "object" || raw === null)
    throw new RangeError("skill_read expects an object with a `name`")
  const o = raw as Record<string, unknown>
  if (typeof o.name !== "string" || !SKILL_NAME_RE.test(o.name)) {
    throw new RangeError("`name` must be a skill name exactly as listed under Skills")
  }
  const name = o.name
  const skillRoot = `${root}/${name}`
  let rel = DEFAULT_SKILL_FILE
  if (o.path !== undefined) {
    if (typeof o.path !== "string") throw new RangeError("`path` must be a string")
    // 相对路径拼到技能目录下再走共用的规范化：`..`、反斜杠、百分号编码都在那里拒绝，越界的说法也统一
    const resolved = resolveRootedPath(`${skillRoot}/${o.path}`, skillRoot)
    if (resolved === skillRoot)
      throw new RangeError("`path` must name a file inside the skill, not the skill itself")
    rel = resolved.slice(skillRoot.length + 1)
  }
  const out: SkillReadInput = { name, path: rel }
  if (o.range !== undefined) {
    const r = o.range
    if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n))) {
      throw new RangeError("`range` must be [start_line, end_line] with integer values")
    }
    const [start, end] = r as [number, number]
    if (start < 1) throw new RangeError("`range` start_line must be ≥ 1")
    if (end !== -1 && end < start)
      throw new RangeError("`range` end_line must be ≥ start_line, or -1 for the end")
    out.range = [start, end]
  }
  return out
}

export function skills(opts: SkillsOptions = {}): Socket {
  const root = opts.root ?? DEFAULT_SKILLS_ROOT
  if (!/^\/[^\s]*[^/\s]$/.test(root) || root.includes("//")) {
    throw new RangeError(`skills.root 必须是 "/" 起、不以 "/" 收的规范路径：${JSON.stringify(root)}`)
  }
  const maxReadChars = opts.maxReadChars ?? DEFAULT_MAX_READ_CHARS
  if (!Number.isInteger(maxReadChars) || maxReadChars < 1) {
    throw new RangeError(`skills.maxReadChars 必须是 ≥1 的整数：${String(maxReadChars)}`)
  }
  const source = opts.source
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  /** 每次 run 起步 tools 与 systemPrompt 各被解析一次，菜单只读载体一遍：按 setup 对象缓存 */
  const menus = new WeakMap<SocketSetup, Promise<SkillMenu | undefined>>()
  const menuFor = (setup: SocketSetup): Promise<SkillMenu | undefined> => {
    let p = menus.get(setup)
    if (!p) {
      p = (async () => {
        if (!source) {
          warnOnce(
            "no-source",
            "[reins/skills] 没有给 source，skill_read 工具与技能菜单未注册。传 skills({ source }) 即可开启（任何 MemoryStore、fsSkillSource、inlineSkills 都行）。",
          )
          return undefined
        }
        const menu = await loadSkillMenu(source, root)
        for (const r of menu.rejected) {
          warnOnce(`rejected:${r.path}`, `[reins/skills] 跳过不合规的技能 ${r.path}：${r.reason}`)
        }
        if (menu.skills.length === 0) {
          warnOnce(
            "empty",
            `[reins/skills] source 在 ${root}/ 下没有任何合规的 SKILL.md，skill_read 工具与技能菜单未注册。`,
          )
          return undefined
        }
        return menu
      })()
      menus.set(setup, p)
    }
    return p
  }

  const tool: Tool<SkillReadInput> = {
    name: SKILL_READ_TOOL_NAME,
    description: SKILL_READ_TOOL_DESCRIPTION,
    inputSchema: SKILL_READ_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: (raw) => parseSkillReadInput(raw, root),
    risk: "low",
    // 技能是宿主写的说明书，视同系统提示可信，不套 untrusted 标记（DECISIONS 2026-09-13）
    resultTrust: "system",
    // 结果已按 maxReadChars 裁过；token 数不会超过字符数，所以 spill 按这个限额永远不会再把它外溢成 blob——
    // 一份"先读再动手"的说明书被换成预览 + fetch_blob，等于让模型再翻一次
    resultPolicy: { maxTokens: maxReadChars, overflow: "spill" },
    async execute(input) {
      if (!source) {
        // 正常装法到不了这里（没有 source 时工具不注册）；宿主自己把工具塞进 LoopConfig.tools 才会
        return {
          content: [{ type: "text", text: "No skill source is configured; skills are unavailable." }],
          isError: true,
        }
      }
      const key = `${root}/${input.name}/${input.path}`
      const content = await source.read(key)
      if (content === null) {
        // 技能不存在、文件不存在、越界（已在 validate 拒绝）统一一句话，不泄露载体里有什么
        return {
          content: [{ type: "text", text: `Skill file ${input.name}/${input.path} does not exist.` }],
          isError: true,
        }
      }
      const view = formatFileView(`${input.name}/${input.path}`, content, {
        range: input.range,
        maxChars: maxReadChars,
        rangeField: "range",
      })
      if (view.error !== undefined) return { content: [{ type: "text", text: view.error }], isError: true }
      return { content: [{ type: "text", text: view.text }] }
    },
  }

  const socket: Socket = {
    name: SKILLS_SOCKET_NAME,
    tools: async (setup) => ((await menuFor(setup)) ? [tool as Tool] : undefined),
  }
  if (opts.rules !== false) {
    const rules = opts.rules ?? SKILL_RULES
    socket.systemPrompt = async (setup) => {
      const menu = await menuFor(setup)
      return menu ? `${rules}\n\n${renderSkillMenu(menu.skills)}` : undefined
    }
  }
  return socket
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
