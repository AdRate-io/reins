/**
 * 事件的 JSONL 读写：一行一个事件。这是 fixture 文件与录像（examples 下各 recordings 目录）共用的格式。
 *
 * 读是 fail-closed 的（P9）：每一行都过注册表 `read`，旧版本升级到当前形状，未登记的类型或未来版本直接抛，
 * 报错带行号。只做字符串 ↔ 事件，不碰文件系统（本包零 node:*），读文件由调用方负责。
 */
import { createCoreRegistry, type Event, type EventSchemaRegistry } from "@reinsjs/core"

export interface ParseJsonlOptions {
  /** 有 ext.* 事件时传宿主注册表；缺省内置 core 注册表 */
  registry?: EventSchemaRegistry
}

export class JsonlParseError extends Error {
  constructor(
    readonly line: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`line ${line}: ${message}`, options)
    this.name = "JsonlParseError"
  }
}

/** 解析 JSONL 文本为事件数组（按文件顺序）。空行与只有空白的行跳过 */
export function parseEventsJsonl(text: string, opts: ParseJsonlOptions = {}): Event[] {
  const registry = opts.registry ?? createCoreRegistry()
  const out: Event[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim()
    if (line === "") continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (err) {
      throw new JsonlParseError(i + 1, "not valid JSON", { cause: err })
    }
    try {
      out.push(registry.read(raw))
    } catch (err) {
      throw new JsonlParseError(i + 1, err instanceof Error ? err.message : String(err), { cause: err })
    }
  }
  return out
}

/** 事件数组 → JSONL 文本（末尾带换行，便于追加） */
export function toEventsJsonl(events: readonly Event[]): string {
  return events.length === 0 ? "" : `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
}
