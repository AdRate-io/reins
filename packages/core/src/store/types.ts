/**
 * 存储接口（技术方案 §5）。三者相互独立，允许部分实现：
 * - 只有 EventLog 就能跑
 * - 缺 BlobStore → spill 模块自动关闭并告警
 * - 缺 MemoryStore → memory 工具不注册
 *
 * 每个接口的行为契约由 ../testing 下的一致性套件定义，第三方后端跑同一套件即可自证合规。
 */
import type { Event } from "../events/base.js"

export interface ReadOptions {
  /** 起始 seq，含；缺省从 1 */
  fromSeq?: number
  /** 结束 seq，含；缺省到末尾 */
  toSeq?: number
}

/**
 * 事件日志：只 append，永不 update / delete（宪法二）。
 *
 * seq 由调用方分配（通常是 runLoop），日志只校验：同一批必须同会话、seq 从当前末尾 +1 起连续。
 * 这样并发写入者会在 append 时收到 seq_conflict，而不是静默交错 —— 乐观并发控制就这么简单。
 */
export interface EventLog {
  /** 同会话原子：整批要么全部写入，要么一个都不写 */
  append(events: readonly Event[]): Promise<void>
  /** 按 seq 升序流式读取；不存在的会话得到空流 */
  read(sessionId: string, opts?: ReadOptions): AsyncIterable<Event>
  /** 最后 n 条，按 seq 升序；不够 n 条就返回全部 */
  tail(sessionId: string, n: number): Promise<Event[]>
  /**
   * 从 fromSessionId 的 [1, atSeq] 分叉出新会话 toSessionId。
   * 事件原样复制（保留 id 与 seq，只换 sessionId），以维持 parentId / pinsKept 等会话内引用。
   * 目标会话必须为空；atSeq 超出范围报错。
   */
  fork(fromSessionId: string, atSeq: number, toSessionId: string): Promise<void>
}

export interface BlobMeta {
  mime: string
  sessionId: string
  /** 字节数 */
  size: number
  /** Unix 毫秒 */
  createdAt: number
}

/** 大对象：外溢的工具结果、附件、代码执行产物。字符串按 UTF-8 编码存储。 */
export interface BlobStore {
  put(bytes: Uint8Array | string, meta: { mime: string; sessionId: string }): Promise<{ id: string }>
  /** 不存在抛 StoreError("not_found") */
  get(id: string): Promise<{ bytes: Uint8Array; meta: BlobMeta }>
  /** 可选：分段取回 [start, end)，供模型分页读大结果；越界部分截断 */
  slice?(id: string, range: { start: number; end: number }): Promise<Uint8Array>
}

/**
 * 记忆后端：一个极简的文本 KV，键是路径。
 * 路径限定（必须在 /memories 下、禁止 ..）由 memory 工具层负责（B6），存储层只管存取。
 */
export interface MemoryStore {
  /** 所有以 prefix 开头的路径，按字典序 */
  list(prefix: string): Promise<string[]>
  /** 不存在返回 null */
  read(path: string): Promise<string | null>
  /** 覆盖写 */
  write(path: string, content: string): Promise<void>
  /** 幂等：不存在也不报错 */
  delete(path: string): Promise<void>
}

/**
 * 技能载体（技术方案 §9.9，S1）：MemoryStore 的只读子集。任何 MemoryStore（内存 / sqlite / pg）天然满足，
 * 数据库载体零新代码；文件系统载体 `fsSkillSource(dir)` 在 `@reinsjs/brain/node`。刻意不新造接口——"存哪"由宿主定。
 */
export type SkillSource = Pick<MemoryStore, "list" | "read">

/** 一套存储：只有 log 是必需的（§5 允许部分实现），`createAgent({ store })` 接收的就是它 */
export interface Stores {
  log: EventLog
  blobs?: BlobStore
  memory?: MemoryStore
}
