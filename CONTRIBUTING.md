# 贡献约定

## 一条命令

```bash
pnpm check   # typecheck + lint + test，提交前必须全绿
pnpm format  # 用 Biome 统一格式
```

CI（`.github/workflows/ci.yml`）跑的就是 `pnpm check`，本地绿 = CI 绿。

## 提交信息

首行格式 `type: 摘要`，摘要不超过 72 字符；正文写对应的任务号（见 `docs/TASKS.md`）。
`pnpm install` 会自动挂载 `.githooks/commit-msg` 做校验。

| type | 用途 |
| --- | --- |
| `feat` | 新能力 |
| `fix` | 修缺陷 |
| `docs` | 只改文档 |
| `spike` | 核实脚本与结论 |
| `refactor` | 不改行为的重构 |
| `test` | 只改测试 |
| `chore` | 工程杂务、依赖 |
| `build` / `ci` / `perf` | 构建、CI、性能 |

示例：

```
feat: 事件模型与 upcast 表

对应任务：T3

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

## 硬约束

见 `CLAUDE.md`「工程硬约束」与 `docs/技术方案.md` §1。违反即返工。
