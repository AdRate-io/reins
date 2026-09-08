# examples/minimal —— 五分钟体验

`agent.ts` 就是 PRD §5.1 那段代码：一个模型、两个工具（其中 `deploy` 需要审批）、内存存储，导出一个 Web 标准 handler。
`server.ts` 用 node:http 把它挂到 `/agent`，并送出 `@reins/ui-agui` 自带的最小页面。

```bash
pnpm install && pnpm build
ANTHROPIC_API_KEY=… node examples/minimal/server.ts          # 直连官方
ANTHROPIC_API_KEY=… REINS_GATEWAY_BASE=https://host/api node examples/minimal/server.ts   # 走网关
```

打开 http://localhost:8787 ：问天气看它调工具；说"上线到 prod"看它暂停等你审批；点右侧"重连补发"看整个界面从时间线重建。

用框架时不需要 `server.ts`：`agent.ts` 里的 `POST` 直接放进 Next.js route、TanStack Start server route 或 Hono 的 `app.post("/agent", (c) => POST(c.req.raw))`。
