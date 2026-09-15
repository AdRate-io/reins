# eval 对照报告 —— deepseek/deepseek-v4-flash（窗口 64000）

# eval report

Model `deepseek/deepseek-v4-flash`, 3 fixture(s) x 2 arm(s), 36 run(s), took 1030.5s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| brain-lean | 100% | 100% | 226,529 | 57,998 | 84.7% | 100% | 2.5% → 0.0% | 0.1 / 0.6 / 0.7 | 7.1 | 26.2 | 0.0 | 32.2s |
| threshold | 100% | 100% | 203,645 | 51,159 | 85.0% | 99% | 2.5% → 0.0% | 0.0 / 0.4 / 0.3 | 6.1 | 23.4 | 0.1 | 25.1s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: failed ❌ (candidate `brain-lean` against `threshold`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 203,645 | 226,529 | ❌ |
| candidate completion >= reference | 100.0% | 99.6% | ❌ |
| candidate recall >= reference | 99.2% | 100.0% | ✅ |
| candidate violation rate after compaction <= before | 2.5% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adrate-patrol-audit | brain-lean | 1 | done | 100% | 101,498 | 39,290 | 70.3% | 100% | 0/19 → 0/0 | 0 / 0 / 0 | 4 | 16 | 17.6s |
| adrate-patrol-audit | brain-lean | 2 | done | 100% | 104,094 | 39,006 | 72.2% | 100% | 0/19 → 0/0 | 0 / 0 / 0 | 4 | 16 | 19.0s |
| adrate-patrol-audit | brain-lean | 3 | done | 100% | 98,086 | 37,721 | 70.4% | 100% | 0/22 → 0/0 | 0 / 0 / 0 | 4 | 18 | 15.4s |
| adrate-patrol-audit | brain-lean | 4 | done | 100% | 166,458 | 45,383 | 82.5% | 100% | 0/22 → 0/0 | 0 / 0 / 0 | 6 | 19 | 21.8s |
| adrate-patrol-audit | brain-lean | 5 | done | 100% | 139,341 | 44,416 | 78.7% | 100% | 0/25 → 0/0 | 0 / 0 / 0 | 5 | 20 | 29.7s |
| adrate-patrol-audit | brain-lean | 6 | done | 93% | 155,196 | 49,097 | 79.6% | 100% | 0/26 → 0/0 | 0 / 0 / 0 | 6 | 21 | 36.5s |
| adrate-patrol-audit | threshold | 1 | done | 100% | 125,289 | 42,115 | 76.5% | 100% | 0/22 → 0/0 | 0 / 0 / 0 | 5 | 18 | 24.1s |
| adrate-patrol-audit | threshold | 2 | done | 100% | 129,522 | 42,661 | 76.3% | 100% | 0/25 → 0/0 | 0 / 0 / 0 | 5 | 20 | 17.9s |
| adrate-patrol-audit | threshold | 3 | done | 100% | 124,511 | 42,143 | 76.5% | 100% | 0/24 → 0/0 | 0 / 0 / 0 | 5 | 19 | 27.2s |
| adrate-patrol-audit | threshold | 4 | done | 100% | 221,868 | 51,833 | 86.5% | 100% | 0/23 → 0/0 | 0 / 0 / 0 | 8 | 19 | 25.6s |
| adrate-patrol-audit | threshold | 5 | done | 100% | 106,293 | 42,127 | 70.6% | 100% | 0/22 → 0/0 | 0 / 0 / 0 | 4 | 18 | 27.1s |
| adrate-patrol-audit | threshold | 6 | done | 100% | 101,192 | 40,251 | 69.5% | 100% | 0/22 → 0/0 | 0 / 0 / 0 | 4 | 18 | 21.6s |
| adrate-patrol-disable | brain-lean | 1 | done | 100% | 318,652 | 77,538 | 86.3% | 100% | 0/44 → 0/1 | 1 / 0 / 1 | 10 | 37 | 60.3s |
| adrate-patrol-disable | brain-lean | 2 | done | 100% | 315,530 | 69,924 | 88.4% | 100% | 0/50 → 0/0 | 0 / 0 / 0 | 9 | 42 | 39.2s |
| adrate-patrol-disable | brain-lean | 3 | done | 100% | 299,235 | 68,605 | 87.9% | 100% | 0/45 → 0/0 | 0 / 0 / 0 | 9 | 37 | 42.9s |
| adrate-patrol-disable | brain-lean | 4 | done | 100% | 351,392 | 71,802 | 89.8% | 100% | 0/45 → 0/0 | 0 / 0 / 0 | 10 | 38 | 36.0s |
| adrate-patrol-disable | brain-lean | 5 | done | 100% | 341,190 | 70,470 | 90.0% | 100% | 0/45 → 0/0 | 0 / 0 / 0 | 10 | 36 | 40.0s |
| adrate-patrol-disable | brain-lean | 6 | done | 100% | 405,987 | 88,381 | 89.4% | 100% | 0/46 → 0/1 | 1 / 0 / 1 | 12 | 38 | 62.5s |
| adrate-patrol-disable | threshold | 1 | done | 100% | 222,351 | 56,809 | 85.1% | 100% | 0/38 → 0/0 | 0 / 0 / 0 | 7 | 32 | 35.4s |
| adrate-patrol-disable | threshold | 2 | done | 100% | 376,731 | 86,542 | 87.1% | 100% | 0/49 → 0/0 | 0 / 0 / 0 | 11 | 42 | 41.0s |
| adrate-patrol-disable | threshold | 3 | done | 100% | 248,486 | 59,443 | 86.5% | 100% | 0/39 → 0/0 | 0 / 0 / 0 | 8 | 34 | 32.6s |
| adrate-patrol-disable | threshold | 4 | done | 100% | 294,677 | 65,199 | 88.4% | 100% | 0/40 → 0/0 | 0 / 0 / 0 | 9 | 32 | 36.6s |
| adrate-patrol-disable | threshold | 5 | done | 100% | 176,019 | 50,566 | 81.2% | 100% | 0/36 → 0/0 | 0 / 0 / 0 | 6 | 31 | 24.8s |
| adrate-patrol-disable | threshold | 6 | done | 100% | 218,798 | 55,675 | 84.9% | 100% | 0/37 → 0/0 | 0 / 0 / 0 | 7 | 32 | 31.4s |
| adrate-patrol-resume | brain-lean | 1 | done | 100% | 175,429 | 105,387 | 45.7% | 100% | 10/22 → 0/13 | 0 / 2 / 2 | 6 | 29 | 27.6s |
| adrate-patrol-resume | brain-lean | 2 | done | 100% | 240,907 | 36,081 | 95.7% | 100% | 0/14 → 0/8 | 0 / 1 / 1 | 5 | 17 | 17.7s |
| adrate-patrol-resume | brain-lean | 3 | done | 100% | 286,531 | 38,851 | 97.2% | 100% | 0/14 → 0/10 | 0 / 1 / 1 | 6 | 18 | 21.4s |
| adrate-patrol-resume | brain-lean | 4 | done | 100% | 174,938 | 38,772 | 88.9% | 100% | 0/15 → 0/10 | 0 / 2 / 2 | 6 | 19 | 28.8s |
| adrate-patrol-resume | brain-lean | 5 | done | 100% | 216,562 | 76,940 | 73.4% | 100% | 0/13 → 0/23 | 0 / 2 / 2 | 9 | 32 | 35.1s |
| adrate-patrol-resume | brain-lean | 6 | done | 100% | 186,502 | 46,304 | 85.7% | 100% | 0/15 → 0/9 | 0 / 2 / 2 | 6 | 19 | 27.6s |
| adrate-patrol-resume | threshold | 1 | done | 100% | 229,911 | 103,191 | 61.9% | 100% | 0/18 → 0/3 | 0 / 1 / 1 | 5 | 16 | 18.0s |
| adrate-patrol-resume | threshold | 2 | done | 100% | 231,024 | 34,725 | 95.7% | 100% | 0/18 → 0/3 | 0 / 1 / 1 | 5 | 16 | 16.7s |
| adrate-patrol-resume | threshold | 3 | done | 100% | 183,821 | 29,340 | 94.8% | 100% | 0/17 → 0/1 | 0 / 1 / 1 | 4 | 15 | 15.6s |
| adrate-patrol-resume | threshold | 4 | done | 100% | 230,075 | 33,891 | 95.8% | 100% | 0/18 → 0/3 | 0 / 1 / 1 | 5 | 16 | 15.3s |
| adrate-patrol-resume | threshold | 5 | done | 100% | 215,318 | 50,814 | 86.7% | 86% | 10/22 → 0/10 | 0 / 2 / 1 | 6 | 27 | 24.5s |
| adrate-patrol-resume | threshold | 6 | done | 100% | 229,723 | 33,539 | 95.9% | 100% | 0/18 → 0/3 | 0 / 1 / 1 | 5 | 16 | 15.9s |


## 按 fixture

### adrate-patrol-audit

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 6 | 100% | 99% | 100% | 127,446 | 77% | 4.8 | 18.3 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 23s |
| threshold | 6 | 100% | 100% | 100% | 134,779 | 78% | 5.2 | 18.7 | 0.0 | 0.0/0.0 | 0.0% → 0.0% | 24s |

### adrate-patrol-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 6 | 100% | 100% | 100% | 338,664 | 89% | 10.0 | 38.0 | 0.0 | 0.3/0.0 | 0.0% → 0.0% | 47s |
| threshold | 6 | 100% | 100% | 100% | 256,177 | 86% | 8.0 | 33.8 | 0.2 | 0.0/0.0 | 0.0% → 0.0% | 34s |

### adrate-patrol-resume

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 6 | 100% | 100% | 100% | 213,478 | 83% | 6.3 | 22.3 | 0.0 | 0.0/1.7 | 7.6% → 0.0% | 26s |
| threshold | 6 | 100% | 100% | 98% | 219,979 | 88% | 5.0 | 17.7 | 0.0 | 0.0/1.2 | 7.6% → 0.0% | 18s |
