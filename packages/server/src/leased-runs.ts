/**
 * 跨进程 run 登记表（D4，2026-09-14）：在进程内登记表外面套一层 `RunLease` 租约。
 *
 *   create ── 本进程已有 → 409 ──▶ lease.acquire(sessionId, owner, ttl) ── false → 409（别的实例持有）
 *                                        │ true
 *                                        ▼
 *                              InMemoryRunRegistry.create ──▶ 每 ttl/3 心跳 renew
 *                                                                  │ false（本实例被冻结超过 ttl、别人已接手）
 *                                                                  ▼
 *                                                          controller.abort() → 本 run paused(host)
 *                              run 结束（onFinish）：停心跳 + lease.release；失败只告警，靠到期自然释放
 *
 * 语义放这里一份而不是每个 store 各写一遍：心跳、丢租约中止、失败告警是登记表的行为，与用哪种数据库无关，
 * store 只做 acquire / renew / release 三条语句（`@reinsjs/store-pg` 的 `PgRunLease`）。
 *
 * 边界：
 * - `get` 只认本进程（接口约定）。跨实例的 GET 重连只补发不接实时流；要接就用 sticky session。
 * - 丢租约后 abort 是"尽量少浪费"，不是正确性所依赖的：别的实例接手后两边都往同一条会话写，后写者撞 seq_conflict，
 *   日志不会坏。ttl 只决定进程崩了之后会话被锁多久（缺省 30 s）。
 * - acquire 时存储不可用照常抛（handler 不接，冒给宿主）：不知道能不能跑就不跑，fail-closed。
 */
import { type RunLease, uuidv7 } from "@reinsjs/core"
import { type ActiveRun, InMemoryRunRegistry, RunConflictError, type RunRegistry } from "./runs.js"

export interface LeasedRunRegistryOptions {
  /** 租约时长（毫秒），心跳每 ttl/3 一次；缺省 30_000。进程崩了会话最多锁这么久，心跳三次机会才判丢 */
  ttlMs?: number
  /** 本实例的身份，租约按它区分持有者；缺省 uuidv7()。多个 handler 共用一个登记表实例时自然同一个 owner */
  owner?: string
  /** 告警出口（续期失败、释放失败、丢租约中止）；缺省 console.warn */
  warn?: (message: string) => void
}

export function leasedRunRegistry(lease: RunLease, options: LeasedRunRegistryOptions = {}): RunRegistry {
  const ttlMs = options.ttlMs ?? 30_000
  if (!Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new RangeError(`leasedRunRegistry: ttlMs 必须是正数，收到 ${ttlMs}`)
  const owner = options.owner ?? uuidv7()
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const heartbeatMs = Math.max(1, Math.floor(ttlMs / 3))
  const local = new InMemoryRunRegistry()

  return {
    get: (sessionId) => local.get(sessionId),

    async create(sessionId, controller = new AbortController()) {
      // 本进程已有：不必问存储
      if (local.get(sessionId) !== undefined) throw new RunConflictError(sessionId, "process")
      if (!(await lease.acquire(sessionId, owner, ttlMs))) throw new RunConflictError(sessionId, "lease")
      // 同进程两个请求并发到这里：acquire 对同一 owner 幂等都成功，这一步只让先到者登记；后到者抛出、租约仍归先到者
      let run: ActiveRun
      try {
        run = await local.create(sessionId, controller)
      } catch (err) {
        // 名额被本进程别的 run 占着，不释放（租约是它的）；其它错误说明本进程出了问题，把刚占的租约还回去
        if (!(err instanceof RunConflictError)) await lease.release(sessionId, owner).catch(() => {})
        throw err
      }

      let lost = false
      const timer = setInterval(() => {
        if (run.finished || lost) return
        lease.renew(sessionId, owner, ttlMs).then(
          (ok) => {
            if (ok || run.finished || lost) return
            lost = true
            clearInterval(timer)
            warn(
              `[reins/server] 会话 ${sessionId} 的 run 租约已丢失（本实例被冻结超过 ${ttlMs} ms 或别的实例已接手），中止本 run；它将以 paused(host) 收场，可续跑`,
            )
            run.controller.abort()
          },
          (err: unknown) => {
            // 存储暂时不可用：不中止（可能只是抖动），下次心跳再试；真丢了会有别的实例接手、seq_conflict 兜底
            warn(
              `[reins/server] 会话 ${sessionId} 的 run 租约续期失败：${messageOf(err)}。本 run 继续，下次心跳再试`,
            )
          },
        )
      }, heartbeatMs)

      run.onFinish(async () => {
        clearInterval(timer)
        try {
          await lease.release(sessionId, owner)
        } catch (err) {
          warn(
            `[reins/server] 会话 ${sessionId} 的 run 租约释放失败：${messageOf(err)}。${ttlMs} ms 后自然过期`,
          )
        }
      })
      return run
    },
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
