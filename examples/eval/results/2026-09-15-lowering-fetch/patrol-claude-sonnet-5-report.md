# eval 对照报告 —— anthropic/claude-sonnet-5（窗口 64000）

# eval report

Model `anthropic/claude-sonnet-5`, 3 fixture(s) x 2 arm(s), 18 run(s), took 799.5s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| brain-lean | 100% | 100% | 204,427 | 85,308 | 66.5% | 100% | 0.0% → 0.0% | 0.7 / 0.0 / 0.7 | 6.2 | 23.2 | 0.0 | 53.1s |
| threshold | 100% | 100% | 209,519 | 80,494 | 69.7% | 100% | 0.0% → 0.0% | 0.0 / 0.3 / 0.3 | 4.4 | 21.2 | 0.0 | 35.8s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: passed ✅ (candidate `brain-lean` against `threshold`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 209,519 | 204,427 | ✅ |
| candidate completion >= reference | 100.0% | 100.0% | ✅ |
| candidate recall >= reference | 100.0% | 100.0% | ✅ |
| candidate violation rate after compaction <= before | 0.0% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adrate-patrol-audit | brain-lean | 1 | done | 100% | 101,163 | 57,809 | 49.3% | 100% | 0/18 → 0/0 | 0 / 0 / 0 | 3 | 16 | 33.4s |
| adrate-patrol-audit | brain-lean | 2 | done | 100% | 102,085 | 53,229 | 55.3% | 100% | 0/17 → 0/0 | 0 / 0 / 0 | 3 | 16 | 32.8s |
| adrate-patrol-audit | brain-lean | 3 | done | 100% | 101,140 | 52,239 | 55.6% | 100% | 0/17 → 0/0 | 0 / 0 / 0 | 3 | 16 | 29.1s |
| adrate-patrol-audit | threshold | 1 | done | 100% | 91,458 | 52,916 | 48.2% | 100% | 0/17 → 0/0 | 0 / 0 / 0 | 3 | 16 | 28.9s |
| adrate-patrol-audit | threshold | 2 | done | 100% | 91,859 | 50,217 | 52.0% | 100% | 0/18 → 0/0 | 0 / 0 / 0 | 3 | 16 | 26.7s |
| adrate-patrol-audit | threshold | 3 | done | 100% | 91,815 | 50,168 | 52.1% | 100% | 0/17 → 0/0 | 0 / 0 / 0 | 3 | 16 | 26.9s |
| adrate-patrol-disable | brain-lean | 1 | done | 100% | 217,950 | 78,502 | 73.4% | 100% | 0/18 → 0/17 | 1 / 0 / 1 | 8 | 33 | 63.4s |
| adrate-patrol-disable | brain-lean | 2 | done | 100% | 233,393 | 87,392 | 72.0% | 100% | 0/19 → 0/20 | 1 / 0 / 1 | 9 | 36 | 75.9s |
| adrate-patrol-disable | brain-lean | 3 | done | 100% | 256,295 | 84,734 | 76.6% | 100% | 0/22 → 0/17 | 1 / 0 / 1 | 8 | 35 | 77.4s |
| adrate-patrol-disable | threshold | 1 | done | 100% | 246,003 | 75,479 | 78.6% | 100% | 0/35 → 0/0 | 0 / 0 / 0 | 6 | 32 | 45.2s |
| adrate-patrol-disable | threshold | 2 | done | 100% | 259,549 | 77,318 | 79.7% | 100% | 0/33 → 0/0 | 0 / 0 / 0 | 6 | 31 | 50.7s |
| adrate-patrol-disable | threshold | 3 | done | 100% | 289,470 | 82,296 | 81.3% | 100% | 0/38 → 0/0 | 0 / 0 / 0 | 7 | 35 | 57.0s |
| adrate-patrol-resume | brain-lean | 1 | done | 100% | 269,412 | 156,134 | 47.5% | 100% | 0/4 → 0/18 | 1 / 0 / 1 | 7 | 19 | 51.4s |
| adrate-patrol-resume | brain-lean | 2 | done | 100% | 287,051 | 100,014 | 73.7% | 100% | 0/5 → 0/19 | 1 / 0 / 1 | 8 | 19 | 58.6s |
| adrate-patrol-resume | brain-lean | 3 | done | 100% | 271,351 | 97,720 | 72.4% | 100% | 0/4 → 0/18 | 1 / 0 / 1 | 7 | 19 | 55.8s |
| adrate-patrol-resume | threshold | 1 | done | 100% | 271,753 | 149,685 | 50.4% | 100% | 0/17 → 0/1 | 0 / 1 / 1 | 4 | 15 | 29.3s |
| adrate-patrol-resume | threshold | 2 | done | 100% | 271,814 | 93,095 | 73.8% | 100% | 0/17 → 0/1 | 0 / 1 / 1 | 4 | 15 | 28.0s |
| adrate-patrol-resume | threshold | 3 | done | 100% | 271,949 | 93,272 | 73.8% | 100% | 0/17 → 0/1 | 0 / 1 / 1 | 4 | 15 | 29.3s |


## 按 fixture

### adrate-patrol-audit

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 3 | 100% | 100% | 100% | 101,463 | 53% | 3.0 | 16.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 32s |
| threshold | 3 | 100% | 100% | 100% | 91,711 | 51% | 3.0 | 16.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 27s |

### adrate-patrol-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 3 | 100% | 100% | 100% | 235,879 | 74% | 8.3 | 34.7 | 0.0 | 1.0/0.0 | 0.0% → 0.0% | 72s |
| threshold | 3 | 100% | 100% | 100% | 265,007 | 80% | 6.3 | 32.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 51s |

### adrate-patrol-resume

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 3 | 100% | 100% | 100% | 275,938 | 65% | 7.3 | 19.0 | 0.0 | 1.0/0.0 | 0.0% → 0.0% | 55s |
| threshold | 3 | 100% | 100% | 100% | 271,839 | 66% | 4.0 | 15.0 | 0.0 | 0.0/1.0 | 0.0% → 0.0% | 29s |
