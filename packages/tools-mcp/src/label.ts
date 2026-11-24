/**
 * 传输标签（`McpTransport.label`）的唯一出口：宿主显式给的优先，否则用配方算出的缺省值。
 *
 * 标签会进 `Socket.name`、告警与建连 / `tools/list` 报错——run 中途重建失败时报错会成为 isError 的 tool_result 文本，
 * 写进只 append 的日志并发给模型厂商。所以缺省值只取一定不含密钥的部分（HTTP 的 origin、stdio 的命令），
 * 想要更可读的名字由宿主显式给（它知道里面没有密钥）。
 */
import { kindOf } from "./route-pool.js"

export function transportLabel(label: unknown, fallback: string): string {
  if (label === undefined) return fallback
  if (typeof label !== "string" || label === "")
    throw new TypeError(`label must be a non-empty string, got ${kindOf(label)}`)
  return label
}
