# reins 改进建议：compact 与 perception（来自 OnSet 第三轮试拍）

背景：OnSet 是 8 个角色的长期会话协作系统（每个"项目 × 角色"一个 reins 会话，被消息唤醒一次就跑一个 run）。主脑是 DeepSeek v4.1 flash，窗口 400K，装配 `memory / skills / compact / spill / perception / budget`。

第三轮实测（2026-10-30，76 个 run）：
- 一共 3 次 `core.compaction`，`decidedBy` 都是 `model`；阈值兜底 0 次。导演、制片都在 perception 报 50%–70% 后，选了自然停顿（阶段刚结束、没有待办）自己整理，摘要质量好。
- 摄影的会话涨到 337K（84%），perception 先后报了 70%–85% 和 ≥85%，它一次都没整理，思考里写的是 "Context very tight (85% risk). Keep the final answer short."，也就是靠少做事来应对。

## 建议 1：`COMPACT_RULES` 不要写死 perception 缺省标题

现状：`COMPACT_RULES` 写的是 *Runtime notes titled "Runtime context status" tell you how full the window is.*，这是 `renderPerception` 缺省文案的标题。只要宿主自定义了 perception 的 `render`（OnSet 用的是中文"运行状态"），或者根本没装 perception，规则就和实际情况对不上。

建议：规则里不点名标题，比如改成 "Runtime status notes, if present, tell you…"；或者由 perception 导出标题常量，compact 规则引用它。两个模块之间不该靠一段字面量耦合。

## 建议 2：缺省规则补上"长期会话里的自然停顿"

现状：规则只说 *Do it at a natural pause, not while acting on something.* 如果一个会话横跨多个 run（被唤醒 → 干一段 → 停下等别人），模型总觉得事情还没做完，就一直不整理；上下文紧了，它的反应是把回答写短，而不是整理。

建议（通用，不是 OnSet 独有）：
- 规则补一句：一次 run 快结束、准备停下来等用户或别人的时候，就是自然停顿。
- 规则补一句：上下文紧了，应该先整理再继续，不要靠少做事、少查证来省空间。
- perception 的缺省 render 在使用率到第 2 档（≥70%）、并且装了 compact 时，加一句提示："在这次 run 收尾前用 compact 整理"（perception 可以检查 ctx 里是否有 compact 工具）。

用 examples/eval 回归一下长会话场景：主动整理的比例是否上升，同时不能引入"推导做到一半就整理"的副作用。

OnSet 现在的做法（只作参考，属于 OnSet 自己的本地化，不算兼容层）：自己写了中文版 `COMPACT_RULES_ZH`，并在自定义的 `renderPerceptionZh` 里，到 ≥70% 那档加了这句提示。等 reins 的缺省改好，OnSet 的中文版会跟着对齐措辞。

## 建议 3（顺带一提）：perception 缺省的"会话累计 token"档位

现状：`sessionTokens` 按"输入 + 缓存读写 + 输出"累加，档位是 1 万 / 5 万 / 20 万 / 100 万。缓存读也算在里面，一个新会话跑几步就会连跨几档，每跨一档就多一条提醒；而累计花了多少 token，对模型做决定没有帮助。OnSet 在自定义 render 里不报这一项，也不报"未折叠轮数"。

建议：评估缺省 render 是否去掉这一项，或者改成不含缓存读的口径。

## 建议 4（0.4 升级后补充）：到阈值先强制模型 compact，机械裁剪退为最后一道防线

背景：0.4 修好了阈值兜底的口径，"到 85%"和"框架真的折"现在是一回事了，这点对 OnSet 很关键。读了 0.4 的 `budgetTruncate`（`core/src/projection/truncate.ts`）之后，我们觉得兜底本身的形态还值得改一下。

现状：
- 上下文一过 `contextLimit - reserveTokens`（按缺省 15% 的 reserve，就是 85%），projection 就从最早的记录开始按整轮删，**删到刚好回到目标线以下就停**。被删的部分换成一条机械摘要 `[Context truncated by budget]`，里面只有类型计数、之前的摘要原文、用户消息前 120 字和工具结果清单。
- 长期会话最需要的"目标与约束、做过的决定和原因、下一步"，在这条摘要里都丢了。工具结果虽然能用 recall 取回，但模型并不知道该取哪条。

问题（读代码推断的，OnSet 第四轮试拍会用数据验证）：
1. **贴线磨刀**：每次只删到线下一点点，下一轮新的工具结果一进来又过线，于是几乎每轮都要裁一小截。
2. **缓存每轮失效**：每次裁剪都会改写上下文前面那部分，后面的 prompt cache 跟着全部作废。每一轮都要按全价重读八成多的窗口，长会话的成本会明显上涨。
3. **摘要越套越长**：新的裁剪摘要会原样带上旧的摘要（"Earlier summaries (preserved verbatim)"）。裁一次就套一层，摘要本身也在占预算。
4. perception 读到的是裁剪后的用量，所以模型只会看到 70%–85%，看不到"已经被裁过一刀"这件事。

