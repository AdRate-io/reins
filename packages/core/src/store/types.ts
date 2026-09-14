/**
 * 存储接口（技术方案 §5）。四者相互独立，允许部分实现：
 * - 只有 EventLog 就能跑
 * - 缺 BlobStore → spill 模块自动关闭并告警
 * - 缺 MemoryStore → memory 工具不注册
 * - 缺 RunLease → run 登记只在进程内（多实例部署要它，见 D4）
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

/**
 * run 租约（D4，2026-09-14）：多实例部署下"同一会话同时只允许一个 run"的跨进程登记表。
 *
 * 语义是**带过期时间的独占锁**：`acquire` 在无人持有、持有者已过期、或持有者就是自己时成功；
 * 持有者每隔一段时间 `renew` 续期，进程崩了不续期，到期后别的实例就能接手；`release` 只删自己持有的。
 * 过期判定用**存储层自己的时钟**（数据库时间），不用各实例本机时钟——租约的意义是各实例对"谁持有"达成一致，
 * 判定时钟必须唯一。三个方法都不抛"冲突"类错误，用返回值说话；存储不可用时照常抛。
 *
 * 心跳、丢租约中止、失败告警这些行为放在 `@reinsjs/server` 的 `leasedRunRegistry` 一份，store 只做三条语句。
 * 单进程部署不需要它（进程内登记表已够），`memoryStore()` 刻意不带；`InMemoryRunLease` 是参考实现与测试用。
 */
export interface RunLease {
  /**
   * 为会话占租约 ttlMs 毫秒。无人持有、持有者已过期、或持有者就是 owner（幂等，等于续期）→ true；
   * 别人仍持有且未过期 → false。
   */
  acquire(sessionId: string, owner: string, ttlMs: number): Promise<boolean>
  /** 续期：owner 仍持有且未过期 → true 并延长到 now + ttlMs；已过期、被别人接手、或从未持有 → false */
  renew(sessionId: string, owner: string, ttlMs: number): Promise<boolean>
  /** 释放：只删 owner 自己持有的那条；不是自己的、或不存在，静默返回 */
  release(sessionId: string, owner: string): Promise<void>
}

/**
 * 一套存储：只有 log 是必需的（§5 允许部分实现），`createAgent({ store })` 接收的就是它。
 * 带 `runLease` 时 `createAgent` 自动把 handler 的 run 登记表换成跨进程的租约登记（D4）。
 */
export interface Stores {
  log: EventLog
  blobs?: BlobStore
  memory?: MemoryStore
  runLease?: RunLease
}
