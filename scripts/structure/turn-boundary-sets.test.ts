/**
 * 轮边界口径守门（全库审查 2026-11-25 #94）。
 *
 * 真源是 core `replay/replay.ts` 的 `MODEL_OUTPUT_TYPES`（经 `isModelOutput` 用）。另有三份手写的同一集合：
 * - core `projection/truncate.ts`：`splitTurns` 切轮（与 replay 互相 import 会成环，所以没调真源）
 * - brain `compact/plan.ts`：整理切点
 * - brain `perception/reading.ts`：`countModelTurns`
 * 四份当前相同；新增一种模型输出事件类型时只改真源，阈值裁剪、整理切点、感知轮数会按旧口径切轮。
 * 这里从源码文本抽出四个 Set 字面量逐一比对，任何一份漂移即失败。登记见全景图「真源索引」轮边界一行。
 *
 * 自包含：REPO_ROOT 按本文件位置 scripts/structure/ 反推。
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 抽出 `const <name>: ReadonlySet<string> = new Set([ ... ])` 里的字符串字面量，排序后返回 */
function setLiteral(relPath: string, name: string): string[] {
  const source = readFileSync(path.join(REPO_ROOT, relPath), "utf8")
  const match = new RegExp(`const ${name}\\b[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)
  if (!match) throw new Error(`${relPath}: const ${name} = new Set([...]) not found`)
  const items = [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)
  return items.sort()
}

describe("轮边界口径：四份模型输出类型集合相等", () => {
  const truth = setLiteral("packages/core/src/replay/replay.ts", "MODEL_OUTPUT_TYPES")

  it("真源非空", () => {
    expect(truth.length).toBeGreaterThan(0)
  })

  it.each([
    ["packages/core/src/projection/truncate.ts"],
    ["packages/brain/src/compact/plan.ts"],
    ["packages/brain/src/perception/reading.ts"],
  ])("%s 的 ASSISTANT_TYPES 与 isModelOutput 同一集合", (relPath) => {
    expect(setLiteral(relPath, "ASSISTANT_TYPES")).toEqual(truth)
  })
})