建议：
- **到阈值，先强制模型 compact**：本轮工具结果落定后，下一次调模型时把工具限定成只能调 compact（相当于 tool_choice 强制）。用宿主配置的 compact rules 写摘要、填 keep，`decidedBy` 可以单独记成一种，比如 `forced`，方便统计。这和 Claude Code 自动压缩的做法一致：到线以后由模型写摘要，再接着干活。
- **机械裁剪退为最后一道防线**：只在下面两种情况触发：
  - 强制 compact 失败，比如模型没调、摘要不合法，或者调用本身出错；
  - 用量过了更高的硬线，比如 95%，或者 `contextLimit - 输出预留`。
- **机械裁剪也要留余量**：真要裁的时候，一次裁到一个更低的目标（比如 60%），不要刚好贴着线下。这样裁一次能管很多轮，缓存也只断一次。
- 成本账：强制 compact 多一次调用，但这次的输入大部分命中缓存，输出只有一两千 token；相比之下，贴线磨刀是每轮按全价重读整个窗口。长会话里强制 compact 更便宜。

需要框架补的能力：现在 loop 没有"规定下一次调用只能用某个工具"的通道。Socket 的 `beforeModel` 只能改 events / tools / systemPrompt，用 `tools` 收窄到只剩 compact 可以近似实现，但收窄工具表也会让缓存失效，而且不等于真正的 tool_choice 强制。建议在 lowering 这一层加 tool_choice，每家都有对应能力；然后由 compact 模块（或 projection）在到阈值时发起强制。

验证：用 examples/eval 跑长会话场景，对比现状和强制 compact 两种做法下三样东西：每轮是否裁剪、缓存命中率、摘要质量（之后问到被折叠的决定时，模型能不能答对）。OnSet 现有的 ≥70% "收尾前自己整理"提示照留，角色在阈值前主动整理仍然是首选，强制 compact 只管它没整理的情况。

## 建议 5（0.5 升级后补充）：压缩后给宿主一个"当场重附上下文"的钩子

背景：OnSet 每次 run 的输入里附宿主侧的常驻上下文：角色记忆快照（团队经验库索引 + README）、正在处理的条目快照。为了不重复，宿主会记"这个上下文里已经附过什么"，只在观测到 `core.compaction` 之后把记录清掉，下一次 run 重新附整份。第四轮返工里剪辑的真实会话（2026-10-31）：03:08 角色自己 compact（`covers [2, 481]`，摘要约 1.2 万字），03:09 下一次 run 重附了记忆和条目快照。

暴露出两个问题：
1. **压缩后到本次 run 结束，有一段空档**：记忆快照附在更早的输入里，已经被折掉，本次 run 剩下的轮次里角色只有摘要。宿主要等下一次 run 组装输入时才能补上。
2. **宿主不知道哪些内容还在，只好全清全附**：`planCompaction` 会原样保留最近一条用户消息、钉住的笔记和 keepRecentTurns，但宿主只观测到"发生了压缩"，看不到"哪些事件被折了、哪些留下了"。上例中，03:01 输入里的条目快照随最近一条用户消息留了下来，03:09 又附了一整份，重复。

这件事不是 OnSet 独有的。凡是在输入里附常驻上下文的宿主都会遇到（Claude Code 压缩后会重新读回项目说明、最近读过的文件和待办）。宿主自己用 `beforeModel` 去扫"最后一次压缩之后有没有重附过"也做得到，但每个宿主都得重新写一遍判定，而且拿不到"哪些保留了"。

建议：
- **压缩后钩子**：任何一种压缩（`model` / `forced` / `threshold`）落盘之后、下一次调模型之前，调一次宿主回调（比如 `compact({ reinject })`，或 Socket 新增 `afterCompaction(ctx, compaction, { folded, survivors })`）。回调返回的内容作为一条笔记追加在末尾，只追加不改前缀，缓存不受影响。这条笔记是信息，不是指令，按普通笔记送达即可。
- **把"折了什么、留了什么"交给宿主**：回调参数里带上被折事件和保留事件，至少给 id 和 seq，宿主可以据此只补被折掉的那部分。
- 可选：重附的笔记打上标记（比如 `meta.reinject`），下一次压缩时与钉住的笔记一样处理，或者让宿主决定是否保留，免得每次压缩后越补越多。

有了这个钩子，OnSet 侧的改法：压缩后当场补记忆快照，以及被折掉的条目快照；再把"已附"记录更新为当场补的内容，下一次 run 就不再整份重附。剪辑这次压缩后照常工作，没有因此出错，所以优先级不高。

> **处置（reins，2026-10-31）**：不加压缩后钩子，改为 pins 的常驻快照 `{ name, snapshot }`——记忆索引、条目快照作快照 pin 压缩不掉，段起点（会话首轮、每次整理后）按当前数据刷新、没变不追加，宿主不再需要"已附"记账。方案 `docs/implementation-plans/2026-10-31-常驻快照按段刷新.md`，配方见 brain README "Resident context that survives compaction"。

## 建议 6（第三、四轮工具报错盘查补充，2026-10-31）：view 还没有文件的记忆目录，返回"空"而不是报错

