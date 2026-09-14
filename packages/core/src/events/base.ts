/**
 * 事件基础类型（技术方案 §4）。
 *
 * 宪法二：时间线是唯一真源，角色只是翻译。内部只有一种数据 —— 带发起者的事件。
 * 本文件只定义"所有事件共有的壳"，具体载荷见 ./core.ts（内置 core.*）与宿主自定义的 ext.*。
 */

/** 事件发起者。用户打断、脑子注入、宿主插话都只是不同 actor 的一次 append。 */
export type Actor = "user" | "model" | "tool" | "system" | "host"

/**
 * 信任等级，供投影层与安全网判断"这段内容能不能当指令"。
 * - principal：主事人（用户）说的
 * - system：库或宿主注入的
 * - model：模型自己产出的
 * - untrusted：工具输出、外部抓取内容（默认值，防提示注入）
 */
export type Trust = "principal" | "system" | "model" | "untrusted"

/** 来源：哪个工具、哪个 URL、哪个用户。用于审计与信任判断。 */
export interface Provenance {
  source: string
  ref?: string
}

/**
 * 所有事件的公共字段。
 * 载荷放在 payload 下（而不是平铺），这样 schema 升级函数只碰 payload，壳永远稳定。
 */
export interface EventBase {
  /** uuidv7，时间有序；会话内唯一。fork 复制的事件保留原 id，以维持 parentId / pinsKept 等引用 */
  id: string
  sessionId: string
  /** 会话内单调递增，从 1 起；是会话内排序的唯一依据 */
  seq: number
  /** Unix 毫秒 */
  at: number
  /** 命名空间化：内置 "core.*"，宿主扩展 "ext.*" */
  type: string
  /** 该 type 自己的 schema 版本，从 1 起；读时按注册表升级（P9） */
  schemaVersion: number
  actor: Actor
  /** 因果链或分叉点：回答哪条消息、由哪次 tool_call 产生 */
  parentId?: string
  trust: Trust
  provenance?: Provenance
  /** 厂商专有回放数据（thinking signature、encrypted reasoning），不进通用字段 */
  replay?: Record<string, unknown>
}

/** 带类型载荷的事件。T 为 type 字面量，P 为 payload 形状。 */
export type Event<T extends string = string, P = unknown> = EventBase & {
  type: T
  payload: P
}

/**
 * 内容片段。用户消息、工具结果都由它组成；投影/降级时再翻译成各家 API 的 content block。
 * 文本、图片，以及"工具定义引用"（L1）；大结果不塞进片段，走 tool_result.spilled 外溢到 BlobStore。
 */
export type ContentPart = TextPart | ImagePart | ToolReferencePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image"
  mime: string
  /** base64 编码的图片字节 */
  data: string
}

/**
 * 工具定义引用（L1，2026-09-15）：`tool_find` 这类"取回工具"的结果用它表达"这几件工具从现在起可用"。
 * 带完整定义快照，日志自足（宪法二：模型可见的一切都在日志里）；翻译时按能力分两路——
 * 支持原生延迟加载的线（Anthropic `defer_loading`）只发 `tool_reference` 块、由厂商就地展开、工具表整段不变；
 * 其余线用 `renderToolReference` 展开成文本，信息等价。宿主经 HTTP 送来的用户消息不接受这种段（server 白名单）。
 */
export interface ToolReferencePart {
  type: "tool_reference"
  name: string
  description: string
  /** JSON Schema 对象，与 Tool.inputSchema 同形 */
  inputSchema: Record<string, unknown>
}

/** 引用段展开成文本的唯一写法：非原生线的降级层、UI、投影估算都调它，别各自拼 */
export function renderToolReference(part: ToolReferencePart): string {
  return `### ${part.name}\n${part.description.trim()}\nInput schema: ${JSON.stringify(part.inputSchema)}`
}

/** 各 actor 的默认信任等级；工厂函数在未显式给出 trust 时使用。 */
export const DEFAULT_TRUST: Readonly<Record<Actor, Trust>> = {
  user: "principal",
  system: "system",
  host: "system",
  model: "model",
  tool: "untrusted",
}
