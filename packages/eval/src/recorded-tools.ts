/**
 * 从录像回放的确定性工具（§13"fixture = 一段事件日志"的落地）。
 *
 * 真实长任务录下来之后，工具那一侧的世界（报表、列表、命令终态）就冻结在日志里了：
 * 模型再问同一个问题，就给它当时的答案。这样三个臂面对的是同一个世界，差异只来自脑子；
 * 也不用为了跑 eval 再去碰真服务（AdRate 写操作有副作用、还要审批）。
 *
 * 匹配规则（按顺序）：
 * 1. 同名 + 入参逐字相同（键排序后的 JSON）→ 录下的那次结果；同参多次录过的按顺序轮着给，用完了回到第一次
 * 2. 没匹配上 → `fallback(name, args)`（fixture 作者补的合成答案），有就用
 * 3. 还没有 → `sequence: true` 时给该工具下一条没用过的录像结果（模型换了写法但意图相近的场景）
 * 4. 都没有 → isError 结果，告诉模型这个入参没有可用的数据
 *
 * 录像里已外溢（`spilled`）的结果，日志里只剩预览与 blob id，全文在原会话的 BlobStore 里；
 * 回放时原样给预览（blob 不在），`stats.spilled` 记数，fixture 作者要么录制时关外溢、要么用 fallback 补全文。
 */
import type { ContentPart, CoreEventOf, Event, Tool, ToolContext, ToolResult } from "@reins/core"

export interface RecordedToolSpec {
  description?: string
  inputSchema?: Record<string, unknown>
  risk?: Tool["risk"]
  needsApproval?: Tool["needsApproval"]
  /** 结果处置（如 spill）：只有装了 spill 模块的臂会消费，无脑子臂照样拿全文 */
  resultPolicy?: Tool["resultPolicy"]
}

export interface RecordedToolsOptions {
  /** 各工具的模型可见声明；录像里没有 schema，缺省给一个宽松的 object 与一句通用说明 */
  specs?: Record<string, RecordedToolSpec>
  /** 没有逐字匹配时的合成答案；返回 undefined 表示不补 */
  fallback?: (
    name: string,
    args: unknown,
    ctx: ToolContext,
  ) => Promise<ToolResult | undefined> | ToolResult | undefined
  /** 允许按顺序给同名的下一条没用过的录像结果（缺省 false：宁可告诉模型没数据，也不给错误的答案） */
  sequence?: boolean
  /** 只为这些工具建回放（缺省录像里出现过的全部） */
  only?: readonly string[]
}

export interface RecordedToolset {
  tools: Tool[]
  stats: {
    /** 录像里配对成功的 tool_call → tool_result 次数 */
    pairs: number
    /** 每个工具录了几次 */
    byName: Record<string, number>
    /** 录像里外溢过的结果数（回放只剩预览） */
    spilled: number
    /** 没有结果的 tool_call（录制时被拒 / 暂停未续跑），不进回放 */
    unanswered: number
  }
}

interface RecordedCall {
  key: string
  result: ToolResult
}

/** 键排序后的稳定 JSON，让 {a:1,b:2} 与 {b:2,a:1} 视为同一入参 */
export function canonicalArgs(args: unknown): string {
  return JSON.stringify(sortKeys(args))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function recordedTools(recording: readonly Event[], opts: RecordedToolsOptions = {}): RecordedToolset {
  const results = new Map<string, CoreEventOf<"core.tool_result">>()
  for (const e of recording) {
    if (e.type === "core.tool_result") {
      const r = e as CoreEventOf<"core.tool_result">
      results.set(r.payload.toolCallId, r)
    }
  }

  const byName = new Map<string, RecordedCall[]>()
  const stats: RecordedToolset["stats"] = { pairs: 0, byName: {}, spilled: 0, unanswered: 0 }
  for (const e of recording) {
    if (e.type !== "core.tool_call") continue
    const call = e as CoreEventOf<"core.tool_call">
    const { name, toolCallId, args } = call.payload
    if (opts.only && !opts.only.includes(name)) continue
    const r = results.get(toolCallId)
    if (!r) {
      stats.unanswered++
      continue
    }
    if (r.payload.spilled) stats.spilled++
    stats.pairs++
    stats.byName[name] = (stats.byName[name] ?? 0) + 1
    const list = byName.get(name) ?? []
    list.push({
      key: canonicalArgs(args),
      result: { content: r.payload.content, isError: r.payload.isError },
    })
    byName.set(name, list)
  }

  const tools: Tool[] = []
  for (const [name, calls] of byName) {
    const spec = opts.specs?.[name] ?? {}
    // 同参多次：按调用顺序轮着给（分页翻到同一页两次也拿到同一份）
    const cursor = new Map<string, number>()
    const used = new Set<number>()
    const tool: Tool = {
      name,
      description: spec.description ?? `Replays recorded results of "${name}" from a previous real session.`,
      inputSchema: spec.inputSchema ?? { type: "object", additionalProperties: true },
      ...(spec.risk !== undefined ? { risk: spec.risk } : {}),
      ...(spec.needsApproval !== undefined ? { needsApproval: spec.needsApproval } : {}),
      ...(spec.resultPolicy !== undefined ? { resultPolicy: spec.resultPolicy } : {}),
      async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        const key = canonicalArgs(input)
        const matches = calls.map((c, i) => (c.key === key ? i : -1)).filter((i) => i >= 0)
        if (matches.length > 0) {
          const n = cursor.get(key) ?? 0
          const idx = matches[n % matches.length] as number
          cursor.set(key, n + 1)
          used.add(idx)
          return (calls[idx] as RecordedCall).result
        }
        const fb = await opts.fallback?.(name, input, ctx)
        if (fb) return fb
        if (opts.sequence) {
          const next = calls.findIndex((_, i) => !used.has(i))
          if (next >= 0) {
            used.add(next)
            return (calls[next] as RecordedCall).result
          }
        }
        return noRecording(name, input)
      },
    }
    tools.push(tool)
  }
  return { tools, stats }
}

function noRecording(name: string, input: unknown): ToolResult {
  const content: ContentPart[] = [
    {
      type: "text",
      text: `No recorded response for ${name} with these arguments: ${JSON.stringify(input)}. This is a replayed environment; only previously observed calls have data. Try the arguments you used before, or proceed with what you already have.`,
    },
  ]
  return { content, isError: true }
}