背景：OnSet 把记忆挂成三个前缀根（`/memories/personal`、`/memories/project`、`/memories/team`），由宿主的 `MemoryStore` 路由到不同存储。新项目、新角色开工时，个人层和项目层下面还没有文件。

现状：`packages/brain/src/memory/commands.ts` 的 `isDirectory` 只认 `MEMORY_ROOT`，或者 `listUnder(path)` 不为空的路径。所以角色开工先 `view /memories/project` 看看有什么，拿到的是 `The path /memories/project does not exist. Please provide a valid path.`，并且算 `isError`。第三、四轮一共 7 次（制片、策划、编剧、导演、剪辑都踩过），模型每次都多花一轮去理解"不存在"是什么意思。OnSet 这边造不出一个空目录：`MemoryStore` 只存文件。

建议：
- 宿主配置里声明的挂载前缀（或者 `MemoryStore` 能报出自己的根），以及它们的祖先目录，`view` 时一律当目录处理；下面没有文件就返回"（空目录）"之类的普通结果，不算错误。
- 范围只限 `view`。`create` 往前缀根本身写、`delete` / `rename` 前缀根，仍由宿主或现有规则拦住，这个口径不变。

优先级低：错误文案本身说得清楚，模型下一轮就能纠正，代价只是每个新会话多一轮。

> **处置（reins，2026-10-31）**：照建议做，brain 0.7.1（0.7.0 误发旧产物，见踩坑 43）。`memory({ directories: ["/memories/personal", "/memories/project", "/memories/team"] })` 声明常设目录（祖先自动算进来）：`view` 空层返回空列表、不算错误，`view /memories` 也列出这几层（0B）。写操作口径不变：不能把常设目录当文件写、不能改名到它；删 / 改名一个空的常设目录回"is empty; there is nothing to delete / rename"。不声明的宿主行为不变。

## 建议 7（会话盘点补充，2026-11-02）：run 的 input 允许多条草稿，宿主背景能以 system_note 和本次任务一起进来

背景：OnSet 每次 run 的输入由宿主组装，一部分是"要你做什么"（同事 / Boss 的新消息、条目快照），一部分是框架给的背景（待办清单、相关条目被别人改了什么、团队经验库有更新）。现在全部拼成一条 `core.user_message`。盘点（「EP1 第3场对比测试」80 次 run）里背景约占 15%，它们以 user 身份出现，模型分不清哪些是同事在要求、哪些是系统在告知。

现状：`LoopConfig.input` 是 `string | ContentPart[] | EventDraft`，一次只能是一条。宿主要么全给 user_message，要么给一条 system_note，没法两样都给。

可行的绕法与问题：宿主自建 Socket，在本次 run 第一次 `beforeModel` 里 `ctx.emit` 一条 system_note（compact 的整理请求就是这么发的）。但笔记会落在 user 消息之后，而背景应该在任务之前；宿主还要自己记"本次 run 发过没有"。凡是有"背景 + 任务"结构的宿主都得重写一遍。

建议：
- `input` 接受草稿数组（`EventDraft[]`，或 `string | ContentPart[]` 与草稿混排），按顺序写进时间线，校验口径同现在：任一不合规就整体在写日志前抛 RangeError。
- 压缩时"最近一条用户消息原样幸存"的规则不变，只认 user_message，同批的 system_note 照普通笔记折叠。OnSet 里背景过时就没用了，折掉正合适；需要常驻的已经走 pins。
- 中途 system 的降级照现有规则：上游不支持就包 `<system_note>` 走 user，宿主不用管。

顺带一个观察，供 reins 判断要不要验：OnSet 之前记过"中转站上中途 system 消息模型只看到、不照做"，后来整理请求改成 user 身份 + 命令语气就有效了。但那次身份和语气是一起换的，分不开是哪个起了作用。确定的是中途 system 模型看得到：演示里 50%–70% 的运行状态以 system 送达，角色的思考里提到了它。若要区分，可以用 examples/eval 做个小对照：同一句命令分别以中途 system 和 user 发，看照做率。

优先级中：不影响正确性。OnSet 的分层（背景走 system_note、任务留 user）等这项落地再做，期间不写兼容层。

> **处置（reins，2026-11-02）**：照建议做，方案 `docs/implementation-plans/2026-11-02-输入多条草稿.md`；core / server / agent 下一个 minor。`input` 收草稿数组，按序一次写入，推荐 `[{ type: "core.system_note", actor: "host", payload: { kind: "host", text: 背景 } }, user_message]`，每批一条 user_message。两处与原提议不同：① 不收字符串与草稿混排（user_message 自己写成草稿）；② HTTP 入口不收草稿数组（进程内专用，网络上能写 system 信任说明就是漏洞）。降级层不改：Chat / Responses 与 DeepSeek 背景在任务前；Anthropic 官方能开中途 system 的型号，厂商不许 system 紧跟 assistant，背景排到任务之后，角色区分不变。顺带的观察不用另做对照：踩坑 42 / OPT-261031-1 已在同一中转站拆开身份与语气（同措辞中途 system 0/54、带标签 user 3/3），结论是要模型去做的指令标 `directive`，背景这类陈述用普通 system_note 即可。

## 建议 8（第五轮试拍补充，2026-11-02）：工具入参被二次编码成 JSON 字符串时，降级层再解一层

