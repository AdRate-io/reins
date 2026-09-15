# eval 对照报告 —— deepseek/deepseek-v4-flash（窗口 64000）

# eval report

Model `deepseek/deepseek-v4-flash`, 6 fixture(s) x 2 arm(s), 36 run(s), took 228.1s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| eager | 100% | 100% | 73,059 | 9,635 | 97.1% | — | 0.0% → 0.0% | 0.0 / 0.0 / 0.0 | 2.6 | 2.1 | 0.0 | 5.9s |
| lazy | 100% | 100% | 29,486 | 5,192 | 93.3% | — | 0.0% → 0.0% | 0.0 / 0.0 / 0.0 | 3.8 | 3.1 | 0.1 | 6.8s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: passed ✅ (candidate `lazy` against `eager`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 73,059 | 29,486 | ✅ |
| candidate completion >= reference | 100.0% | 100.0% | ✅ |
| candidate recall >= reference | — | — | ✅ no planted facts, counted as a pass |
| candidate violation rate after compaction <= before | 0.0% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| td-disable-one | eager | 1 | done | 100% | 86,107 | 10,075 | 99.3% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 9.7s |
| td-disable-one | eager | 2 | done | 100% | 85,994 | 9,847 | 99.2% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 9.5s |
| td-disable-one | eager | 3 | done | 100% | 56,808 | 6,350 | 99.2% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 4.5s |
| td-disable-one | lazy | 1 | done | 100% | 46,574 | 9,249 | 91.3% | — | 0/7 → 0/0 | 0 / 0 / 0 | 5 | 4 | 11.1s |
| td-disable-one | lazy | 2 | done | 100% | 31,327 | 5,522 | 94.3% | — | 0/4 → 0/0 | 0 / 0 / 0 | 4 | 3 | 7.9s |
| td-disable-one | lazy | 3 | done | 100% | 39,856 | 6,333 | 95.8% | — | 0/6 → 0/0 | 0 / 0 / 0 | 5 | 4 | 10.0s |
| td-gmvmax-roas | eager | 1 | done | 100% | 87,038 | 10,084 | 99.2% | — | 0/7 → 0/0 | 0 / 0 / 0 | 3 | 4 | 7.4s |
| td-gmvmax-roas | eager | 2 | done | 100% | 87,246 | 10,177 | 99.2% | — | 0/7 → 0/0 | 0 / 0 / 0 | 3 | 4 | 7.7s |
| td-gmvmax-roas | eager | 3 | done | 100% | 86,590 | 9,982 | 99.1% | — | 0/7 → 0/0 | 0 / 0 / 0 | 3 | 4 | 6.8s |
| td-gmvmax-roas | lazy | 1 | done | 100% | 53,207 | 9,316 | 93.4% | — | 0/8 → 0/0 | 0 / 0 / 0 | 6 | 5 | 11.4s |
| td-gmvmax-roas | lazy | 2 | done | 100% | 34,741 | 6,056 | 94.2% | — | 0/7 → 0/0 | 0 / 0 / 0 | 4 | 4 | 8.4s |
| td-gmvmax-roas | lazy | 3 | done | 100% | 47,242 | 9,456 | 91.1% | — | 0/10 → 0/0 | 0 / 0 / 0 | 5 | 5 | 9.0s |
| td-list-enabled | eager | 1 | done | 100% | 56,854 | 31,280 | 50.2% | — | 0/3 → 0/0 | 0 / 0 / 0 | 2 | 1 | 6.0s |
| td-list-enabled | eager | 2 | done | 100% | 56,840 | 6,382 | 99.1% | — | 0/2 → 0/0 | 0 / 0 / 0 | 2 | 1 | 3.7s |
| td-list-enabled | eager | 3 | done | 100% | 56,836 | 6,378 | 99.1% | — | 0/3 → 0/0 | 0 / 0 / 0 | 2 | 1 | 3.6s |
| td-list-enabled | lazy | 1 | done | 100% | 20,931 | 3,766 | 92.5% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 5.3s |
| td-list-enabled | lazy | 2 | done | 100% | 20,900 | 3,274 | 95.2% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 4.5s |
| td-list-enabled | lazy | 3 | done | 100% | 22,035 | 4,294 | 90.5% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 4.4s |
| td-report-zero-spend | eager | 1 | done | 100% | 86,600 | 10,107 | 99.1% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 8.1s |
| td-report-zero-spend | eager | 2 | done | 100% | 57,007 | 6,549 | 99.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 2 | 1 | 5.3s |
| td-report-zero-spend | eager | 3 | done | 100% | 86,212 | 9,834 | 99.2% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.7s |
| td-report-zero-spend | lazy | 1 | done | 100% | 21,757 | 4,362 | 91.0% | — | 0/3 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.3s |
| td-report-zero-spend | lazy | 2 | done | 100% | 23,447 | 5,015 | 89.6% | — | 0/5 → 0/0 | 0 / 0 / 0 | 3 | 3 | 6.8s |
| td-report-zero-spend | lazy | 3 | done | 100% | 21,631 | 3,660 | 94.3% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 6.1s |
| td-rule-disable | eager | 1 | done | 100% | 85,005 | 9,319 | 99.2% | — | 0/5 → 0/0 | 0 / 0 / 0 | 3 | 2 | 5.2s |
| td-rule-disable | eager | 2 | done | 100% | 84,985 | 9,299 | 99.2% | — | 0/4 → 0/0 | 0 / 0 / 0 | 3 | 2 | 4.9s |
| td-rule-disable | eager | 3 | done | 100% | 85,118 | 9,316 | 99.2% | — | 0/5 → 0/0 | 0 / 0 / 0 | 3 | 2 | 5.7s |
| td-rule-disable | lazy | 1 | done | 100% | 28,566 | 4,720 | 93.6% | — | 0/5 → 0/0 | 0 / 0 / 0 | 4 | 3 | 5.8s |
| td-rule-disable | lazy | 2 | done | 100% | 28,461 | 4,154 | 95.8% | — | 0/5 → 0/0 | 0 / 0 / 0 | 4 | 3 | 5.6s |
| td-rule-disable | lazy | 3 | done | 100% | 29,392 | 5,085 | 92.7% | — | 0/7 → 0/0 | 0 / 0 / 0 | 4 | 3 | 6.5s |
| td-whoami-advertisers | eager | 1 | done | 100% | 56,601 | 6,143 | 99.3% | — | 0/4 → 0/0 | 0 / 0 / 0 | 2 | 2 | 3.1s |
| td-whoami-advertisers | eager | 2 | done | 100% | 56,629 | 6,171 | 99.3% | — | 0/4 → 0/0 | 0 / 0 / 0 | 2 | 2 | 3.4s |
| td-whoami-advertisers | eager | 3 | done | 100% | 56,597 | 6,139 | 99.3% | — | 0/4 → 0/0 | 0 / 0 / 0 | 2 | 2 | 3.9s |
| td-whoami-advertisers | lazy | 1 | done | 100% | 20,221 | 3,287 | 94.0% | — | 0/5 → 0/0 | 0 / 0 / 0 | 3 | 3 | 4.4s |
| td-whoami-advertisers | lazy | 2 | done | 100% | 20,245 | 2,969 | 95.8% | — | 0/5 → 0/0 | 0 / 0 / 0 | 3 | 3 | 5.0s |
| td-whoami-advertisers | lazy | 3 | done | 100% | 20,214 | 2,938 | 95.9% | — | 0/5 → 0/0 | 0 / 0 / 0 | 3 | 3 | 4.3s |


## 按 fixture

### td-disable-one

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 76,303 | 99% | 2.7 | 1.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 8s |
| lazy | 3 | 100% | 100% | — | 39,252 | 94% | 4.7 | 3.7 | 0.7 | 0.0/0.0 | 0.0% → 0.0% | 10s |

### td-gmvmax-roas

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 86,958 | 99% | 3.0 | 4.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 7s |
| lazy | 3 | 100% | 100% | — | 45,063 | 93% | 5.0 | 4.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 10s |

### td-list-enabled

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 56,843 | 83% | 2.0 | 1.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 4s |
| lazy | 3 | 100% | 100% | — | 21,289 | 93% | 3.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 5s |

### td-report-zero-spend

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 76,606 | 99% | 2.7 | 1.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 7s |
| lazy | 3 | 100% | 100% | — | 22,278 | 92% | 3.0 | 2.3 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 6s |

### td-rule-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 85,036 | 99% | 3.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 5s |
| lazy | 3 | 100% | 100% | — | 28,806 | 94% | 4.0 | 3.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 6s |

### td-whoami-advertisers

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eager | 3 | 100% | 100% | — | 56,609 | 99% | 2.0 | 2.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 3s |
| lazy | 3 | 100% | 100% | — | 20,227 | 95% | 3.0 | 3.0 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 5s |
