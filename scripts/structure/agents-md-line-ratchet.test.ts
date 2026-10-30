/**
 * AGENTS.md 行数棘轮守门。
 *
 * AGENTS.md 是每次会话都要读的上下文，膨胀的代价是注意力被稀释。文档维护规范要求
 * 「守住即回收」「真源指针进全景图」「刻意不对称与 fail-open 只进清单」，这条测试把
 * 上限钉死：只许缩小，不许回涨。需要加条目时先问「范式能不能推出 / 能不能机械守门 /
 * 该不该下沉全景图」，而不是直接改这个数字。调低 = 缩文档后顺手改；调高需要 Boss 明确决定。
 *
 * 自包含：REPO_ROOT 按本文件位置 scripts/structure/ 反推。
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const AGENTS_MD_MAX_LINES = 480
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("AGENTS.md 行数棘轮", () => {
  it(`AGENTS.md 行数 ≤ ${AGENTS_MD_MAX_LINES}（只许缩小；新增条目先对照范式 / 守门 / 下沉）`, () => {
    const content = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8")
    const lineCount = content.split("\n").length
    expect(lineCount).toBeLessThanOrEqual(AGENTS_MD_MAX_LINES)
  })

  it("入口只有一份：仓库根不再有 CLAUDE.md", () => {
    // 两份入口互相指向必然漂移（2026-10-30 文档换代）
    expect(() => readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8")).toThrow()
  })
})