背景：OnSet「房间场景动态演练」里，摄影师调用 `generate_submit`，第一次就被拒：`expected object, received string`。模型把整个入参写成了一段 JSON 文本：`arguments` 解析一次后得到的不是对象，而是字符串 `{"candidate_for": …}`，也就是被编码了两次。全库盘点 111 次工具硬报错，6 次是整个入参被二次编码（`generate_submit` 3、`board_update` 2、`batch` 1），都出在入参长、文本里引号多的调用上。这次的连带代价：模型以为工具坏了，用占位提示词真提交了一条视频去试，花了 70 积分。

现状：`packages/lowering-fetch/src/chat/from-stream.ts` 的 `parseArguments` 只解一次，解出来是字符串就原样交给宿主，宿主的 `validate` 只能报"要对象却收到字符串"。Responses 路径（`responses/from-stream.ts`）应该是同样的情况，没逐行核。

OnSet 这边已做的（宿主能管的部分）：字段级二次编码（对象里某个数组字段写成了 JSON 文本）在 `validate` 里先解析再校验；报错里去掉了类型不符时 zod 多报的长度噪音，并提示"多半是写成了 JSON 文本"。整个入参是字符串这一种，按约定不在 OnSet 写兼容，交给降级层。

建议：
- `parseArguments` 解析结果是字符串、并且这个字符串本身能解析成对象时，用解析出来的对象；只多解这一层，结果不是对象（数字、数组、普通文本）就照现在原样返回。
- 这样多解一层不会误伤：工具入参的顶层按约定一定是对象，字符串顶层本来就不合法。
- 可以在 `tool_call` 事件上带个标记（比如 `meta.argumentsUnwrapped: true`），宿主统计时能看出是哪家模型、哪种调用容易这样写；不带也行。

优先级中：不影响正确性（模型下一轮会改），但每次都多一轮往返，还会诱发上面那种试探。

> **处置（reins，2026-11-02）**：照做，并且判为 reins 的 bug 而不只是优化：fetch 版写侧（Chat / Responses 的 `argumentsOf`）把字符串入参当原始 JSON 文本送回，历史里模型看到自己写对了对象，工具却报"收到字符串"，记录与执行说法不一，正是诱发"以为工具坏了去试"的根子。做法：core 新增 `unwrapToolArguments`，fetch 三条线（含 Anthropic）与 pi 版读侧都调它（pi-ai 的 `parseStreamingJson` 也只解一层，同一个毛病）；规则同建议，只多解一层、只换成普通对象。与原提议一处不同：标记不是可选——库替模型多解了一层要留在时间线上，`tool_call.payload.meta.argumentsUnwrapped: true`。TanStack 适配器刻意不做（它的历史按 `JSON.stringify(args)` 送回，模型看到的就是自己的二次编码，与执行一致，只多一轮往返；OPT-261102-2）。实施审查补正：首版只覆盖了解成对象的情况，没解成对象的字符串（`"[1,2]"`、`"hello"`、内层欠转义换行）仍是"历史里被替它解了一层、工具拿到字符串"；已改为不变式"`args` 是字符串 ⟺ 线上原文"，并在多解那层容忍裸换行。core minor、lowering-fetch / lowering-pi patch，随下次发版；用例锁住"二次编码读侧解开后，写侧送回的历史与工具拿到的是同一份"。字段级二次编码（对象里某个字段写成 JSON 文本）仍归宿主 `validate`：库不知道哪个字段本该是字符串。

## 建议 9（效率盘查补充，2026-11-02）：同一轮里前一个调用失败时，可选拦下后面的调用

背景：OnSet 第五轮试拍盘查下来，每轮模型请求有约 14 秒固定开销，415 轮里 303 轮只调了一个工具，于是协作规则改为"互不依赖的动作放在同一次回复里调"，比如先 `board_update` 把条目置为待确认，再 `chat_send` 说"已交，请看"。问题在于：置待确认失败了（rev 过期、必填字段没填），后面的"已交"照样发出去，并且会唤醒对方，对方来了看到的还是旧状态。

现状：`packages/core/src/loop/run-loop.ts` 的 `executeToolCalls` 按模型给出的顺序逐个执行，某个调用失败（被拦截、未知工具、入参不合法、执行抛错）只是写一条 isError 结果然后 `continue`，后面的照常执行。这对互不相干的并列调用是对的，对有先后关系的就不对，而模型在一次回复里排出的顺序往往就是先后关系。

OnSet 这边已做的（宿主能管的部分）：协作规则写明"先改状态、后发消息；改成功了才该说的话分两次回复"。这条规则把能省的轮次又让回去一部分，而且靠模型自觉，九成照做，剩下一成是"状态没改成、通知已发出"。

建议：
- `LoopConfig`（或按工具）加一个可选项，比如 `toolCallFailure: "continue" | "skipRest"`，缺省 `continue`，行为与现在一致。
- 设为 `skipRest` 时，同一轮里某个调用失败后，排在它后面的调用不再执行，各写一条 isError 结果，文案如"同一轮前面的调用失败，这条没有执行；处理完再重新调用"，toolCallId 一一对应，历史仍然完整。
- 被跳过的调用不走 `beforeTool` / `afterTool`，也不计入 toolCalls 预算。

