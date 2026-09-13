/**
 * 记忆路径的限定：只认 `/memories` 之下。规范化与穿越拒绝规则在 ../shared/paths.ts
 * （S1 抽出，与 skills 模块共用同一份纯函数；行为与文案与抽出前逐字相同，memory 的用例即是锁）。
 */
import { MAX_ROOTED_PATH_LENGTH, resolveRootedPath } from "../shared/paths.js"

export const MEMORY_ROOT = "/memories"
/** 路径长度上限：防止把整段内容当路径塞进来 */
export const MAX_MEMORY_PATH_LENGTH = MAX_ROOTED_PATH_LENGTH

/**
 * 把模型给的路径规范化成 `/memories[/segment...]`；不合法则抛 RangeError（消息面向模型，会以 isError 结果返回）。
 * @param field 出错时提示的入参名（rename 有 old_path / new_path 两个）
 */
export function resolveMemoryPath(raw: unknown, field = "path"): string {
  return resolveRootedPath(raw, MEMORY_ROOT, field)
}

export { isUnder } from "../shared/paths.js"
