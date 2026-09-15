/**
 * 一致性套件对测试框架的最小要求：只要 describe / it 两个函数。
 * 断言用套件自带的 assert，不依赖任何框架的 expect，vitest / node:test / bun:test 都能直接传入。
 */
export interface TestHarness {
  describe(name: string, fn: () => void): void
  it(name: string, fn: () => Promise<void> | void): void
}

export class ConformanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConformanceError"
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ConformanceError(message)
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new ConformanceError(`${message}\n  expected: ${b}\n  actual: ${a}`)
}

/** 断言 fn 抛出带指定 code 的错误（StoreError / SchemaError 都有 code 字段） */
export async function assertThrowsCode(
  fn: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const got = (err as { code?: unknown }).code
    if (got === code) return
    throw new ConformanceError(
      `${message}\n  expected error code ${code}, got ${String(got)}: ${(err as Error).message}`,
    )
  }
  throw new ConformanceError(`${message}\n  expected ${code} to be thrown, but nothing was`)
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}