优先级中：不影响正确性（消息发错了下一轮能纠正），但它决定宿主敢不敢放心让模型一次回复里做多件事，而这正是省轮次的主要办法。reins 支持后，OnSet 会删掉"分两次回复"那条规则。

> **处置（reins，2026-11-02）**：照做，形状不同。根因与建议 10 的坑 1～3 是同一个：Socket 看不到"本批"。core `TurnContext` 加 `batch`（本批调用 / 已落结果 / 挂起的 / 是否补跑，随落随更），brain 新增 opt-in Socket `haltOnFailure({ counts?, applies? })`：同批前面有失败、**或还挂着（等审批 / 客户端回填 / 子代理）**就 block 后面的，isError 结果点名最初那个，不执行、不计 `ctx.budget.toolCalls`；推荐注册在最前。没有照提议加 `LoopConfig.toolCallFailure`：runLoop 要保持无行为分支、可整个复制。TanStack 适配器整批先判，该路径只拦得住补跑时上次已落的失败（刻意不对称）。实施方案 `docs/implementation-plans/2026-11-02-本轮可见与同轮收口.md`。OnSet 可删"分两次回复"规则、改装 `haltOnFailure()`。

## 建议 10（效率盘查补充，2026-11-02）：通用的"调了某个工具，本轮结束即停"

背景：OnSet 现在有两处同一模式。一处是分支的 `fork_done`：交了总结，本轮结束就停。另一处是这次新加的 `end_run`：主会话把最后一批动作和 `end_run({ note })` 放在同一次回复里，本轮结束即停，省掉"做完再请求一轮写收尾文字"那一轮（第五轮 47 次 run 里 45 次有这一轮，合计 14 分钟模型时间）。

现状：两处都是宿主自己写"工具 + onTurnEnd Socket"。`end_run` 做的时候，独立审查查出几处不读 reins 源码就会踩的坑：
1. `onTurnEnd` 拿到的 `ctx.events` / `timeline` 是本轮开始前的快照，看不到本轮的调用和结果，判断不了"本轮有没有失败"。
2. `afterTool` 也不全：被拦截、未知工具、入参不合法的结果直接写入，不经过它。
3. 起 run 时补跑遗留调用后也会走一次 `endTurn`，按"本轮出现过某工具"判断，会让上次遗留的调用把新 run 在处理新输入前就停掉。
4. `endTurn` 里第一个给出意见的 Socket 说了算，compact 请求 / budget 也会在这时返回暂停，收尾 Socket 必须排在它们前面，否则这一轮以暂停收场。

OnSet 最后的做法：状态挂在宿主自己的 run 对象上，在包住 runLoop 的观测点按事件流维护"本轮"（新一轮模型输出开始时清空、见 isError 置位），Socket 只读这个状态，并且排在最前。能用，但每个想要这个模式的宿主都得重新发现这四点。

建议（两种做法任选，或都做）：
- **小改动**：`TurnContext` 带上本轮的调用与结果（比如 `turn: { calls, results }`，补跑遗留调用的那次 `endTurn` 里标明 `resumed: true`），宿主写 Socket 时不用再自己维护事件流。
- **大一点**：`Tool` 定义上加一个 `endsTurn: true`（或循环配置里的工具名单）：本轮这个工具执行成功、且同轮没有失败结果时，循环直接以 `done` 结束，优先于所有 Socket 的 onTurnEnd；遗留补跑里的不算。`fork_done` 和 `end_run` 都能直接用它，OnSet 只保留"把 note 当最后发言"这一层。

优先级低：OnSet 已经有可用实现（`src/server/services/agent-runtime/end-run.ts`，调度器 `trackTurn`），这条是为了让后来的宿主少踩坑，并删掉 OnSet 的两份重复。

> **处置（reins，2026-11-02）**：照做"小改动"那一版并多走一步。core `TurnContext.batch` 消掉坑 1～3（本批调用与结果随落随更，补跑批标 `resumed`）；brain 新增 opt-in Socket `stopAfter({ tools })`：本批名单工具成功、同批无失败无挂起才 `"stop"`。没做 `Tool.endsTurn`：它要压过所有 onTurnEnd，打破"第一个给意见的定"。两处与原提议不同：① 补跑批不是一律不算——`[action 需审批, end_run]` 批准续跑、批后没有新用户消息时照样收尾（坑 3 的真判据是"遗留收尾别吞掉新输入"），与 handoff 从日志重建意图同理；② 坑 4 更正：compact 的到线请求在 beforeModel 发，不在 onTurnEnd，真正要排序的是 handoff → stopAfter → compact / budget——排在 handoff 前会吞掉已回执的交接。TanStack 路径补跑批没有 onTurnEnd，"审批后收尾"在那里不成立（刻意不对称）。OnSet 的 `end_run` / `fork_done` 改用 `stopAfter()` 按推荐顺序注册后，可删 `trackTurn`。

## 建议 11（经营类漫剧试拍补充，2026-11-05）：最紧维度是上下文时，perception 不再报预算余量

