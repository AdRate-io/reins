# eval 对照报告 —— deepseek/deepseek-v4-flash（窗口 64000）

# eval report

Model `deepseek/deepseek-v4-flash`, 1 fixture(s) x 2 arm(s), 6 run(s), took 262.5s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| brain-lean | 100% | 100% | 354,929 | 73,688 | 90.1% | 100% | 0.0% → 0.0% | 0.0 / 0.0 / 0.0 | 10.3 | 37.0 | 0.0 | 48.4s |
| threshold | 100% | 100% | 278,778 | 64,391 | 87.6% | 100% | 0.0% → 0.0% | 0.0 / 0.0 / 0.0 | 8.3 | 34.7 | 0.0 | 39.1s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: failed ❌ (candidate `brain-lean` against `threshold`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 278,778 | 354,929 | ❌ |
| candidate completion >= reference | 100.0% | 100.0% | ✅ |
| candidate recall >= reference | 100.0% | 100.0% | ✅ |
| candidate violation rate after compaction <= before | 0.0% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adrate-patrol-disable | brain-lean | 1 | done | 100% | 349,602 | 71,279 | 90.2% | 100% | 0/42 → 0/0 | 0 / 0 / 0 | 10 | 35 | 43.8s |
| adrate-patrol-disable | brain-lean | 2 | done | 100% | 322,162 | 70,911 | 89.2% | 100% | 0/44 → 0/0 | 0 / 0 / 0 | 9 | 36 | 52.6s |
| adrate-patrol-disable | brain-lean | 3 | done | 100% | 393,024 | 78,874 | 90.6% | 100% | 0/50 → 0/0 | 0 / 0 / 0 | 12 | 40 | 48.9s |
| adrate-patrol-disable | threshold | 1 | done | 100% | 271,564 | 65,126 | 86.9% | 100% | 0/43 → 0/0 | 0 / 0 / 0 | 8 | 36 | 41.8s |
| adrate-patrol-disable | threshold | 2 | done | 100% | 338,232 | 70,392 | 89.6% | 100% | 0/45 → 0/0 | 0 / 0 / 0 | 10 | 36 | 37.5s |
| adrate-patrol-disable | threshold | 3 | done | 100% | 226,538 | 57,655 | 85.3% | 100% | 0/37 → 0/0 | 0 / 0 / 0 | 7 | 32 | 37.9s |


## 按 fixture

### adrate-patrol-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 3 | 100% | 100% | 100% | 354,929 | 90% | 10.3 | 37.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 48s |
| threshold | 3 | 100% | 100% | 100% | 278,778 | 88% | 8.3 | 34.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 39s |
