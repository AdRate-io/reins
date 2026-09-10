/**
 * AdRate CLI → reins 工具。
 *
 * 每个服务端发布的操作（capabilities.json 里 `operations[]`）变成一个工具：
 * - 名字 = operationId 的点换成下划线（`ads.campaigns.status` → `ads_campaigns_status`）
 * - inputSchema = 服务端的 inputSchema 原样，只拿掉 `idempotencyKey`：幂等键由本文件按 toolCallId 生成
 *   （reins 的调用 id 在审批暂停 / 续跑前后不变，正好满足"一个键只对应一次不可变的写"）
 * - execute = 以参数数组起子进程 `adrate <命令> --flag 值 … --json --no-input`，永不拼 shell 字符串；
 *   返回 AdRate 的 JSON 信封原文（去掉 meta._notice），附 exitCode 与 idempotencyKey；`ok === false` 即 isError
 * - risk：要幂等键的写操作 high（审批模块按风险先问人），读操作 low
 * - 列表 / 报表类结果可能很大 → `resultPolicy: spill`，超限全文进 BlobStore、模型看预览
 *
 * 另有几个 CLI 本地命令（不是服务端能力，schema 命令查不到）手写：commands get / pending / resume、wait_seconds。
 * `feedback` 不给模型：Skill 明说只能在用户明确要求时提交。
 */
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { defineTool, type Tool, type ToolContext } from "reins"

const run = promisify(execFile)

interface CliFlag {
  name: string
  inputPath: string
  required: boolean
  description?: string
}
interface Operation {
  operationId: string
  method: string
  cliCommand: string
  cliFlags?: CliFlag[]
  inputSchema: { type: "object"; properties?: Record<string, Record<string, unknown>>; required?: string[] }
  examples?: { command?: string }[]
  available?: boolean
}
interface Capability {
  capabilityId: string
  risk: "low" | "medium" | "high"
  rateClass: string
  operationUnits: number
  idempotencyRequired: boolean
  operations: Operation[]
}
interface CapabilityFile {
  fetchedAt: string
  issuer: string
  cliVersion: string
  capabilities: Capability[]
}

export const CAPABILITIES: CapabilityFile = JSON.parse(
  readFileSync(new URL("./capabilities.json", import.meta.url), "utf8"),
)

/** 不暴露给模型的操作：feedback 只能由用户明确要求触发 */
const EXCLUDED = new Set(["feedback.submit"])

export const toolNameOf = (operationId: string) => operationId.replaceAll(".", "_")

