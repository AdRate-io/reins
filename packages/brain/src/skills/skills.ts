/**
 * skills —— 技能模块（技术方案 §9.9，S1）：Agent Skills（SKILL.md）的加载与渐进式披露。
 *
 * 库只做两件事（宪法一）：
 * - **让它看见**：系统提示里一份菜单（每个技能的 name + description），run 起步从 `SkillSource` 读一次、run 内不变。
 *   菜单进 configHash：暂停期间技能的 **name / description** 变了，续跑按配置漂移处理（与工具表同规则）；
 *   只改 SKILL.md **正文**不动菜单、不进 hash，续跑照常，模型下次 `skill_read` 读到的是新正文
 * - **给它能力**：`skill_read({ name, path?, range? })` 翻书，正文以 `tool_result` 进时间线而不塞 system——
 *   compact 折叠、`recall` 取回、spill 外溢零改动自动适用（宪法二）
 * 读哪份、什么时候读是模型的判断；规则提示只给经验（rules.ts）。
 *
 * 载体接口不新造：`SkillSource = Pick<MemoryStore, "list" | "read">`，任何 MemoryStore 都是数据库载体，
 * 文件系统载体 `fsSkillSource(dir)` 在 `@reinsjs/brain/node`，字符串预填用 `inlineSkills({...})`。
 * 布局 `${root}/<name>/SKILL.md` + 同目录附件，`root` 缺省 `/skills`；同一个 MemoryStore 同时给 memory（/memories）
 * 与本模块（/skills）时，模型的 memory 工具够不到技能——技能对模型天然只读、对宿主可写。
 * 因此 `root` **不得**与 `/memories` 相同或互为前缀（构造期拒绝）：否则模型用 memory 工具写一份 SKILL.md，下一 run 就进了
 * 系统提示、读出来还是 system 信任——正是下面禁止的事。
 *
 * trust 模型：技能是宿主配置的说明书，视同系统提示可信，`skill_read` 声明 `resultTrust: "system"`，结果不套 untrusted 标记。
 * 这条豁免的代价由宿主承担——技能正文来自哪（本地目录、数据库、AdRate 这样的网络 CLI）就信谁；宿主若给模型任何能写进
 * 技能载体的工具，等于让模型给自己写 system 信任的说明书。第三期若允许模型写技能，模型写的必须回到 untrusted。
 * 同一份正文被 compact 折叠后经 `recall` 取回、或被 spill 外溢后经 `fetch_blob` 取回时是 untrusted（那两个工具没有豁免）——
 * 方向保守，不是 bug；正常装法下 skill_read 的结果不会被 spill 外溢（见 resultPolicy）。
 *
 * 缺 source、source 下没有一份合规的 SKILL.md、或宿主自己的工具表里已有同名 `skill_read`：按 §5"缺则不注册"——
 * 工具与菜单都不出现，告警一次；注册一个空菜单加一个一用就"不存在"的工具、或让菜单指向宿主的另一个同名工具，
 * 都只会让模型撞墙。不合规的技能单独跳过并告警一次，不拖垮整个菜单。
 * 不做：脚本执行（子进程越硬约束，技能要的动作宿主用普通 Tool 暴露）、热刷新、`allowed-tools` 等私有字段。
 */
import type { SkillSource, Socket, SocketSetup, Tool } from "@reinsjs/core"
import { MEMORY_ROOT } from "../memory/paths.js"
import { resolveRootedPath } from "../shared/paths.js"
import { formatFileView } from "../shared/view.js"
import { DEFAULT_SKILLS_ROOT, SKILL_FILE_NAME, SKILL_NAME_RE } from "./constants.js"
import { parseSkillMarkdown } from "./frontmatter.js"
import {
  renderSkillMenu,
  SKILL_READ_INPUT_SCHEMA,
  SKILL_READ_TOOL_DESCRIPTION,
  SKILL_READ_TOOL_NAME,
  SKILL_RULES,
  type SkillMenuEntry,
} from "./rules.js"

export interface SkillsOptions {
  /**
   * 技能载体。不给（或按环境算出 undefined）则模块不注册任何东西并告警一次——
   * 宿主按"这个环境有没有技能库"条件装配时可以直接透传可能为 undefined 的值
   */
  source?: SkillSource | undefined
  /** 载体里技能的键前缀，缺省 `/skills`；须是 `/` 起、不以 `/` 收、不含 `.` / `..` 段的规范路径，且不能与 `/memories` 重叠 */
  root?: string
  /**
   * `skill_read` 单次最多返回的字符数（正文部分，硬上限：带 range 也截、超长单行切开）。缺省 40000：
   * Agent Skills 规范建议 SKILL.md 不超过 500 行（约 40k 字符），而两族真模型实测都不会按截断提示续读一份"动手前先读"的说明书
   * （2026-09-13 AdRate 24.5k 字符的 SKILL.md 在 16k 上限下被截掉 110 行，DeepSeek 与 Claude 都直接开工），
   * 所以缺省要让规范内的技能一次读完；比 memory view 的 16000 大是有意的
   */
  maxReadChars?: number
  /**
   * 规则提示的经验部分：缺省内置英文 `SKILL_RULES`；传字符串替换（菜单仍自动排在其后）；
   * false 则完全不碰系统提示——工具仍注册，菜单由宿主自己排（`renderSkillMenu` / `loadSkillMenu` 可用）。
   * 代价：菜单不在本模块的贡献里就不进 configHash，暂停期间技能表变化续跑察觉不到；宿主自己排的菜单进了宿主 systemPrompt 才算
   */
  rules?: string | false
  /** 告警出口（缺 source、无合规技能、某份 SKILL.md 不合规、载体读失败），每个 skills() 实例对每个原因只告警一次。缺省 console.warn */
  warn?: (message: string) => void
}

