/**
 * 进程内正在跑的 run 的登记处。
 *
 * 一个 run 只被驾驭一次（消费 runLoop 生成器），但可以有任意多个订阅者：发起它的 POST 连接、
 * 中途带 lastSeq 重连的 GET 连接、以及零个（客户端全走了，run 仍在后台跑完）。
 * 订阅者各自有一个小队列，谁慢谁自己攒；run 结束时最终信号（result 或 error）推给所有人并关闭队列。
 *
 * `RunRegistry` 是登记表的接口：`InMemoryRunRegistry` 只管本进程；多实例部署用 `leasedRunRegistry`（./leased-runs.ts）
 * 在它外面套一层跨进程租约。无论哪种，EventLog 的 seq 连续性校验（append 报 seq_conflict）都是最后一道闸。
 */
import type { Event, LoweringDelta, RunResult } from "@reinsjs/core"

export type RunSignal =
  | { kind: "event"; event: Event }
  | { kind: "delta"; delta: LoweringDelta }
  | { kind: "result"; result: RunResult }
  | { kind: "error"; code: string; message: string }

/** 单生产者多消费者里"每个消费者一份"的异步队列：push 不阻塞，for await 逐条取，close 后取完即结束 */
export class Channel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(item: T): void {
    if (this.closed) return
    this.buffer.push(item)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  /** 同步取走当前已攒下的全部条目（重连补发结束时用来去重） */
  drain(): T[] {
    return this.buffer.splice(0)
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = undefined
    w?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

function codeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string")
    return err.code
  return "internal"
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ActiveRun {
  private readonly subscribers = new Set<Channel<RunSignal>>()
  private final: RunSignal | undefined
  private resolveDone!: () => void
  private readonly finalizers: (() => void | Promise<void>)[] = []
  /**
   * run 结束（result 或 error）**且收尾钩子都跑完**才 resolve；Workers 用它做 waitUntil。
   * 收尾钩子里有租约释放这类要写存储的动作，不等它们 `waitUntil` 就覆盖不到。
   */
  readonly done: Promise<void>

  constructor(
    readonly sessionId: string,
    /** 宿主可用它中止 run（客户端断开且 onDisconnect="abort"） */
    readonly controller: AbortController,
  ) {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve
    })
  }

  get finished(): boolean {
    return this.final !== undefined
  }

  /** 订阅之后的所有信号；run 已结束则只收到最终信号 */
  subscribe(): Channel<RunSignal> {
    const ch = new Channel<RunSignal>()
    if (this.final !== undefined) {
      ch.push(this.final)
      ch.close()
      return ch
    }
    this.subscribers.add(ch)
    return ch
  }

  unsubscribe(ch: Channel<RunSignal>): void {
    this.subscribers.delete(ch)
    ch.close()
  }

  broadcast(signal: RunSignal): void {
    for (const ch of this.subscribers) ch.push(signal)
  }

  /**
   * 登记一个收尾钩子：run 结束时（最终信号已推给订阅者之后）按登记顺序**同步启动**，`done` 等它们全部落定。
   * 登记表用它删自己的表项、释放租约。钩子抛错 / reject 不影响别的钩子，也不让 `done` 变成 reject——
   * 各钩子自己负责告警。run 已结束时登记的钩子立刻执行。
   */
  onFinish(fn: () => void | Promise<void>): void {
    if (this.final !== undefined) {
      runFinalizer(fn)
      return
    }
    this.finalizers.push(fn)
  }

  /**
   * 消费生成器直到返回。生成器抛出（恢复校验不过、存储冲突、宿主 bug）算 error 信号 ——
   * 这时日志里未必有 core.error（runLoop 只把降级层失败记进日志），所以要单独告诉客户端。
   */
  async drive(gen: AsyncGenerator<Event, RunResult>): Promise<void> {
    try {
      while (true) {
        const step = await gen.next()
        if (step.done) {
          this.finish({ kind: "result", result: step.value })
          return
        }
        this.broadcast({ kind: "event", event: step.value })
      }
    } catch (err) {
      this.finish({ kind: "error", code: codeOf(err), message: messageOf(err) })
    }
  }

  /** 名额占了却没能开跑（补发阶段就出错）：以 error 结束，让订阅者与 waitUntil 都能收口 */
  abandon(code: string, message: string): void {
    this.finish({ kind: "error", code, message })
  }

  private finish(signal: RunSignal): void {
    if (this.final !== undefined) return
    this.final = signal
    for (const ch of this.subscribers) {
      ch.push(signal)
      ch.close()
    }
    this.subscribers.clear()
    // 钩子**同步**启动：登记表的删项必须在这一刻生效，同会话的下一个 POST 才不会撞到已结束的 run；
    // 异步部分（租约释放）接到 done 上，Workers 的 waitUntil 才覆盖得到
    const pending: Promise<void>[] = []
    for (const fn of this.finalizers) {
      const p = runFinalizer(fn)
      if (p !== undefined) pending.push(p)
    }
    this.finalizers.length = 0
    if (pending.length === 0) this.resolveDone()
    else void Promise.all(pending).then(() => this.resolveDone())
  }
}

/** 同步调一个收尾钩子；同步抛与异步 reject 都吞掉（钩子自己负责告警），返回要等的那部分 */
function runFinalizer(fn: () => void | Promise<void>): Promise<void> | undefined {
  try {
    const r = fn()
    return r instanceof Promise ? r.catch(() => {}) : undefined
  } catch {
    return undefined
  }
}

/**
 * run 登记表：同一会话同时只允许一个 run。
 *
 * - `get` **只认本进程**：返回的是本进程正在驾驭的 run，GET 重连靠它接上实时流。跨实例的 GET 补发完即止（`live: false`）——
 *   别的实例的事件流只在那个进程的内存里，转发要引入消息通道，不值；补发本就从日志读、零状态。
 * - `create` 占名额，占不到抛 `RunConflictError`（handler 翻成 409 `run_in_progress`）。异步是为了跨进程实现要问一次存储。
 */
export interface RunRegistry {
  get(sessionId: string): ActiveRun | undefined
  /**
   * 为会话占一个 run 名额。占到即登记，但还没开始跑 ——
   * 调用方先把补发做完再 `drive`，这样发起者收到的实时事件一定在补发之后、不会重复。
   */
  create(sessionId: string, controller?: AbortController): Promise<ActiveRun>
}

/** 进程内登记表：一张 Map。单实例部署的缺省；多实例部署见 `leasedRunRegistry` */
export class InMemoryRunRegistry implements RunRegistry {
  private readonly runs = new Map<string, ActiveRun>()

  get(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId)
  }

  async create(sessionId: string, controller = new AbortController()): Promise<ActiveRun> {
    if (this.runs.has(sessionId)) {
      throw new RunConflictError(sessionId)
    }
    const run = new ActiveRun(sessionId, controller)
    this.runs.set(sessionId, run)
    run.onFinish(() => {
      // 只删自己，防止结束回调晚于同会话下一个 run 的登记
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId)
    })
    return run
  }
}

export class RunConflictError extends Error {
  readonly code = "run_in_progress"
  constructor(
    readonly sessionId: string,
    /** 名额被谁占着：本进程的 run，还是（租约登记表）别的实例 */
    readonly heldBy: "process" | "lease" = "process",
  ) {
    super(
      heldBy === "lease"
        ? `[run_in_progress] Session ${sessionId} already has a run on another instance (its lease has not expired)`
        : `[run_in_progress] Session ${sessionId} already has a run in progress`,
    )
    this.name = "RunConflictError"
  }
}
