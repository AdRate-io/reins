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

## 发布（维护者）

1. `pnpm changeset version` → 检查各包版本与 `packages/core/src/index.ts` 的 `REINS_VERSION` 一致，`pnpm check && pnpm build && pnpm check:dist` 全绿，提交。
2. 先 `npm whoami` 确认令牌还有效且是 `reinsjs` 组织的 owner——npm 令牌有有效期，过期后 publish 报的是 **404 Not Found（PUT）** 而不是 401（scoped 包对鉴权失败刻意伪装成 404，2026-09-22 发 0.3.0 踩过），`npm login` 重登即可。然后在仓库根目录发布，**只用 pnpm**：`pnpm -r publish --access public --no-git-checks`。pnpm 会把 `workspace:*` 依赖重写成当前版本号并读根 `.npmrc`（官方源）；`npm publish` 会把 `workspace:*` 原样传上去，发出的包装不上（2026-09-15 的 0.2.0 就是这样作废的）。每个包要一次 2FA 验证码。
3. 发后**从官方源真实安装冒烟**：新建空目录，`pnpm add @reinsjs/agent@<版本> @reinsjs/lowering-fetch@<版本> @reinsjs/brain@<版本>`，import 主入口并起一次 handler。`npm view` 只能证明传上去了。
4. 冒烟通过再推远程、打 `v<版本>` tag、发 GitHub Release。
