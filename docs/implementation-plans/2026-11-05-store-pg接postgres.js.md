# store-pg 接 postgres.js（AdRate 建议 5）

> 状态：✅ 已完成（2026-11-05）

## 背景与根因

AdRate 第二批建议 5（`docs/archive/2026-11-05-AdRate给reins的优化建议.md` 末节）：AdRate 用 Drizzle + postgres.js，正式接入方案 M1 开头要把现有 postgres.js 连接交给 store-pg，要求官方适配并把存储测试对 postgres.js 跑一遍。

`client.ts` 注释写着"postgres.js 之类用标签模板的库包一层即可"，这句从没验证过。实测（本机 PG 15 + PGlite socket，postgres.js 3.4.9 / 4.0.0）发现三件事：

1. **事件被二次编码**：append / fork 把 `JSON.stringify(e)` 以 `$6::json[]` 传入。postgres.js 先向服务端要参数类型，看到元素是 json，就对已经是文本的字符串再 `JSON.stringify` 一次，库里每行的 `json_typeof(data)` 都是 `string`。读回之所以一致，是 `eventOf` 的"字符串再解一层"兜底把问题盖住了。续跑不受影响，但库里的数据形状是错的：SQL 查 `data->>'type'` 只得到 null，以后转 jsonb 或做分析都会出错。
2. **宿主 transform 会改数据**：宿主连接开了 `transform: postgres.camel` 时，blob 的 `session_id` / `created_at` 列名被改成驼峰，meta 里 `sessionId` 丢失、`createdAt` 为 null。第 1 点修好以后，json 列读回时**事件内部的键也会被改**（`tool_name` 变成 `toolName`），这会让续跑签名失效。
3. **postgres.js 3 加 `fetch_types: false`** 时数组参数被序列化成 `1,2`，数据库回 22P02，一条也不写。v4 已修；PGlite socket 与真库表现一致。

其余都正常：`unsafe` 返回行数组、23505 在 `err.code`、bytea 往返、租约并发、`prepare: false`、Drizzle `drizzle(sql)` 包过的同一实例（它只改日期类解析器）。

## 方案对比

| | 做法 | 判断 |
| --- | --- | --- |
| A（选） | **SQL 只按文本过库**：写 `$6::text[]` 再在 SQL 里 `::json`，读 `data::text` 后由本包 `JSON.parse`；适配器只做形状转换和 transform 拒绝 | 驱动自己的 json 编解码不再参与，对 pg / PGlite / postgres.js 一视同仁；不改表、不改接口 |
| B | 不动 SQL，适配器按参数类型做转换 | 否：修的是一个驱动的症状，下一个驱动再踩一次；读侧仍依赖驱动的 json 解析器（camel 改键照样发生） |
| C | 整批改用一个 JSON 参数加 `json_to_recordset` | 否：顺带绕开数组序列化，但改动热路径更大，嵌套 json 的逐字性还要另证；v3 `fetch_types:false` 是大声失败，不值得为它换写法 |

## 具体设计

### store-pg 内部

- `event-log.ts` 的 append / fork：`unnest(..., $6::text[])`，`SELECT … u.data::json`。
- read / tail：`SELECT data::text AS data`。`eventOf` 收文本、`JSON.parse`；解出来还是字符串的就是第 1 点留下的旧行，再解一层（保留这个兼容，只读不改写）。
- 表结构、`PgClient`、事务语义都不变。

### 新导出 `postgresJsClient(sql): PgClient`（新文件 `postgres-js.ts`）

- 结构类型 `PostgresJsSql`：只用 `unsafe(text, params)` 和 `options.transform`，不依赖 postgres 包，store-pg 继续零运行时依赖。
- `query` 返回 `{ rows: await sql.unsafe(text, [...params]) }`。
- 构造期检查 `options.transform` 的 `column.from` / `value.from` / `row.from`，任何一个设了就抛 `StoreError("invalid_argument")`，文案让宿主另开一个不带 transform 的实例。只检查 `from`：`to` 只作用于标签模板里的标识符，本包不用。
- 不拦 `fetch_types: false`：v4 下正常，v3 下是数据库当场拒绝、一条不写，README 说明即可。

### 测试

- `pg.test.ts` 的 backend 矩阵：PGlite 直连，再加 postgres.js 3 / 4 经 `@electric-sql/pglite-socket`（0.2.11，对应 PGlite 0.5.8）各一列，常驻 CI。设了 `REINS_PG_URL` 时 pg 与 postgres.js 3 / 4 都对真库再跑一遍。
- 每个 backend 新增：
  - **库内形状**：`json_typeof(data) = 'object'`，`data::text` 逐字等于 `JSON.stringify(e)`；事件含乱序键、中文与 emoji、引号反斜杠换行、2^53−1、负小数、嵌套数组。append 与 fork 都测。只比"读回一致"会被兜底盖住，这次就是这样漏掉的。
  - 旧行兼容：手工写一行 `to_json(<事件文本>)` 字符串标量，读回得到原事件。
- `postgres-js.test.ts`：v3 / v4 的 `postgres.camel`、自定义 `value` / `row` transform 都在构造期被拒，且不发任何语句；参数按副本传入。Drizzle 包过的实例只在探针里验过（它只改日期类解析器，本包没有日期列），不为一条用例引入 drizzle-orm。
- devDependencies：`postgres` 3.4.9、`postgres-v4`（`npm:postgres@4.0.0`）、`@electric-sql/pglite-socket` 0.2.11，全部 pin 精确版本。

### 文档

- store-pg README：postgres.js 接法、transform 限制、v3 加 `fetch_types:false` 的说明；"`data` is json"一节补"按文本过库"。
- `client.ts` 注释改掉"包一层即可"；包描述加 postgres.js。
- 模块盘点 store.md、全景图（核心设计决策、导出索引）、AGENTS.md 存储节一条、踩坑记录 47。
- changeset：store-pg minor（新导出 + 写读路径变化）。

## 验证矩阵

| 项 | 方式 | 花费 |
| --- | --- | --- |
| 一致性套件 + 特有行为 × PGlite / postgres.js 3 / postgres.js 4 | `pnpm check` | 0 |
| 同上 × 真库 PG 15（pg / postgres.js 3 / 4） | 本机 `REINS_PG_URL` 跑一遍 | 0 |
| 构建产物 | `pnpm check:dist` | 0 |

不涉及真模型。

## 风险

- 读侧改成 `data::text` 后，所有驱动拿到的都是字符串、由本包解析。pg / PGlite 原本也用 `JSON.parse`，行为不变；大整数精度与以前相同（JSON.parse 的上限）。
- 已用裸包方式写进字符串标量的宿主：读照常（兼容分支），新写入的是对象，同一会话里两种形状并存，SQL 侧分析要自己处理旧行。目前没有已知宿主这样接（AdRate 尚未接入）。
