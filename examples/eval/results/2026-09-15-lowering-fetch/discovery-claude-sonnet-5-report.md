# eval 对照报告 —— anthropic/claude-sonnet-5（窗口 64000）

# eval report

Model `anthropic/claude-sonnet-5`, 6 fixture(s) x 2 arm(s), 36 run(s), took 297.6s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| eager | 100% | 100% | 99,431 | 12,831 | 97.1% | — | 0.0% → 0.0% | 0.0 / 0.0 / 0.0 | 2.3 | 1.7 | 0.0 | 7.8s |
| lazy | 100% | 100% | 36,387 | 5,708 | 94.8% | — | 0.0% → 0.0% | 0.0 / 0.0 / 0.0 | 3.4 | 2.8 | 0.0 | 8.7s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: passed ✅ (candidate `lazy` against `eager`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 99,431 | 36,387 | ✅ |
| candidate completion >= reference | 100.0% | 100.0% | ✅ |
| candidate recall >= reference | — | — | ✅ no planted facts, counted as a pass |
| candidate violation rate after compaction <= before | 0.0% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| td-disable-one | eager | 1 | done | 100% | 85,210 | 9,455 | 99.3% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 6.9s |
| td-disable-one | eager | 2 | done | 100% | 84,964 | 9,099 | 99.6% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 9.3s |
| td-disable-one | eager | 3 | done | 100% | 84,842 | 8,977 | 99.7% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 4.5s |
| td-disable-one | lazy | 1 | done | 100% | 32,111 | 4,993 | 95.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 13.1s |
| td-disable-one | lazy | 2 | done | 100% | 31,002 | 4,241 | 96.9% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 10.5s |
| td-disable-one | lazy | 3 | done | 100% | 32,146 | 4,900 | 95.3% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 8.0s |
| td-gmvmax-roas | eager | 1 | done | 100% | 129,096 | 14,712 | 99.0% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 3 | 12.2s |
| td-gmvmax-roas | eager | 2 | done | 100% | 129,121 | 14,614 | 99.1% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 3 | 12.5s |
| td-gmvmax-roas | eager | 3 | done | 100% | 129,104 | 14,591 | 99.1% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 3 | 13.0s |
| td-gmvmax-roas | lazy | 1 | done | 100% | 47,874 | 8,744 | 92.7% | — | 0/6 → 0/0 | 0 / 0 / 0 | 4 | 5 | 15.0s |
| td-gmvmax-roas | lazy | 2 | done | 100% | 59,499 | 9,664 | 94.5% | — | 0/8 → 0/0 | 0 / 0 / 0 | 5 | 5 | 15.3s |
| td-gmvmax-roas | lazy | 3 | done | 100% | 47,191 | 8,172 | 93.5% | — | 0/5 → 0/0 | 0 / 0 / 0 | 4 | 4 | 12.8s |
| td-list-enabled | eager | 1 | done | 100% | 85,034 | 47,104 | 49.7% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 6.9s |
| td-list-enabled | eager | 2 | done | 100% | 85,051 | 8,745 | 100.0% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 5.8s |
| td-list-enabled | eager | 3 | done | 100% | 85,040 | 8,734 | 100.0% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 5.7s |
| td-list-enabled | lazy | 1 | done | 100% | 31,049 | 13,092 | 64.9% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.7s |
| td-list-enabled | lazy | 2 | done | 100% | 31,027 | 4,360 | 96.4% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.7s |
| td-list-enabled | lazy | 3 | done | 100% | 31,024 | 3,379 | 100.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.9s |
| td-report-zero-spend | eager | 1 | done | 100% | 85,375 | 9,607 | 99.2% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 8.7s |
| td-report-zero-spend | eager | 2 | done | 100% | 85,293 | 9,401 | 99.4% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 8.1s |
| td-report-zero-spend | eager | 3 | done | 100% | 85,548 | 9,656 | 99.2% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 10.2s |
| td-report-zero-spend | lazy | 1 | done | 100% | 31,530 | 4,739 | 95.6% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.3s |
| td-report-zero-spend | lazy | 2 | done | 100% | 31,599 | 4,679 | 96.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.4s |
| td-report-zero-spend | lazy | 3 | done | 100% | 31,561 | 4,648 | 96.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.4s |
| td-rule-disable | eager | 1 | done | 100% | 127,228 | 13,360 | 99.6% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 8.5s |
| td-rule-disable | eager | 2 | done | 100% | 127,203 | 13,261 | 99.7% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 8.5s |
| td-rule-disable | eager | 3 | done | 100% | 127,224 | 13,262 | 99.7% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 8.3s |
| td-rule-disable | lazy | 1 | done | 100% | 41,859 | 5,570 | 97.0% | — | 0/4 → 0/0 | 0 / 0 / 0 | 4 | 3 | 8.1s |
| td-rule-disable | lazy | 2 | done | 100% | 41,873 | 5,482 | 97.2% | — | 0/5 → 0/0 | 0 / 0 / 0 | 4 | 3 | 8.2s |
| td-rule-disable | lazy | 3 | done | 100% | 41,853 | 4,580 | 99.6% | — | 0/4 → 0/0 | 0 / 0 / 0 | 4 | 3 | 7.7s |
| td-whoami-advertisers | eager | 1 | done | 100% | 84,811 | 9,066 | 99.5% | — | 0/3 → 0/0 | 0 / 0 / 0 | 2 | 2 | 4.1s |
| td-whoami-advertisers | eager | 2 | done | 100% | 84,807 | 8,659 | 100.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 2 | 2 | 4.0s |
| td-whoami-advertisers | eager | 3 | done | 100% | 84,803 | 8,655 | 100.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 2 | 2 | 4.3s |
| td-whoami-advertisers | lazy | 1 | done | 100% | 30,591 | 4,147 | 96.9% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 3 | 5.9s |
| td-whoami-advertisers | lazy | 2 | done | 100% | 30,590 | 3,314 | 100.0% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 3 | 6.3s |
| td-whoami-advertisers | lazy | 3 | done | 100% | 30,591 | 4,046 | 97.3% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 3 | 6.1s |


## 按 fixture

### td-disable-one

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 85,005 | 100% | 2.0 | 1.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 7s |
| lazy | 3 | 100% | 100% | — | 31,753 | 96% | 3.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 11s |

### td-gmvmax-roas

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 129,107 | 99% | 3.0 | 3.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 13s |
| lazy | 3 | 100% | 100% | — | 51,521 | 94% | 4.3 | 4.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 14s |

### td-list-enabled

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 85,042 | 83% | 2.0 | 1.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 6s |
| lazy | 3 | 100% | 100% | — | 31,033 | 87% | 3.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 7s |

### td-report-zero-spend

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 85,405 | 99% | 2.0 | 1.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 9s |
| lazy | 3 | 100% | 100% | — | 31,563 | 96% | 3.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 6s |

### td-rule-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 127,218 | 100% | 3.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 8s |
| lazy | 3 | 100% | 100% | — | 41,862 | 98% | 4.0 | 3.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 8s |

### td-whoami-advertisers

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 84,807 | 100% | 2.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 4s |
| lazy | 3 | 100% | 100% | — | 30,591 | 98% | 3.0 | 3.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 6s |
