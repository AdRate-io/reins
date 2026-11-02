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
