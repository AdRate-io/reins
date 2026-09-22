/**
 * Socket 静态贡献的解析（B2 引入，B6 抽出）：宿主工具 + 各 Socket 带来的工具与规则提示 → 整个 run 不变的工具表与系统提示。
 *
 * 为什么单独成文件：configHash 就是按这里的结果算的，循环起步与 server 的恢复预校验必须用**同一份**算法，
 * 否则装了带静态贡献的模块（compact / pins / spill / memory…）后，预校验会把合法的续跑当成配置漂移。
 *
 * 贡献可以是常量，也可以是按运行环境算一次的函数（`StaticContribution`，可异步）：函数只在这里被调用一次，
 * 所以 Socket 不能靠它做每轮的事 —— 每轮的改动走 beforeModel 补丁（代价是缓存前缀重算）。
 */
import type { LoopConfig, Socket, SocketSetup, StaticContribution, Tool } from "./types.js"

export interface ResolvedContributions {
  tools: readonly Tool[]
  systemPrompt?: string
}

/** 能算出静态贡献所需的配置子集：AgentDefinition（跨请求不变）加上本次请求的 principal */
export type ContributionConfig = Pick<
  LoopConfig,
  "log" | "blobs" | "memory" | "model" | "principal" | "tools" | "sockets" | "systemPrompt"
>

async function resolve<T>(
  contribution: StaticContribution<T> | undefined,
  setup: SocketSetup,
): Promise<T | undefined> {
  if (typeof contribution === "function")
    return await (contribution as (s: SocketSetup) => T | undefined | Promise<T | undefined>)(setup)
  return contribution
}

/**
 * 宿主工具 + 各 Socket 的静态工具（同名以宿主为准，宿主想覆盖模块的默认实现时用）；
 * 宿主系统提示在前，各 Socket 的规则片段按注册顺序追加，空行分隔；都没有则 undefined。
 *
 * 异步（P1）：贡献函数可以 await（MCP 的 `tools/list`）。各 Socket 仍按注册顺序**依次**解析而不是并发 ——
 * 同名去重以先到者为准，顺序一变 configHash 就变，续跑会被误判配置漂移。
 *
 * 每个 Socket 拿到**自己的一份** `SocketSetup`（2026-09-22）：`tools` 是到它为止已并入的工具表快照，让后面的 Socket 看见前面的贡献
 * （lazy-tools 把 MCP 工具收进菜单靠这个）。同一个 Socket 的 `tools` 与 `systemPrompt` 两次解析拿同一个对象——模块按对象缓存
 * "算一次"的结果（lazy-tools / skills 都这么做），拆成两个对象会让它们算两遍、菜单与工具可能对不上。
 */
export async function resolveSocketContributions(cfg: ContributionConfig): Promise<ResolvedContributions> {
  const hostTools: readonly Tool[] = cfg.tools ?? []
  const sockets: readonly Socket[] = cfg.sockets ?? []
  const base: Omit<SocketSetup, "tools"> = {
    log: cfg.log,
    model: cfg.model,
    hostTools,
    ...(cfg.blobs ? { blobs: cfg.blobs } : {}),
    ...(cfg.memory ? { memory: cfg.memory } : {}),
    ...(cfg.principal ? { principal: cfg.principal } : {}),
  }

  const tools = [...hostTools]
  const names = new Set(hostTools.map((t) => t.name))
  const prompts: string[] = []
  if (typeof cfg.systemPrompt === "string" && cfg.systemPrompt.trim().length > 0)
    prompts.push(cfg.systemPrompt)

  for (const s of sockets) {
    // 快照而不是共享 `tools` 数组：本 Socket 自己的贡献并入后，它手里的表不该跟着变
    const setup: SocketSetup = { ...base, tools: [...tools] }
    for (const t of (await resolve(s.tools, setup)) ?? []) {
      if (names.has(t.name)) continue
      names.add(t.name)
      tools.push(t)
    }
    const prompt = await resolve(s.systemPrompt, setup)
    if (typeof prompt === "string" && prompt.trim().length > 0) prompts.push(prompt)
  }

  return prompts.length > 0 ? { tools, systemPrompt: prompts.join("\n\n") } : { tools }
}
