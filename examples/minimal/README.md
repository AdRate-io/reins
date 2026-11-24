# examples/minimal —— 五分钟体验

`agent.ts` 就是 PRD §5.1 那段代码：一个模型、两个工具（其中 `deploy` 需要审批）、内存存储，导出一个 Web 标准 handler。
`server.ts` 用 node:http 把它挂到 `/agent`，并送出 `@reinsjs/ui-agui` 自带的最小页面。

```bash
pnpm install && pnpm build
ANTHROPIC_API_KEY=… node examples/minimal/server.ts          # 直连官方
ANTHROPIC_API_KEY=… REINS_GATEWAY_BASE=https://host/api/v1 node examples/minimal/server.ts   # 走网关：给到协议根，其后接 /messages
```

打开 http://127.0.0.1:8787 ：问天气看它调工具；说"上线到 prod"看它暂停等你审批；点右侧"重连补发"看整个界面从时间线重建。

这份示例会被照抄成宿主骨架，所以安全上按生产形态写：

- **只监听本机**：缺省绑 `127.0.0.1`（这台服务花的是你的 API key）；`HOST=0.0.0.0` 才对外，对外之前先把身份换成你的登录态。
- **校验 Host 头**：只听本机挡不住 DNS 重绑定（恶意域名解析到 127.0.0.1 后，在它自己的源下就能拿 cookie、驱动 agent）。没设 `HOST` 时只认 `127.0.0.1` / `localhost` / `[::1]` 加端口，其余回 421；设了 `HOST` 对外就必须设 `ALLOWED_HOSTS`（逗号分隔，写浏览器实际发的 Host：标准端口 80 / 443 不带端口），否则拒绝启动。没设 `HOST` 却用 `PORT=80` 时，浏览器发的 Host 是不带端口的 `localhost`，而缺省名单只认带端口的写法，于是一律 421；此时要么换个非 80 端口，要么显式设 `HOST=127.0.0.1` 并配 `ALLOWED_HOSTS=localhost,127.0.0.1`（`ALLOWED_HOSTS` 只在设了 `HOST` 时生效）。
- **会话归属**：打开页面时发一个 HttpOnly 访客 cookie，`agent.ts` 的 `principal` 认它、`authorizeSession` 只让开会话的人读、续、批；没 cookie 回 401，别人的会话回 404。访客 cookie 只区分浏览器，不是登录——接进项目时换掉 `visitorOf`，归属表进库。
- **签名密钥**：没设 `REINS_SECRET` 就每个进程随机生成一把并告警一次，不用写死的开发值；随机密钥下暂停状态重启即失效，与内存存储同寿命，上持久存储或多实例必须注入同一把真密钥。

用框架时不需要 `server.ts`：`agent.ts` 里的 `POST` 直接放进 Next.js route、TanStack Start server route 或 Hono 的 `app.post("/agent", (c) => POST(c.req.raw))`。

## 回放：只凭日志重现"发生过什么"和"模型每轮看到了什么"

时间线是唯一真源，所以一份事件日志就够回放整段会话 —— 不需要 API key，不联网。

```bash
# 1. 录一段（需要 key）：同一个 agent 不经 HTTP 跑三次 —— 问天气 → 要上线（暂停等审批）→ 批准后续跑，日志写成 JSONL
ANTHROPIC_API_KEY=… node examples/minimal/record.ts

# 2. 回放（不需要 key）：终端打时间线，--html 再生成一个零依赖的静态页面
node examples/minimal/replay.ts examples/minimal/recordings/weather-deploy.jsonl --html examples/minimal/recordings/replay.html
open examples/minimal/recordings/replay.html
```

`recordings/weather-deploy.jsonl` 是 2026-09-08 经网关用 claude-opus-5 录下的真实会话（17 条事件，4 轮模型调用、2 次工具、1 次审批），拿来直接回放即可。

回放做了三件事，每件都是库里已有的能力，脚本只是串起来：

1. **读时升级**：每行先过 `EventSchemaRegistry.read`，未登记的类型或未来版本直接拒绝（fail-closed）。
2. **自洽校验**：整批 append 进一个全新的内存 EventLog，seq 不连续、混了别的会话会被存储层拒绝。
3. **逐轮重算**：`replayTurns` 对每一轮模型调用重算投影（纯函数），得到"这一轮模型看到了哪些 seq、约多少 token"；再经降级层 `toRequest` 得到当时的有损落点（exact / lossy / dropped）。

页面上：每轮一张卡片，点卡片高亮它看到的事件、压暗它看不到的（budget_usage、审批簿记等运维事件默认不给模型看）；点事件展开完整载荷；"重放"按真实时间比例逐条出现。