/** 幂等键：`reins-<toolCallId>`，只留服务端允许的字符，最长 128 */
export function idempotencyKeyOf(toolCallId: string): string {
  return `reins-${toolCallId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)
}

export interface AdrateEnvelope {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; retryable?: boolean; details?: unknown }
  meta?: Record<string, unknown>
}

export interface AdrateResult extends AdrateEnvelope {
  /** 0 成功、1 业务失败、2 用法、3 认证、4 可重试等待、5 远端结果未知 */
  exitCode: number
  idempotencyKey?: string
  command: string
}

/** 起一次 adrate 子进程，解析信封；子进程失败也尽量给出信封（CLI 失败时也打 JSON） */
export async function adrate(argv: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AdrateResult> {
  const args = [...argv, "--json", "--no-input"]
  const command = `adrate ${args.join(" ")}`
  let stdout = ""
  let stderr = ""
  let exitCode = 0
  try {
    const res = await run("adrate", args, {
      env: { ...process.env, ADRATE_NO_SKILLS_NOTIFIER: "1" },
      timeout: opts.timeoutMs ?? 90_000,
      maxBuffer: 32 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    stdout = res.stdout
    stderr = res.stderr
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    stdout = e.stdout ?? ""
    stderr = e.stderr ?? ""
    exitCode = typeof e.code === "number" ? e.code : -1
    if (exitCode === -1 && stdout === "")
      return { ok: false, exitCode, command, error: { code: "CLI_SPAWN_FAILED", message: e.message ?? String(err) } }
  }
  // --json 约定：stdout 恰好一行信封（auth login --device 是两行，这里不用它）
  const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? ""
  let envelope: AdrateEnvelope
  try {
    envelope = JSON.parse(line) as AdrateEnvelope
  } catch {
    return {
      ok: false,
      exitCode,
      command,
      error: { code: "CLI_OUTPUT_UNPARSEABLE", message: `stdout 不是 JSON：${stdout.slice(0, 500)} ${stderr.slice(0, 500)}` },
    }
  }
  if (envelope.meta && typeof envelope.meta === "object") {
    const { _notice: _drop, ...meta } = envelope.meta as Record<string, unknown>
    envelope.meta = meta
  }
  return { ...envelope, exitCode, command }
}

/**
 * 两层契约的接缝：inputSchema 的枚举是 HTTP 线上格式（`ENABLE` / `DISABLE`），而 CLI 的 `--set` 只认小写
 * `enable` / `disable`（CLI 内部再映射成大写发 HTTP）。本工具站在 CLI 这一层，所以把模型按 schema 给的大写值转小写。
 * （2026-09-08 dogfood 还发现 ads 状态命令服务端把 flag 写成了 `--status`，属真实漂移，AdRate 已于 09-09 修复发布，
 * 重新 sync 后 flag 已是 `--set`，这里不再需要改 flag 名。）
 */
const CLI_OVERRIDES: Record<string, { flag?: Record<string, string>; lowercase?: string[] }> = {
  "ads.campaigns.status": { lowercase: ["desiredStatus"] },
  "gmvmax.campaigns.status": { lowercase: ["status"] },
}

function flagValue(v: unknown): string[] | null {
  if (v === undefined || v === null || v === false) return null
  if (v === true) return []
  return [typeof v === "string" ? v : JSON.stringify(v)]
}

/** 把模型入参按 cliFlags 排成 argv；没有对应 flag 的字段留给 --file 正文 */
function argvOf(op: Operation, input: Record<string, unknown>, key: string | undefined): { argv: string[]; body: Record<string, unknown> } {
  const argv = op.cliCommand.split(/\s+/).slice(1) // 去掉开头的 "adrate"
  const consumed = new Set<string>()
  const override = CLI_OVERRIDES[op.operationId]
  for (const f of op.cliFlags ?? []) {
    if (f.name === "--idempotency-key") {
      if (key) argv.push(f.name, key)
      consumed.add(f.inputPath)
      continue
    }
    if (f.name === "--file" || f.name === "--stdin" || f.name === "--message-stdin") continue
    let raw = input[f.inputPath]
    if (override?.lowercase?.includes(f.inputPath) && typeof raw === "string") raw = raw.toLowerCase()
    const v = flagValue(raw)
    consumed.add(f.inputPath)
    if (v === null) continue
    argv.push(override?.flag?.[f.inputPath] ?? f.name, ...v)
  }
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) if (!consumed.has(k) && k !== "idempotencyKey" && k !== "body") body[k] = v
  if (typeof input.body === "object" && input.body !== null) Object.assign(body, input.body as Record<string, unknown>)
  return { argv, body }
}

function describe(cap: Capability, op: Operation): string {
  const flags = (op.cliFlags ?? [])
    .filter((f) => f.name !== "--idempotency-key" && f.name !== "--file" && f.name !== "--stdin")
    .map((f) => `${f.inputPath}${f.required ? "" : "?"}${f.description ? ` — ${f.description}` : ""}`)
  const lines = [
    `AdRate \`${op.cliCommand}\`（capability ${cap.capabilityId}，risk ${cap.risk}，${cap.rateClass}，每次 ${cap.operationUnits} operation unit${cap.idempotencyRequired ? "，写操作：幂等键由系统按本次调用自动生成并在结果里返回" : ""}）。`,
  ]
  if (flags.length > 0) lines.push(`参数：${flags.join("；")}`)
  if ((op.cliFlags ?? []).some((f) => f.name === "--file" || f.name === "--stdin"))
    lines.push(
      op.inputSchema.properties && Object.keys(op.inputSchema.properties).length > 0
        ? "其余字段作为 JSON 正文经 --file 提交。"
        : "把要提交的 JSON 对象放在 body 字段（结构以服务端 rules_options_get 返回的 requestTemplate 为准）。",
    )
  lines.push("返回 AdRate JSON 信封原文：ok 为唯一成功判据；exitCode 4 表示需等待后重试，5 表示远端结果未知，须按 adrate-shared 契约恢复。")
  return lines.join("\n")
}

