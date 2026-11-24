# eval 对照报告 —— deepseek/deepseek-v4-flash（窗口 64000）

# eval report

Model `deepseek/deepseek-v4-flash`, 3 fixture(s) x 2 arm(s), 36 run(s), took 970.0s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/forced/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| brain-lean | 100% | 100% | 206,539 | 52,242 | 85.0% | 100% | 0.0% → 0.0% | 0.1 / 0.3 / 0.0 / 0.4 | 7.8 | 24.8 | 0.0 | 27.8s |
| threshold | 100% | 97% | 203,673 | 49,555 | 85.7% | 100% | 0.0% → 0.0% | 0.0 / 0.0 / 0.3 / 0.3 | 6.4 | 23.3 | 0.2 | 26.1s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: failed ❌ (candidate `brain-lean` against `threshold`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 203,673 | 206,539 | ❌ |
| candidate completion >= reference | 96.8% | 100.0% | ✅ |
| candidate recall >= reference | 100.0% | 100.0% | ✅ |
| candidate violation rate after compaction <= before | 0.0% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/forced/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adrate-patrol-audit | brain-lean | 1 | done | 100% | 148,131 | 47,101 | 78.1% | 100% | 0/25 → 0/0 | 0 / 0 / 0 / 0 | 6 | 20 | 22.1s |
| adrate-patrol-audit | brain-lean | 2 | done | 100% | 109,176 | 41,323 | 71.7% | 100% | 0/21 → 0/0 | 0 / 0 / 0 / 0 | 4 | 19 | 20.8s |
| adrate-patrol-audit | brain-lean | 3 | done | 100% | 217,361 | 52,395 | 85.8% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 8 | 21 | 24.0s |
| adrate-patrol-audit | brain-lean | 4 | done | 100% | 152,143 | 44,546 | 80.5% | 100% | 0/25 → 0/0 | 0 / 0 / 0 / 0 | 6 | 19 | 20.5s |
| adrate-patrol-audit | brain-lean | 5 | done | 100% | 181,293 | 48,467 | 83.0% | 100% | 0/21 → 0/0 | 0 / 0 / 0 / 0 | 7 | 20 | 21.9s |
| adrate-patrol-audit | brain-lean | 6 | done | 100% | 147,686 | 44,582 | 79.4% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 6 | 18 | 19.3s |
| adrate-patrol-audit | threshold | 1 | done | 100% | 92,742 | 38,022 | 68.2% | 100% | 0/19 → 0/0 | 0 / 0 / 0 / 0 | 4 | 18 | 19.8s |
| adrate-patrol-audit | threshold | 2 | done | 100% | 141,028 | 43,454 | 78.8% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 6 | 18 | 20.0s |
| adrate-patrol-audit | threshold | 3 | done | 100% | 98,668 | 39,225 | 69.5% | 100% | 0/20 → 0/0 | 0 / 0 / 0 / 0 | 4 | 17 | 19.5s |
| adrate-patrol-audit | threshold | 4 | done | 100% | 143,624 | 43,285 | 79.2% | 100% | 0/24 → 0/0 | 0 / 0 / 0 / 0 | 6 | 19 | 50.9s |
| adrate-patrol-audit | threshold | 5 | done | 100% | 90,985 | 37,071 | 68.1% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 4 | 18 | 14.5s |
| adrate-patrol-audit | threshold | 6 | done | 100% | 163,684 | 47,332 | 81.0% | 100% | 0/26 → 0/0 | 0 / 0 / 0 / 0 | 6 | 21 | 24.6s |
| adrate-patrol-disable | brain-lean | 1 | done | 100% | 217,344 | 68,160 | 79.1% | 100% | 0/41 → 0/1 | 1 / 0 / 0 / 1 | 8 | 34 | 37.6s |
| adrate-patrol-disable | brain-lean | 2 | done | 100% | 394,767 | 76,354 | 91.0% | 100% | 0/43 → 0/0 | 0 / 0 / 0 / 0 | 11 | 38 | 34.4s |
| adrate-patrol-disable | brain-lean | 3 | done | 100% | 195,323 | 58,005 | 80.6% | 100% | 0/23 → 0/19 | 1 / 0 / 0 / 1 | 10 | 35 | 32.5s |
| adrate-patrol-disable | brain-lean | 4 | done | 100% | 379,188 | 73,793 | 91.0% | 100% | 0/44 → 0/0 | 0 / 0 / 0 / 0 | 11 | 35 | 40.7s |
| adrate-patrol-disable | brain-lean | 5 | done | 100% | 328,538 | 69,684 | 89.2% | 100% | 0/45 → 0/0 | 0 / 0 / 0 / 0 | 10 | 36 | 35.5s |
| adrate-patrol-disable | brain-lean | 6 | done | 100% | 297,542 | 64,723 | 88.6% | 100% | 0/43 → 0/0 | 0 / 0 / 0 / 0 | 9 | 36 | 31.2s |
| adrate-patrol-disable | threshold | 1 | done | 100% | 287,529 | 67,036 | 87.1% | 100% | 0/45 → 0/0 | 0 / 0 / 0 / 0 | 9 | 38 | 64.4s |
| adrate-patrol-disable | threshold | 2 | done | 100% | 344,498 | 71,704 | 89.7% | 100% | 0/42 → 0/0 | 0 / 0 / 0 / 0 | 11 | 36 | 37.4s |
| adrate-patrol-disable | threshold | 3 | done | 100% | 359,519 | 71,173 | 90.2% | 100% | 0/38 → 0/0 | 0 / 0 / 0 / 0 | 11 | 36 | 30.8s |
| adrate-patrol-disable | threshold | 4 | done | 100% | 251,367 | 58,983 | 86.8% | 100% | 0/40 → 0/0 | 0 / 0 / 0 / 0 | 8 | 32 | 32.3s |
| adrate-patrol-disable | threshold | 5 | done | 100% | 334,916 | 70,417 | 89.4% | 100% | 0/44 → 0/0 | 0 / 0 / 0 / 0 | 10 | 36 | 34.6s |
| adrate-patrol-disable | threshold | 6 | done | 100% | 347,298 | 84,181 | 85.8% | 100% | 0/43 → 0/0 | 0 / 0 / 0 / 0 | 10 | 36 | 37.6s |
| adrate-patrol-resume | brain-lean | 1 | done | 100% | 168,793 | 78,707 | 61.1% | 100% | 0/1 → 0/24 | 0 / 1 / 0 / 1 | 8 | 19 | 27.8s |
| adrate-patrol-resume | brain-lean | 2 | done | 100% | 156,218 | 40,903 | 84.5% | 100% | 0/1 → 0/22 | 0 / 1 / 0 / 1 | 7 | 19 | 24.4s |
| adrate-patrol-resume | brain-lean | 3 | done | 100% | 137,050 | 27,956 | 91.4% | 100% | 0/1 → 0/22 | 0 / 1 / 0 / 1 | 7 | 20 | 25.2s |
| adrate-patrol-resume | brain-lean | 4 | done | 100% | 121,548 | 26,278 | 90.4% | 100% | 0/1 → 0/19 | 0 / 1 / 0 / 1 | 6 | 17 | 25.1s |
| adrate-patrol-resume | brain-lean | 5 | done | 100% | 114,467 | 24,496 | 91.0% | 100% | 0/1 → 0/22 | 0 / 1 / 0 / 1 | 6 | 19 | 24.0s |
| adrate-patrol-resume | brain-lean | 6 | done | 100% | 251,139 | 52,880 | 89.6% | 100% | 0/4 → 0/19 | 0 / 1 / 0 / 1 | 10 | 22 | 32.3s |
| adrate-patrol-resume | threshold | 1 | done | 100% | 181,008 | 76,406 | 65.1% | 100% | 0/17 → 0/2 | 0 / 0 / 1 / 1 | 5 | 16 | 16.0s |
| adrate-patrol-resume | threshold | 2 | done | 100% | 195,667 | 43,374 | 87.8% | 100% | 0/18 → 0/4 | 0 / 0 / 1 / 1 | 5 | 17 | 17.7s |
| adrate-patrol-resume | threshold | 3 | done | 43% | 89,587 | 12,866 | 96.3% | 100% | 0/12 → 0/0 | 0 / 0 / 0 / 0 | 2 | 10 | 6.4s |
| adrate-patrol-resume | threshold | 4 | done | 100% | 182,868 | 30,230 | 94.2% | 100% | 0/18 → 0/7 | 0 / 0 / 1 / 1 | 5 | 20 | 16.0s |
| adrate-patrol-resume | threshold | 5 | done | 100% | 180,383 | 28,551 | 94.7% | 100% | 0/18 → 0/2 | 0 / 0 / 1 / 1 | 5 | 16 | 14.8s |
| adrate-patrol-resume | threshold | 6 | done | 100% | 180,744 | 28,682 | 94.7% | 100% | 0/18 → 0/3 | 0 / 0 / 1 / 1 | 5 | 16 | 13.1s |


## 按 fixture

### adrate-patrol-audit

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/请求/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 6 | 100% | 100% | 100% | 159,298 | 81% | 6.2 | 19.5 | 0.0 | 0.0/0.0/0.0 | 0.0% → 0.0% | 21s |
| threshold | 6 | 100% | 100% | 100% | 121,789 | 75% | 5.0 | 18.5 | 0.0 | 0.0/0.0/0.0 | 0.0% → 0.0% | 25s |

### adrate-patrol-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/请求/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 6 | 100% | 100% | 100% | 302,117 | 88% | 9.8 | 35.7 | 0.0 | 0.3/0.0/0.0 | 0.0% → 0.0% | 35s |
| threshold | 6 | 100% | 100% | 100% | 320,855 | 88% | 9.8 | 35.7 | 0.7 | 0.0/0.0/0.0 | 0.0% → 0.0% | 40s |

### adrate-patrol-resume

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/请求/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 6 | 100% | 100% | 100% | 158,203 | 84% | 7.3 | 19.3 | 0.0 | 0.0/1.0/0.0 | 0.0% → 0.0% | 26s |
| threshold | 6 | 100% | 90% | 100% | 168,376 | 88% | 4.5 | 15.8 | 0.0 | 0.0/0.0/0.8 | 0.0% → 0.0% | 14s |

