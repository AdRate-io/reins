# eval 对照报告 —— anthropic/deepseek-v4-flash（窗口 64000）

# eval report

Model `anthropic/deepseek-v4-flash`, 1 fixture(s) x 2 arm(s), 12 run(s), took 472.4s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| brain-lean | 100% | 100% | 355,889 | 75,953 | 89.2% | 100% | 0.0% → 0.0% | 0.3 / 0.0 / 0.3 | 10.3 | 38.7 | 0.0 | 45.2s |
| threshold | 100% | 100% | 252,219 | 60,680 | 86.3% | 100% | 0.0% → 0.0% | 0.0 / 0.0 / 0.0 | 8.0 | 33.7 | 0.0 | 33.5s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: failed ❌ (candidate `brain-lean` against `threshold`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 252,219 | 355,889 | ❌ |
| candidate completion >= reference | 100.0% | 100.0% | ✅ |
| candidate recall >= reference | 100.0% | 100.0% | ✅ |
| candidate violation rate after compaction <= before | 0.0% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adrate-patrol-disable | brain-lean | 1 | done | 100% | 323,301 | 78,847 | 86.1% | 100% | 0/45 → 0/1 | 1 / 0 / 1 | 10 | 40 | 45.9s |
| adrate-patrol-disable | brain-lean | 2 | done | 100% | 412,595 | 79,897 | 91.2% | 100% | 0/44 → 0/0 | 0 / 0 / 0 | 11 | 38 | 52.1s |
| adrate-patrol-disable | brain-lean | 3 | done | 100% | 315,508 | 68,865 | 88.5% | 100% | 0/43 → 0/0 | 0 / 0 / 0 | 9 | 38 | 34.8s |
| adrate-patrol-disable | brain-lean | 4 | done | 100% | 341,548 | 79,583 | 87.7% | 100% | 0/49 → 0/1 | 1 / 0 / 1 | 11 | 41 | 62.0s |
| adrate-patrol-disable | brain-lean | 5 | done | 100% | 428,748 | 80,614 | 91.6% | 100% | 0/45 → 0/0 | 0 / 0 / 0 | 12 | 38 | 41.5s |
| adrate-patrol-disable | brain-lean | 6 | done | 100% | 313,631 | 67,909 | 88.6% | 100% | 0/42 → 0/0 | 0 / 0 / 0 | 9 | 37 | 35.1s |
| adrate-patrol-disable | threshold | 1 | done | 100% | 245,627 | 61,077 | 85.4% | 100% | 0/41 → 0/0 | 0 / 0 / 0 | 8 | 35 | 32.2s |
| adrate-patrol-disable | threshold | 2 | done | 100% | 235,371 | 60,152 | 85.3% | 100% | 0/39 → 0/0 | 0 / 0 / 0 | 7 | 33 | 38.1s |
| adrate-patrol-disable | threshold | 3 | done | 100% | 261,263 | 61,506 | 86.7% | 100% | 0/39 → 0/0 | 0 / 0 / 0 | 8 | 34 | 32.1s |
| adrate-patrol-disable | threshold | 4 | done | 100% | 220,230 | 56,300 | 84.9% | 100% | 0/38 → 0/0 | 0 / 0 / 0 | 7 | 32 | 31.7s |
| adrate-patrol-disable | threshold | 5 | done | 100% | 307,040 | 66,963 | 88.6% | 100% | 0/41 → 0/0 | 0 / 0 / 0 | 10 | 34 | 36.4s |
| adrate-patrol-disable | threshold | 6 | done | 100% | 243,785 | 58,083 | 86.4% | 100% | 0/40 → 0/0 | 0 / 0 / 0 | 8 | 34 | 30.5s |


## 按 fixture

### adrate-patrol-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 6 | 100% | 100% | 100% | 355,889 | 89% | 10.3 | 38.7 | 0.0 | 0.3/0.0 | 0.0% → 0.0% | 45s |
| threshold | 6 | 100% | 100% | 100% | 252,219 | 86% | 8.0 | 33.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 33s |
