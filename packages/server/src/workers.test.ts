/**
 * 在真实的 workerd（经 miniflare）里跑 handler：证明 @reins/server + @reins/core 只用了 Workers 也有的 Web API。
 * 步骤：esbuild 把 workers.fixture.ts 连同 core 源码打成单文件 → miniflare 起 isolate → dispatchFetch。
 */
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SESSION_HEADER } from "./handler.js"
import { parseFrames, typesOf } from "./test-utils.js"

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

describe("Cloudflare Workers（miniflare / workerd）", () => {
  let mf: Miniflare

  beforeAll(async () => {
    const bundled = await build({
      entryPoints: [here("./workers.fixture.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      // 工作区包直接指到源码，不依赖先 build
      alias: { "@reins/core": here("../../core/src") },
      logLevel: "silent",
    })
    const script = bundled.outputFiles[0]?.text
    if (!script) throw new Error("esbuild 没有产出")
    // 打包结果里不该有任何 node: 内置模块（core 与 server 的硬约束）
    expect(script).not.toMatch(/from\s*["']node:/)
    expect(script).not.toMatch(/require\(["']node:/)

    mf = new Miniflare({ modules: true, script, compatibilityDate: "2026-07-30" })
    await mf.ready
  }, 60_000)

  afterAll(async () => {
    await mf?.dispose()
  })

  it("POST 起 run 并流式推到 done；GET 带 lastSeq 从日志补发；waitUntil 被挂上", async () => {
    const res = await mf.dispatchFetch("http://worker/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "2+3 等于几" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get(SESSION_HEADER)).toBe("w1")

    const frames = parseFrames(await res.text())
    expect(frames[0]).toEqual({ event: "start", data: { sessionId: "w1", fromSeq: 1, live: true } })
    expect(typesOf(frames)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "budget_usage",
      "model_text",
      "budget_usage",
    ])
    expect(frames.at(-1)).toEqual({ event: "result", data: { status: "done", sessionId: "w1", lastSeq: 6 } })

    const replay = await mf.dispatchFetch("http://worker/agent?sessionId=w1", {
      headers: { "last-event-id": "3" },
    })
    const replayed = parseFrames(await replay.text())
    expect(replayed.map((f) => f.id).filter(Boolean)).toEqual(["4", "5", "6"])
    expect(replayed.at(-1)).toEqual({ event: "end", data: { sessionId: "w1", lastSeq: 6 } })

    const stats = await (await mf.dispatchFetch("http://worker/stats")).json()
    expect(stats).toEqual({ waitUntilCalls: 1 })
  }, 30_000)
})