/** 服务端给每个 ID 字段配了一大段"opaque ID boundary"说明，32 个工具重复几十遍要吃掉上千 token；换成一句 */
function slimProperty(prop: Record<string, unknown>): Record<string, unknown> {
  if (typeof prop.description === "string" && prop.description.startsWith("Canonical CLI raw-path TikTok resource ID"))
    return { ...prop, description: "TikTok 资源 ID，原样字符串" }
  return prop
}

function inputSchemaOf(op: Operation): Record<string, unknown> {
  const props = Object.fromEntries(Object.entries(op.inputSchema.properties ?? {}).map(([k, v]) => [k, slimProperty(v)]))
  delete props.idempotencyKey
  const required = (op.inputSchema.required ?? []).filter((k) => k !== "idempotencyKey")
  const hasFile = (op.cliFlags ?? []).some((f) => f.name === "--file" || f.name === "--stdin")
  if (hasFile && Object.keys(props).length === 0) {
    props.body = { type: "object", description: "提交的 JSON 对象" }
    required.push("body")
  }
  for (const f of op.cliFlags ?? []) {
    // 有 flag 却不在 schema 里的字段（如 rules.update 的 ruleId）补成字符串
    if (!props[f.inputPath] && f.inputPath !== "idempotencyKey" && f.name !== "--file" && f.name !== "--stdin") {
      props[f.inputPath] = { type: "string", description: f.description ?? f.name }
      if (f.required) required.push(f.inputPath)
    }
  }
  return { type: "object", additionalProperties: false, properties: props, ...(required.length > 0 ? { required } : {}) }
}

const isBulkRead = (op: Operation) => /\.(list|report)$/.test(op.operationId)

function toolOf(cap: Capability, op: Operation): Tool {
  // 写操作 = 带幂等键的操作（copy.preview 虽属 write 能力但只是预览、无键，按读处理）
  const writes = (op.cliFlags ?? []).some((f) => f.name === "--idempotency-key")
  const hasFile = (op.cliFlags ?? []).some((f) => f.name === "--file" || f.name === "--stdin")
  return defineTool<Record<string, unknown>>({
    name: toolNameOf(op.operationId),
    description: describe(cap, op),
    inputSchema: inputSchemaOf(op),
    risk: writes ? "high" : "low",
    ...(isBulkRead(op) ? { resultPolicy: { maxTokens: 6000, overflow: "spill" as const } } : {}),
    async execute(input, ctx: ToolContext) {
      const key = writes ? idempotencyKeyOf(ctx.toolCallId) : undefined
      const { argv, body } = argvOf(op, input, key)
      let dir: string | undefined
      try {
        if (hasFile) {
          dir = await mkdtemp(join(tmpdir(), "reins-adrate-"))
          const file = join(dir, "body.json")
          await writeFile(file, JSON.stringify(body))
          argv.push("--file", file)
        }
        const result = await adrate(argv, { ...(ctx.signal ? { signal: ctx.signal } : {}) })
        if (key) result.idempotencyKey = key
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok }
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true })
      }
    },
  })
}

