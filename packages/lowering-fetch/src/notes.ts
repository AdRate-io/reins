/**
 * 脑子说明与摘要落成文本时的包装。文案与 @reinsjs/lowering-pi 保持一致（模型在两条降级路线上看到同样的框），
 * 但两包互不依赖，这里各留一份——它们不是"同一个值两处比对"，只是同一段提示语。
 */
import type { SystemNotePayload } from "@reinsjs/core"

/** 不支持中途 system 的模型：用标签框住走 user 角色，让模型知道这不是用户说的 */
export function framedSystemNote(kind: SystemNotePayload["kind"], text: string): string {
  return `<system_note kind="${kind}">\n${text}\n</system_note>`
}

/** compaction 摘要以 user 文本呈现时的前缀 */
export function framedSummary(summary: string): string {
  return `[Summary of earlier conversation]\n${summary}`
}
