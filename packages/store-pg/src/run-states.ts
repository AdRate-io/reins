/**
 * 会话运行状态快照（AdRate 建议 11 / 12）：一条 SQL 取租约与每个会话最后一条 run 标记，再交给 core `runStatusOf` 分类。
 */
import { createCoreRegistry, RUN_MARKER_TYPES, type RunStatus, runStatusOf, StoreError } from "@reinsjs/core"
import type { PgClient } from "./client.js"
import { eventOf, HELD_SQL } from "./sql.js"

/** 标记只会是 core 事件，一个注册表全包共用 */
const registry = createCoreRegistry()

/** 一次最多查多少个会话：列表页一屏足够，再多就该分页 */
export const PG_RUN_STATES_MAX = 500

/**
 * 批量查会话运行状态。结果包含每个入参 id（重复 id 合并），没有任何事件的会话为 `idle`；空数组回空 Map。
 *
 * **为什么一条 SQL**：单条语句在 READ COMMITTED 下看到语句开始时的同一份快照；而终结事件一定在释放租约之前提交
 * （release 在 run 结束后的收尾钩子里），所以快照里租约一旦不在，就一定看得到终结事件——任何时刻都处于"在跑"或"有结局"之一，
 * 不存在"先读租约、再读日志"两次查询之间的空档。
 *
 * **前提**：run 经 `@reinsjs/server` handler 起、且 handler 用租约登记（`createAgent` + `pgStores` 缺省即是）。
 * `agent.run()`、asTool 子 run、TanStack 路径不占租约：结局照样查得到，"在跑"判不出（在跑时显示为 interrupted 或 unknown）。
 *
 * 已知误判窗口（不用代码兜）：
 * - 续期抛错只告警不中止：存储持续不可用到租约过期而 run 还在跑，误判 interrupted，下一次心跳恢复后自愈；
 * - 释放失败只告警：最多 ttl（缺省 30 s）内误判 running，删除会话的"运行中拒绝"也会多拒这么久；
 * - 进程被杀：要等租约到期才显示 interrupted；
 * - run 中途 fork 出来的会话继承"未收尾"，判 interrupted；
 * - 起步时已中止的续跑 run 若恰好死在 approval_decision 与 run_paused 之间，仍显示上一个 paused(approval)。
 *
 * 删除会话前的"运行中拒绝"（建议 11）：`(await pgRunStates(client, [id])).get(id)?.state === "running"`。
 */
export async function pgRunStates(
  client: PgClient,
  sessionIds: readonly string[],
): Promise<Map<string, RunStatus>> {
  if (!Array.isArray(sessionIds)) {
    throw new StoreError("invalid_argument", `sessionIds must be an array, got ${describe(sessionIds)}`)
  }
  if (sessionIds.length > PG_RUN_STATES_MAX) {
    throw new StoreError(
      "invalid_argument",
      `sessionIds must have at most ${PG_RUN_STATES_MAX} entries, got ${sessionIds.length}`,
    )
  }
  for (const id of sessionIds) {
    if (typeof id !== "string" || id === "") {
      throw new StoreError("invalid_argument", `sessionIds must be non-empty strings, got ${describe(id)}`)
    }
  }
  const ids = [...new Set(sessionIds)]
  const out = new Map<string, RunStatus>()
  if (ids.length === 0) return out

  // 最后一条标记走主键 (session_id, seq) 倒序扫：终结标记通常就在末尾。标记类型表绑参数（$2），真源是 core 的 RUN_MARKER_TYPES
  const res = await client.query(
    `SELECT ids.session_id AS session_id,
            (r.session_id IS NOT NULL) AS held,
            m.data AS marker
       FROM unnest($1::text[]) AS ids(session_id)
       LEFT JOIN reins_runs r ON r.session_id = ids.session_id AND r.${HELD_SQL}
       LEFT JOIN LATERAL (
         SELECT e.data::text AS data FROM reins_events e
          WHERE e.session_id = ids.session_id AND e.type = ANY($2::text[])
          ORDER BY e.seq DESC LIMIT 1
       ) m ON true`,
    [ids, [...RUN_MARKER_TYPES]],
  )
  for (const row of res.rows) {
    const sessionId = String(row.session_id)
    const marker = row.marker === null || row.marker === undefined ? undefined : row.marker
    let lastMarker: ReturnType<typeof eventOf> | undefined
    if (marker !== undefined) {
      try {
        lastMarker = eventOf(marker)
      } catch {
        // 读不出的行交给 runStatusOf 判 unknown（fail-closed，不抛）
        out.set(sessionId, row.held === true ? { state: "running" } : { state: "unknown" })
        continue
      }
    }
    out.set(sessionId, runStatusOf({ held: row.held === true, lastMarker, registry }))
  }
  return out
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return value === "" ? "an empty string" : "a string"
  return typeof value
}