背景：OnSet 的 `perception({ limits })` 只给了 `contextTokens`（`budget({ limits })` 同一份）。`remainingOf` 在唯一维度里取最紧，结果永远是 `contextTokens`，余量 = 1 − 上下文已用。于是每次提醒都是同一个数的两种说法：

```
- Context window used: <50% (the harness auto-folds the oldest turns at 85%)
- Run budget remaining: ≥50% (tightest: contextTokens)
```

模型读到的是重复信息；Boss 在轨迹里看到 "最紧的是上下文" 也不知道想传达什么。只设上下文上限是最常见的配置，所有这样配的宿主都会遇到。

现状：`packages/brain/src/perception/reading.ts` 的 `readPerception` 把 `contextTokens` 也纳入 `remainingOf` 的比较；`render.ts` 只要有 `budgetRemaining` 就出一行。

建议（二选一）：
- `remainingOf` 不比 `contextTokens`：上下文已有 `contextUsage` 一行专门报，余量只在 token 总量 / 轮数 / 工具调用 / 时长这些维度里取最紧；都没设时 `budgetRemaining` 为空、不出这一行。
- 或保留读数，`renderPerception` 在 `tightest === "contextTokens"` 时不出这一行。

前一种更干净：读数层就没有重复，宿主自写的 `render`（OnSet 用中文版）不用各自再判一次。

优先级低：不影响行为，只是每次提醒多一行重复。OnSet 先在中文渲染里跳过（OPT-261105-1），reins 修了就删。

> **处置（reins，2026-11-05）**：照做，但不是"一律不比 `contextTokens`"。`limits.contextTokens` 与窗口 `contextLimit` 不是同一个数：宿主可能在 1M 窗口上把单次上下文封到 200k，这条上限分母不同、会真的暂停，删掉就丢了真信息。判据：上限 ≥ 窗口时单次请求越不过它，余量只是 1 − 使用率的另一种说法，不参与最紧维比较；小于窗口照报。没以兜底触发点为界（审查指出）：兜底按请求前估算判，投影后才加的快照 / 说明、估少的新内容、首轮无校准开销都能让真实上下文越过触发点，budget 按真实用量暂停，触发点与窗口之间的上限碰得到。改在读数层（`reading.ts` `remainingOf`），宿主自写 render 不用再判。OnSet 只设上下文上限且等于窗口，升级 brain 后余量行消失，可删 OnSet 侧 OPT-261105-1 的中文渲染跳过。

## 建议 12（接入 Gemini 主脑补充，2026-11-05）：内容片段加视频 / 音频，模型声明能不能收

背景：OnSet 想让角色主脑接公司中转站的 `gemini-3.8-flash-high`，让角色直接看片子，而不是把视频交给看片助手（另起一次 Gemini 调用）、只拿回文字结论。导演看节奏、剪辑看切点，这些判断转述一道就会失真。2026-11-05 在公司中转站（地址只在本地信息文件，上游是 Antigravity）实测：
- Chat Completions、Responses、Anthropic Messages、Gemini 原生（`/antigravity/v1beta/models/{model}:generateContent`）四条协议都通，都能看画面、听音轨（6 秒测试片的颜色顺序、画面数字和人声都答对了；72 秒真片的 7 句台词都听全了）。
- 按 reins 的写法跑两轮工具调用：第一轮调工具，第二轮在工具结果里给视频。三条现有线都通；Chat 线的结果按 reins 的现行做法上浮到紧随其后的 user 消息。Messages 线返回的 thinking 块和 `tool_use` 块都带 `signature`。
- 视频在各线的放法：Chat 只认 `image_url` 的 data URI（`video_url` 被丢，`file` 被当成文字、4.7 万 token、输出乱码）；Responses 只认 `input_image`（`input_file` 同样被当成文字）；Messages 的 `image` 和 `document` 两种块都认，填视频 mime 就行。
- 视频的 token：同一条片子在四条线上输入 token 一样（6 秒 868，72 秒 6847），按每秒约 95 token 算，是 Gemini 的低分辨率档。只有原生协议的 `generationConfig.mediaResolution: HIGH` 能升档（6 秒 812→2000，72 秒 6.8k→21k）；Chat / Responses 的 `detail: "high"`、`extra_body` 等写法都不起作用。`videoMetadata`（截段、fps）四条线都被忽略，截段只能由宿主先裁好片子。

现状：`ContentPart` 只有 `text` / `image` / `tool_reference`（`packages/core/src/events/base.ts`），能力位只有 `images`（`packages/core/src/lowering/types.ts`）。`ImagePart.mime` 不校验，三条线都把 mime 原样编码进去（Chat `data:${mime};base64`、Anthropic `media_type`、Responses `input_image`），所以宿主现在把 `video/mp4` 塞进 `ImagePart` 就能跑。OnSet 不打算这样做，原因有三：
1. 估算失真：`projection/estimate.ts` 每张图固定按 `IMAGE_TOKENS = 1600` 估，72 秒视频实际 6.8k（高分辨率 21k），上下文用量少估，整理和兜底裁剪的时机就跟着不准。
2. 能力位会误放行：`images: true` 的模型不一定收视频（比如 DeepSeek 收图不收视频），这时视频会以图片身份发出去，换来上游报错，而不是按降级矩阵落成文字占位、记一条 lossy。
3. 每轮重发：视频进了历史就每轮整段重发。图片也有这个问题，但图片 1–2k token，视频要 7k–20k，而且一个角色一次 run 可能看好几段。

