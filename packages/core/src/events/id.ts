/**
 * UUID v7 生成（RFC 9562）：前 48 位为 Unix 毫秒时间戳，字典序即时间序。
 * 只用 Web 标准 crypto.getRandomValues，不引依赖（P5）。
 *
 * 同一毫秒内的多个 id 之间顺序随机 —— 会话内排序以 seq 为准，id 只需全局唯一且大致有序。
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // 48 位时间戳，大端写入 bytes[0..5]
  let ts = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff
    ts = Math.floor(ts / 256)
  }
  // 版本位：byte6 高 4 位 = 0111
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70
  // 变体位：byte8 高 2 位 = 10
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