export const SKILLS_SOCKET_NAME = "skills"
export const DEFAULT_SKILL_READ_CHARS = 40_000

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
 * 从载体读菜单：`${root}/<name>/SKILL.md` 每份整个读出来解析头部（MemoryStore 只有整读），`name` 须与目录名一致。
 * 纯函数（只读载体），菜单与测试共用。结果按 name 排序，与载体返回顺序无关——菜单进 configHash，顺序抖动会误判配置漂移。
 * 载体抛错原样上抛：run 起步失败、日志零事件（fail-closed，宿主看到的是 runLoop 抛错而不是一个没技能的 run）。
 */
export async function loadSkillMenu(source: SkillSource, root = DEFAULT_SKILLS_ROOT): Promise<SkillMenu> {
  const prefix = `${root}/`
  const keys = (await source.list(prefix)).filter((k) => k.startsWith(prefix))
  const skillFile = new RegExp(`^${escapeRegExp(prefix)}([^/]+)/${escapeRegExp(SKILL_FILE_NAME)}$`)
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
  let rel = SKILL_FILE_NAME
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

/** root 必须是规范的绝对路径（`/a/b`，无空段、无 `.`/`..`），且不能与记忆根相同或互为前缀 */
export function assertSkillsRoot(root: string): void {
  const segments = root.split("/")
  const bad =
    !root.startsWith("/") ||
    segments.length < 2 ||
    segments.slice(1).some((s) => s.length === 0 || s === "." || s === ".." || /\s/.test(s))
  if (bad) {
    throw new RangeError(
      `skills.root 必须是 "/" 起、不以 "/" 收、不含空段与 . / .. 的规范路径：${JSON.stringify(root)}`,
    )
  }
  if (root === MEMORY_ROOT || root.startsWith(`${MEMORY_ROOT}/`) || MEMORY_ROOT.startsWith(`${root}/`)) {
    throw new RangeError(
      `skills.root ${JSON.stringify(root)} 与记忆根 ${MEMORY_ROOT} 重叠：模型能用 memory 工具写进去的东西不能当技能（system 信任）`,
    )
  }
}

export function skills(opts: SkillsOptions = {}): Socket {
  const root = opts.root ?? DEFAULT_SKILLS_ROOT
  assertSkillsRoot(root)
  const maxReadChars = opts.maxReadChars ?? DEFAULT_SKILL_READ_CHARS
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

  /** 每次 run 起步 tools 与 systemPrompt 各被解析一次，菜单只读载体一遍：按 setup 对象缓存（跨 run 不复用，技能表下一 run 刷新） */
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
        if (setup.hostTools.some((t) => t.name === SKILL_READ_TOOL_NAME)) {
          // 同名以宿主为准（resolveSocketContributions 去重规则）：本模块的工具会被丢掉，菜单却仍会指向"skill_read"——
          // 那是宿主的另一个工具、语义与 trust 都不同。宁可整个不注册
          warnOnce(
            "host-tool",
            `[reins/skills] 宿主工具表里已有同名工具 ${SKILL_READ_TOOL_NAME}，本模块的工具与菜单未注册。换掉宿主那个工具的名字即可。`,
          )
          return undefined
        }
        const menu = await loadSkillMenu(source, root)
        for (const r of menu.rejected) {
          warnOnce(`rejected:${r.path}:${r.reason}`, `[reins/skills] 跳过不合规的技能 ${r.path}：${r.reason}`)
        }
        if (menu.skills.length === 0) {
          warnOnce(
            "empty",
            `[reins/skills] source 在 ${root}/ 下没有任何合规的 SKILL.md，skill_read 工具与技能菜单未注册。检查：① 载体的 root 是否与 skills({ root }) 一致（都缺省 ${DEFAULT_SKILLS_ROOT}）；② 目录布局须是 <root>/<name>/${SKILL_FILE_NAME}（fsSkillSource 的 dir 按 process.cwd() 解析，最好传绝对路径）；③ 头部的 name 须与目录名一致。`,
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
    // spill 永远不该把技能正文换成预览 + fetch_blob（那等于让模型再翻一次，且取回来的是 untrusted）。
    // 视图有硬上限（enforceLimit）：正文 ≤ maxReadChars 字符 + 每行 7 个 ASCII 行号字符 + 一行表头 / 提示；
    // core 粗估 ASCII 4 字 1 token、非 ASCII 1 字 1 token，行数 ≤ maxReadChars / 2（每行至少一字加换行），
    // 所以 token 上界 = maxReadChars（正文全是非 ASCII 的最坏情形）+ 2 × (maxReadChars / 2)（行号）+ 表头 ≤ 2 × maxReadChars + 256。
    // 发前审查：此前按"token ≤ 字符"取 maxReadChars，中文技能会被外溢
    resultPolicy: { maxTokens: 2 * maxReadChars + 256, overflow: "spill" },
    async execute(input) {
      if (!source) {
        // 类型上 source 可为 undefined；实际没有 source 时 tools() 不注册本工具，此分支只为类型收窄
        return {
          content: [{ type: "text", text: "No skill source is configured; skills are unavailable." }],
          isError: true,
        }
      }
      const key = `${root}/${input.name}/${input.path}`
      let content: string | null
      try {
        content = await source.read(key)
      } catch (err) {
        // 载体故障（数据库断了、磁盘 EIO）：告警给宿主看细节，模型只知道"现在读不到"——错误文案可能带宿主路径或连接串
        warnOnce(`read-failed:${String(err)}`, `[reins/skills] 读取 ${key} 失败：${String(err)}`)
        return {
          content: [
            { type: "text", text: `Skill file ${input.name}/${input.path} could not be read right now.` },
          ],
          isError: true,
        }
      }
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
        enforceLimit: true,
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