建议：
- **core**：加媒体片段，比如 `{ type: "video" | "audio"; mime; data; durationSec? }`，或者统一成一种 `MediaPart`、按 mime 大类分。能力位加 `video` / `audio`，与 `images` 并列，缺省为 false。`run-loop.ts` 的 `CONTENT_PART_TYPES`、`loop/tools.ts`、`server/handler.ts` 的白名单同步放行。
- **估算**：按时长估，比如视频每秒约 100 token、音频每秒约 32 token（Gemini 低分辨率档），宿主可覆盖。拿不到时长时按字节保守估。
- **降级矩阵**：三条线写清落点。能力位为 true 时，Chat 落 `image_url`、Responses 落 `input_image`、Anthropic 落 `image`（这是中转站转换层认的写法，各家官方协议本身不收视频，要在 `note` 里写明，算 lossy 还是 exact 由 reins 定）；能力位为 false 时降成文字占位（"此处有一段 N 秒视频，模型不收视频"），记 dropped。工具结果里的视频照图片的上浮规则走。
- **（可选）历史里的旧媒体**：投影时把较早的视频 / 音频折叠成文字占位，只保留最近 N 段，或交给宿主的 `toModelOutput` 决定。这一项可以晚于前三项。
- **（可选，优先级最低）Gemini 原生第四条线**：`contents` / `parts`、`inlineData`、`functionCall` / `functionResponse`、`thoughtSignature` 回放、`generationConfig`（`mediaResolution`、`thinkingConfig.thinkingLevel`、`includeThoughts`）。中转站实测这些都生效，`thinkingLevel: low` 时思考 token 从约 200 降到 95。它是唯一能开高分辨率、拿到原生思考的线，转换损失最小，但工作量最大，等前几项用起来、确认低分辨率不够看再做。

OnSet 这边跟着做的（reins 发版后）：型号库的模型加"收视频 / 收音频"勾选；`fs_read` / `read_resource` 读视频、音频时，模型能收就直接给片子（宿主自定时长和字节上限），不能收就照旧给元数据加封面；看片助手 `media_inspect` 留给不收视频的模型用。在那之前，Gemini 先按现有三条线之一接成普通主脑（倾向 Messages 线：它带回签名，reins 的 Anthropic 线本来就回放 thinking 签名；但 `tool_use` 块上的 `signature` 是中转站的非标字段，reins 会不会保留、丢了中转站认不认，还没经 reins 实测）。

优先级中：不影响现有功能，但决定角色能不能"自己看片"，这是 OnSet 下一阶段提升成片判断力的主要办法。