/** CLI 本地命令：写操作的恢复入口 */
const commandsGet = defineTool<{ commandId?: string; idempotencyKey?: string }>({
  name: "commands_get",
  description:
    "AdRate `adrate commands get`：按 commandId 或 idempotencyKey 查询一条服务端 Command 的状态与终态证据。写操作返回 exitCode 4/5 后用它对账；只有 isFinal=false 的 Command 值得有限次轮询。",
  inputSchema: {
    type: "object",
    properties: { commandId: { type: "string" }, idempotencyKey: { type: "string" } },
    additionalProperties: false,
  },
  risk: "low",
  validate(input) {
    const i = input as { commandId?: string; idempotencyKey?: string }
    if (!i.commandId && !i.idempotencyKey) throw new Error("commandId 与 idempotencyKey 至少给一个")
    return i
  },
  async execute({ commandId, idempotencyKey }, ctx) {
    const argv = ["commands", "get", ...(commandId ? ["--command-id", commandId] : ["--idempotency-key", idempotencyKey ?? ""])]
    const result = await adrate(argv, { ...(ctx.signal ? { signal: ctx.signal } : {}) })
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok }
  },
})

const commandsPending = defineTool<Record<string, never>>({
  name: "commands_pending",
  description: "AdRate `adrate commands pending`：列出本机尚未确认终态的写操作恢复记录。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "low",
  async execute(_input, ctx) {
    const result = await adrate(["commands", "pending"], { ...(ctx.signal ? { signal: ctx.signal } : {}) })
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok }
  },
})

const commandsResume = defineTool<{ idempotencyKey: string }>({
  name: "commands_resume",
  description:
    "AdRate `adrate commands resume`：用原幂等键显式恢复一条 pending 写操作（先查再按需重发原载荷）。这是写操作，须经审批。",
  inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" } }, required: ["idempotencyKey"], additionalProperties: false },
  risk: "high",
  async execute({ idempotencyKey }, ctx) {
    const result = await adrate(["commands", "resume", "--idempotency-key", idempotencyKey], {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok }
  },
})

/** 限流与异步任务轮询需要等待；模型自己决定等多久（上限 60 秒） */
const waitSeconds = defineTool<{ seconds: number; reason?: string }>({
  name: "wait_seconds",
  description: "等待若干秒再继续（RATE_LIMITED 的 Retry-After、Copy 任务轮询间隔等）。最多 60 秒。",
  inputSchema: {
    type: "object",
    properties: { seconds: { type: "number", minimum: 1, maximum: 60 }, reason: { type: "string" } },
    required: ["seconds"],
    additionalProperties: false,
  },
  risk: "low",
  validate(input) {
    const i = input as { seconds: number; reason?: string }
    if (typeof i.seconds !== "number" || !(i.seconds >= 1 && i.seconds <= 60)) throw new Error("seconds 必须在 1~60 之间")
    return i
  },
  async execute({ seconds, reason }, ctx) {
    await new Promise<void>((resolve) => {
      // 中止就提前结束；等够了要把监听器摘掉，同一个 signal 会跨多次调用复用，不然每次 wait 都留一个监听器
      const onAbort = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(() => {
        ctx.signal?.removeEventListener("abort", onAbort)
        resolve()
      }, seconds * 1000)
      ctx.signal?.addEventListener("abort", onAbort, { once: true })
    })
    return `waited ${seconds}s${reason ? `: ${reason}` : ""}`
  },
})

/** 全部工具：服务端能力生成的 + 本地命令 */
export function adrateTools(): Tool[] {
  const generated: Tool[] = []
  for (const cap of CAPABILITIES.capabilities) {
    for (const op of cap.operations) {
      if (EXCLUDED.has(op.operationId)) continue
      if (op.available === false) continue
      generated.push(toolOf(cap, op))
    }
  }
  return [...generated, commandsGet, commandsPending, commandsResume, waitSeconds]
}

// 直接执行本文件：打印工具表，肉眼核对生成结果
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  for (const t of adrateTools()) {
    const props = Object.keys((t.inputSchema.properties as Record<string, unknown>) ?? {})
    console.log(`${t.name.padEnd(30)} risk=${(t.risk ?? "-").padEnd(5)} ${t.resultPolicy ? "spill " : "      "} ${props.join(", ")}`)
  }
}
