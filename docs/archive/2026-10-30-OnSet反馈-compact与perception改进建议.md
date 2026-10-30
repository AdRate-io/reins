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
