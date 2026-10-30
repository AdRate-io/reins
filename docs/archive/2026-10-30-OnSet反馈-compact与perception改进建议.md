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
