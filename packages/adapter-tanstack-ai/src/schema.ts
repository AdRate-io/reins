/**
 * 手写的 Standard Schema（同时满足 StandardSchemaV1 与 StandardJSONSchemaV1）。
 *
 * TanStack 的 `defineInterrupt` 只接受 Standard Schema（zod / valibot / arktype 那类），不接受裸 JSON Schema 对象；
 * 本包不想为两个小形状引入校验库，就按规范把 `~standard` 三件套（version / vendor / jsonSchema + validate）自己写出来。
 * TanStack 用 `jsonSchema.input()` 算定义哈希与下发给客户端的 responseSchema，用 `validate()` 校验客户端回填。
 */
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

export type ReinsSchema<T> = StandardJSONSchemaV1<T, T> & StandardSchemaV1<T, T>

export interface ReinsSchemaInit<T> {
  jsonSchema: Record<string, unknown>
  /** 返回问题列表；空数组即通过 */
  check(value: unknown): string[]
  /** 通过后的规范化（缺省原样） */
  parse?(value: unknown): T
}

export function reinsSchema<T>(init: ReinsSchemaInit<T>): ReinsSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "reins",
      jsonSchema: { input: () => init.jsonSchema, output: () => init.jsonSchema },
      validate: (value: unknown) => {
        const issues = init.check(value)
        if (issues.length > 0) return { issues: issues.map((message) => ({ message })) }
        return { value: init.parse ? init.parse(value) : (value as T) }
      },
    },
  }
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}
