import postgres from "postgres"
import postgresV4 from "postgres-v4"
import { describe, expect, it } from "vitest"
import { type PostgresJsSql, postgresJsClient } from "./postgres-js.js"

/**
 * 适配器本身的行为。真库上的往返在 pg.test.ts 的 backend 矩阵里（postgres.js 3 / 4 经 pglite-socket）。
 * 这里的实例都指向一个没人监听的端口：postgres.js 惰性连接，构造与拒绝都不该发起连接——真连了就会报错。
 */
const nowhere = { host: "127.0.0.1", port: 1, connect_timeout: 1 }

/** 两个大版本的模块类型互不兼容，各给一个构造函数；返回值按 PostgresJsSql 收，这一步类型检查本身也锁住两版 Sql 都满足结构类型 */
interface Version {
  major: string
  make: (options: Record<string, unknown>) => PostgresJsSql
  camel: unknown
  toCamel: unknown
  fromCamel: unknown
}
const versions: Version[] = [
  {
    major: "3",
    make: (o) => postgres(o as postgres.Options<Record<string, never>>),
    camel: postgres.camel,
    toCamel: postgres.toCamel,
    fromCamel: postgres.fromCamel,
  },
  {
    major: "4",
    make: (o) => postgresV4(o as postgresV4.Options<Record<string, never>>),
    camel: postgresV4.camel,
    toCamel: postgresV4.toCamel,
    fromCamel: postgresV4.fromCamel,
  },
]

for (const v of versions) {
  describe(`postgresJsClient × postgres.js ${v.major}`, () => {
    it("带结果 transform 的实例在构造期拒绝（camel / 只改列名 / 自定义 value / 自定义 row），文案指明哪一项", () => {
      const cases = [
        { transform: v.camel, side: "column" },
        { transform: { column: v.toCamel }, side: "column" },
        { transform: { value: (x: unknown) => x }, side: "value" },
        { transform: { row: (r: unknown) => r }, side: "row" },
      ]
      for (const c of cases) {
        const sql = v.make({ ...nowhere, transform: c.transform })
        expect(() => postgresJsClient(sql)).toThrow(
          expect.objectContaining({
            code: "invalid_argument",
            message: expect.stringContaining(`got transform.${c.side}.from`),
          }),
        )
      }
    })

    it("不带 transform、或只设 column.to / undefined 的实例放行", () => {
      expect(() => postgresJsClient(v.make(nowhere))).not.toThrow()
      expect(() =>
        postgresJsClient(v.make({ ...nowhere, transform: { column: { to: v.fromCamel }, undefined: null } })),
      ).not.toThrow()
    })
  })
}

describe("postgresJsClient：形状转换", () => {
  it("参数复制一份交给 unsafe（原数组不被改动、也不是同一个引用），结果补成 { rows }", async () => {
    const seen: unknown[][] = []
    const params = ["s1", [1, 2]] as const
    const fake: PostgresJsSql = {
      unsafe: (query, parameters = []) => {
        seen.push(parameters)
        parameters.push("mutated")
        return Promise.resolve([{ query }])
      },
      options: {},
    }
    const client = postgresJsClient(fake)
    expect(await client.query("SELECT 1", params)).toEqual({ rows: [{ query: "SELECT 1" }] })
    expect(seen[0]).not.toBe(params)
    expect(params).toEqual(["s1", [1, 2]])
    expect(await client.query("SELECT 2")).toEqual({ rows: [{ query: "SELECT 2" }] })
    expect(seen[1]).toEqual(["mutated"])
  })

  it("没有 options 的实例（事务 tx、reserve 出来的连接）拒绝：它们继承 transform 却不暴露", () => {
    // 运行时形状与 postgres.js 3 / 4 的 tx、reserved 一致：有 unsafe、没有 options
    const tx = { unsafe: () => Promise.resolve([]) } as unknown as PostgresJsSql
    expect(() => postgresJsClient(tx)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        message: expect.stringContaining("got one without options"),
      }),
    )
  })
})

/** 类型层：两个大版本的 TransactionSql 都不满足 PostgresJsSql，传 tx 编译期就报错。只做类型检查，不执行 */
export function _typeLevelRejectsTransactions(
  tx3: postgres.TransactionSql,
  tx4: postgresV4.TransactionSql,
): void {
  // @ts-expect-error 事务没有 options
  postgresJsClient(tx3)
  // @ts-expect-error 事务没有 options
  postgresJsClient(tx4)
}
