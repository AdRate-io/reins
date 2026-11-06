/**
 * HTTP 进行中投递的内存信箱（AdRate 建议 6，2026-11-06 方案）。
 *
 * 每个由 handler 普通 POST 起的 run 一个信箱（`HandlerOptions.midRunInput` 开启时），与 run 同生同灭：
 * - 进行中的 POST 把用户消息草稿放进来（`offer`），回 202；
 * - run 每次调模型前经 `pullInput` 拿走**快照**（不删）；
 * - 只有看到 run 真把它写进时间线（yield 出带同一 `deliveryId` 的 `core.user_message`）才认领删除（`claim`）。
 *
 * 为什么取出不删：core 拉完若发现已中止就不写，取出即删会让被停止那一刻的消息凭空消失；
 * 送达判据只有一条——时间线里出现这条消息（宪法二），run 结束时箱里剩下的就是未送达，随信箱丢弃，客户端按时间线判。
 */
import type { Event, EventDraft, RunResult } from "@reinsjs/core"

/** 带 deliveryId 的用户消息的 `provenance.source`；`provenance.ref` 就是 deliveryId */
export const USER_DELIVERY_SOURCE = "reins.delivery"

/** 未写入条数上限：远高于真人打字速度，挡的是已授权客户端在长工具批期间无界塞消息 */
export const MAILBOX_LIMIT = 16

export type OfferOutcome = "queued" | "duplicate" | "full"

export class Mailbox {
  /** 未写入的草稿，按到达顺序（Map 保插入序） */
  private readonly unwritten = new Map<string, EventDraft>()
  /** 本 run 见过的 deliveryId（含起步 input 的、已写入的）：同一 run 内幂等 */
  private readonly seen = new Set<string>()
  private closedFlag = false

  constructor(
    /** 发起 run 的主事人 id；匿名为 undefined。投递者必须与它相同 */
    readonly starterId: string | undefined,
    /** 起步 input 自带的 deliveryId：重试同一条消息不该再入箱 */
    startDeliveryId?: string,
  ) {
    if (startDeliveryId !== undefined) this.seen.add(startDeliveryId)
  }

  get closed(): boolean {
    return this.closedFlag
  }

  /** 收一条投递。调用方须先确认未关闭；同步完成（从 `runs.get` 到这里不能有 await） */
  offer(deliveryId: string, draft: EventDraft): OfferOutcome {
    if (this.seen.has(deliveryId)) return "duplicate"
    if (this.unwritten.size >= MAILBOX_LIMIT) return "full"
    this.seen.add(deliveryId)
    this.unwritten.set(deliveryId, draft)
    return "queued"
  }

  /** `pullInput` 的实现：当前全部未写入草稿的副本，不删 */
  snapshot(): EventDraft[] {
    return [...this.unwritten.values()]
  }

  /** run 已把这条写进时间线：从未写入表删除，腾出一格 */
  claim(deliveryId: string): void {
    this.unwritten.delete(deliveryId)
  }

  /** run 结束：关闭并丢弃未写入的（未送达） */
  close(): void {
    this.closedFlag = true
    this.unwritten.clear()
  }
}

/**
 * 认领包装：run 每 yield 一条投递来的 `core.user_message` 就按 ref 认领。
 * 认领在转交给下游之前完成；core 在 append 后逐条 yield 写入的事件、中间不查中止，
 * 下一次 `pullInput` 只会在下游拉下一条之后发生，所以一批写入必然全部认领、下次快照不会重复给。
 */
export async function* claiming(
  gen: AsyncGenerator<Event, RunResult>,
  mailbox: Mailbox,
): AsyncGenerator<Event, RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
    const event = step.value
    const ref = event.provenance?.ref
    if (
      event.type === "core.user_message" &&
      event.provenance?.source === USER_DELIVERY_SOURCE &&
      ref !== undefined
    ) {
      mailbox.claim(ref)
    }
    yield event
  }
}
