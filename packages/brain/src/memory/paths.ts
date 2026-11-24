/**
 * 记忆路径的限定：只认 `/memories` 之下。规范化与穿越拒绝规则在 ../shared/paths.ts
 * （S1 抽出，与 skills 模块共用同一份纯函数；行为与文案与抽出前逐字相同，memory 的用例即是锁）。
 */
import { MAX_ROOTED_PATH_LENGTH, resolveRootedPath } from "../shared/paths.js"

export const MEMORY_ROOT = "/memories"

/**
 * 记忆工具落进存储的键恒为 `namespace + /memories[/…]`（namespace 由宿主给、运行期才知道），所以必含一个 `memories` 段。
 * 与记忆共用一个 MemoryStore 的技能侧（skills 的 root、菜单、skill_read）凭这一条把模型可写的键一律当不存在——
 * 无论 namespace 配成什么，模型都写不出 system 信任的说明书；memory 的 namespace 校验也用它防租户前缀互相嵌套。
 * 两处判同一件事，只此一份
 */
export function hasMemorySegment(key: string): boolean {
  return key.split("/").includes(MEMORY_ROOT.slice(1))
}
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
