import { StoreError } from "@reinsjs/core"
import type { PgClient, PgQueryResult } from "./client.js"

/** postgres.js 的 transform 里本适配器要看的那一半（`from` = 结果从库里出来时的改写） */
interface PostgresJsTransformSide {
  readonly from?: unknown
}

/**
 * postgres.js 实例里本适配器用到的那一小块。结构类型，不依赖 `postgres` 包：
 * 3.x 与 4.x 的顶层 `Sql` 都直接满足（`postgres-js.test.ts` 的类型检查锁住两个大版本）。
 *
 * `options` 必填：顶层实例才有它。`sql.begin()` 的 tx、`sql.reserve()` 的连接没有 `options`，却照样执行实例的 transform——
 * 收它们就看不见 transform，所以类型上不收、运行时也拒。
 */
export interface PostgresJsSql {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<readonly Record<string, unknown>[]>
  readonly options: {
    readonly transform?: {
      readonly column?: PostgresJsTransformSide
      readonly value?: PostgresJsTransformSide
      readonly row?: PostgresJsTransformSide
    }
  }
}

/**
 * 把一个 postgres.js 顶层实例接成 `PgClient`：`pgStores(postgresJsClient(sql))`。可以直接用宿主现有的实例（Drizzle 包过的也行），
 * 不必另开连接池。
 *
 * 原始 SQL 走 `sql.unsafe(text, params)`，它返回的就是行数组，这里补成 `{ rows }`。`unsafe` 从不建命名预备语句，
 * 实例上的 `prepare` 选项对这条路径没有作用。参数与结果的类型差异不在这里处理：本包的 SQL 只按文本过库
 * （事件写 `text[]` 再在 SQL 里转 json，读 `data::text`），驱动的 json 编解码不参与。
 *
 * **拒绝两类实例**，构造期就抛，不等第一次读写坏数据：
 * - 带结果 transform 的（`transform.column.from` / `value.from` / `row.from` 任一设了，如 `postgres.camel`）：本包按原列名读结果，
 *   camel 会把 blob 的 `session_id` 改成 `sessionId`，meta 随之丢字段。`transform.*.to` 只作用于标签模板里的标识符，本包不用，不拦。
 * - 没有 `options` 的（事务 tx、reserve 出来的连接）：它们继承实例的 transform 却不暴露，上一条查不了。
 */
export function postgresJsClient(sql: PostgresJsSql): PgClient {
  if (typeof sql.options !== "object" || sql.options === null) {
    throw new StoreError(
      "invalid_argument",
      "postgres.js instance must be the top-level sql returned by postgres(), got one without options (a transaction or reserved connection?)",
    )
  }
  const transform = sql.options.transform
  for (const side of ["column", "value", "row"] as const) {
    // 未配置时 postgres.js 在这些位置放的是 undefined；按真值判，不依赖它具体放 undefined 还是 null
    if (transform?.[side]?.from) {
      throw new StoreError(
        "invalid_argument",
        `postgres.js instance must not transform results, got transform.${side}.from — reins reads columns by their real names; give reins its own postgres() instance without transform`,
        { transform: side },
      )
    }
  }
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
      // unsafe 是惰性的（await 时才发），参数复制一份：postgres.js 要可变数组，PgClient 给的是只读
      const rows = await sql.unsafe(text, [...params])
      return { rows: rows as Record<string, unknown>[] }
    },
  }
}
