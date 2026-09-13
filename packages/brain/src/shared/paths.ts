/**
 * 根目录限定的路径规范化（技术方案 §9.6 / §9.9 / §13）：memory 与 skills 两个模块共用的**同一份**纯函数。
 *
 * 模型给的路径先过这里再碰存储。规则宁严勿宽：
 * - 必须是 `root` 本身或以 `${root}/` 开头（大小写敏感）
 * - 不接受 `.` / `..` 段、反斜杠、百分号编码（`%2e%2e%2f` 一类）、控制字符
 * - 重复斜杠与末尾斜杠折叠掉，得到唯一的规范形态 —— 同一个文件只有一个键
 * - 段首尾不能有空白（"a " 与 "a" 在存储里是两个键，模型分不出来）
 *
 * 存储层只见规范路径（可能再加宿主的命名空间前缀），所以后端不需要再做一遍防穿越；
 * 但后端若映射到真实文件系统，仍应把这里的输出当相对路径拼到根目录下，而不是当绝对路径用。
 * 两处比对同一个值必须调同一个函数（踩坑记录里 configHash / pendingDigest 的教训），所以它只有这一份。
 */

/** 路径长度上限：防止把整段内容当路径塞进来 */
export const MAX_ROOTED_PATH_LENGTH = 1024

/**
 * 把模型给的路径规范化成 `${root}[/segment...]`；不合法则抛 RangeError（消息面向模型，会以 isError 结果返回）。
 * @param root 必须是已规范的绝对根（如 `/memories`、`/skills/adrate-ads`）
 * @param field 出错时提示的入参名（memory 的 rename 有 old_path / new_path 两个）
 */
export function resolveRootedPath(raw: unknown, root: string, field = "path"): string {
  const reject = (why: string): never => {
    throw new RangeError(`Invalid \`${field}\`: ${why}. Paths must be absolute and stay under ${root}.`)
  }
  if (typeof raw !== "string") return reject("expected a string")
  const p = raw.trim()
  if (p.length === 0) return reject("it is empty")
  if (p.length > MAX_ROOTED_PATH_LENGTH)
    return reject(`it is longer than ${MAX_ROOTED_PATH_LENGTH} characters`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里就是要拒绝控制字符
  if (/[\u0000-\u001f\u007f]/.test(p)) return reject("it contains control characters")
  if (p.includes("\\")) return reject("backslashes are not allowed, use forward slashes")
  if (/%[0-9a-f]{2}/i.test(p)) return reject("percent-encoded sequences are not allowed")
  if (p !== root && !p.startsWith(`${root}/`)) {
    return reject(`it must be ${root} or start with ${root}/`)
  }

  const segments = p.split("/").filter((s) => s.length > 0) // 折叠 // 与末尾 /
  for (const s of segments) {
    if (s === "." || s === "..") return reject("`.` and `..` segments are not allowed")
    if (s !== s.trim()) return reject("a path segment starts or ends with whitespace")
  }
  return `/${segments.join("/")}`
}

/** 目录 a 是否包含路径 b（b 在 a 之下，不含相等） */
export function isUnder(dir: string, path: string): boolean {
  return path.startsWith(`${dir}/`)
}