> **处置（reins，2026-11-05）**：接，分三步——先核签名、再做视频 / 音频片段、旧媒体折叠与 Gemini 原生线暂缓。
> - **签名（已核）**：`spikes/gemini-relay-signature/` 用 reins 真实降级层在三条线上各跑两轮依赖工具调用（step 1 取口令、step 2 凭口令取暗号），两遍 6/6 答对暗号。中转站只在 Messages 线返回签名，且是挂在 `tool_use` 块上的 `signature`（这次没有返回 thinking 块）；reins 不保留这个字段，后续请求不带签名，中转站照样接受。Chat / Responses 线的响应里没有任何签名字段。**OnSet 现在就可以按任一条线把 Gemini 接成普通主脑**，Messages 线不比另两条多得什么。
> - **视频 / 音频（待实施，方案另写）**：采纳 OnSet 的原因 ① ②，改三处——独立的 `video` / `audio` 两种片段（不用一种按 mime 区分的 MediaPart：分开写，漏处理的地方编译不过；混在一起，漏掉的地方会悄悄当成图片发出去）；费率常量进 core 缺省估算，宿主要改就注入自己的 `TokenEstimator`，不另加开关；能力位缺省 false、内置模型表一律不开，宿主对中转站模型声明为 true 时落 exact 并在 note 写明"中转站方言，官方端点不收"，false 时落文字占位、记 lossy（与现有图片占位同一约定：落点按事件记，不按片段记）。pi 版恒占位；tools-mcp 顺带把 MCP 原生的 audio 块与 video/* / audio/* 资源接上。
> - **P0 实测（`spikes/media-parts/`，两遍一致）**：视频和**纯音频**在三条线上都放图片槽（Chat `image_url` / Responses `input_image` / Anthropic `image` 块），user 与工具结果 24/24；**Chat / Responses 的 `input_audio` 回 200 但被静默丢弃，模型会编出没说过的词，别用**（踩坑 45）。混放图 + 视频 + 音频、Anthropic 缓存断点打在媒体块上、19.3 MB 视频都通过。费率：视频（含音轨）每秒 91 token，与码率和画面内容无关；纯音频每秒 25。DeepSeek `deepseek-flash` 收到放在图片槽里的视频 / 音频回 400。OnSet 读文件时请把 `durationSec` 带上，估算才准。
> - **暂缓**：旧媒体折叠是框架替模型决定，按宪法一不做缺省，现有 compact 折叠 + `recall` 已覆盖工具结果里的视频，记 OPT 待真实用量；Gemini 原生第四条线同意 OnSet 的判断，等低分辨率确认不够用再做。

## 建议 13（经营类漫剧验证试拍补充，2026-11-06）：run 进行中到的新消息，在下一次调模型前交给模型

背景：OnSet 的角色被消息唤醒后跑一个 run，run 中途给它的新消息（别的角色转向、Boss 拍板或私信）在 OnSet 的投递表里排队，等这次 run 结束、角色空闲后再起下一个 run 才看到。这期间角色一直按旧信息派活、写记忆、发言，看到新消息后再回头改。

实测（2026-11-06 项目「国内经营类漫剧验证」，全员主脑 `gemini-3.8-flash-high`，经公司中转站走 Anthropic Messages 线）：
- 104 次 run 里有 21 次中途来了新消息，共 48 条，平均晚 130 秒被看到，最长 18 分钟；前一个项目 397 次 run 里有 120 次，平均 136 秒，最长 29 分钟。
- 最典型的一次：制片 00:17:56 开工，00:19:10 Boss 通过方案定稿，附言"同意方案 A 跟画风方案 A，同步下美术，生图多试某模型"；制片 00:37:21 收工后才看到。中间 18 分钟它写了 2 次记忆、发布 1 份文档、建 3 个条目、改 5 次条目、派 7 次活，都不知道 Boss 已定稿和附言。00:28:50 Boss 的私信同样没看到。
- 时间全花在模型上：这次 run 的工具执行都是毫秒级，两次工具调用之间隔 1 到 3 分钟（中途还有两次上游 `fetch failed`，各耗约 1 分钟）。一批里通常只有一个调用。所以**每次调模型之前**是关键的空档：按这个空档塞，Boss 的定稿 00:20:24 就能被看到。同一批工具之间的空档对 OnSet 是次要的。

reins 已提的方案（2026-11-06 讨论）：run 里加收件箱，在每次调模型前、同批每个调用执行前塞入；走与 run 起步输入同一道白名单（`system_note(host)` + `user_message`）；同批里还没执行的调用复用 11-05 的停止收尾，不执行、记一条"因新消息到达未执行"交还模型重判，做成选项；收尾时收件箱非空就不结束、再给一轮；不靠"先停再重开"。这些 OnSet 都同意。reins 提的三个问题：
1. **调用方式**：OnSet 在进程里直接调 `runLoop`；`@reinsjs/server` 只用 `InMemoryRunRegistry` 与 `createAgentHandler` 给界面推轨迹，run 进行中不会 POST 新消息。第一版只改 core 就够，server 改不改 409 不影响 OnSet。
2. **部署**：单机单进程（SQLite store），一次只开一个项目，不需要多实例。
3. **样本**：就是上面制片这次 run（会话日志 seq 80–156，加同期两条投递原文）。已导出到 `2026-11-06-OnSet样本-run中途消息/`（会话日志、系统提示与工具表、两条投递原文、中途应塞入的位置，见其中 README）。

建议：收件箱用**拉**的方式，不用宿主推。
- `runLoop`（`agent.run()` 同理）接一个可选回调，比如 `pendingInput?: () => Promise<EventDraft[]>`。每个空档（调模型前；同批下一个调用执行前，可选）和收尾前各调一次，返回非空就照起步输入的规则写入时间线，空数组表示没有。收尾时返回非空就再给一轮。
- 宿主照常从事件流认领写进去的输入（OnSet 现在就是看到本次输入的那条事件，才把投递标为已送达、前移游标），reins 不需要知道投递是什么。

为什么要拉、不要推：
1. OnSet 塞给模型的不只是消息原文，而是当场组装的输入：背景说明（待办、条目动态、经验库更新，按会话游标算差量）加 `user_message`。这些要到塞的那一刻才算得准，提前推进去就会过时，同一条动态也可能在两份输入里重复。
2. 投递表是唯一真源：先标已送达、再写入时间线，崩溃会丢；先写入、后标记，又和现在起步输入的认领方式不一致。拉的话，宿主把"这次给了哪些"记在本地，看到写入事件再提交，与起步输入完全同一条路径。推的话 reins 内存里会多一份收件箱状态，进程崩溃就丢。
3. 收尾"收件箱非空就再给一轮"在拉模式下就是"收尾前再拉一次"，不会和 OnSet 现有的"空闲后唤醒、处理积压"重复投递：没被拉走的照旧排队，下个 run 带走。

优先级高：这是试拍里角色返工和对外误导的主要来源之一，Boss 的拍板晚十几分钟生效在流水线里很常见。OnSet 这边跟着做的（reins 发版后）：调度器接上回调，按会话游标组装中途输入，复用"看到输入即标已送达"；协作规则补一句"中途收到的消息与手上的事冲突时先停下改向"；`pnpm stats` 加"中途送达"条数与等待时长，与本条数据对照。
