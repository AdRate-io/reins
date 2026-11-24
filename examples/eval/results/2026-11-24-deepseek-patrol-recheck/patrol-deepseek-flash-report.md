# eval 对照报告 —— deepseek/deepseek-v4-flash（窗口 64000）

# eval report

Model `deepseek/deepseek-v4-flash`, 3 fixture(s) x 2 arm(s), 72 run(s), took 1881.0s.

| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/forced/threshold/consecutive | turns | tool calls | repeated calls | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| brain-lean | 100% | 100% | 190,460 | 49,119 | 84.6% | 100% | 0.0% → 0.0% | 0.1 / 0.3 / 0.0 / 0.5 | 7.5 | 24.7 | 0.1 | 27.2s |
| threshold | 100% | 97% | 212,445 | 49,604 | 86.8% | 100% | 1.2% → 0.0% | 0.0 / 0.0 / 0.3 / 0.3 | 6.8 | 24.2 | 0.1 | 25.1s |

Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).

## Gate: passed ✅ (candidate `brain-lean` against `threshold`)

| rule | reference | candidate | result |
| --- | ---: | ---: | --- |
| candidate total tokens <= reference x 1 | 212,445 | 190,460 | ✅ |
| candidate completion >= reference | 97.3% | 100.0% | ✅ |
| candidate recall >= reference | 100.0% | 100.0% | ✅ |
| candidate violation rate after compaction <= before | 0.0% | 0.0% | ✅ |

## Details

| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/forced/threshold/consecutive | turns | tool calls | wall clock |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adrate-patrol-audit | brain-lean | 1 | done | 100% | 148,131 | 47,101 | 78.1% | 100% | 0/25 → 0/0 | 0 / 0 / 0 / 0 | 6 | 20 | 22.1s |
| adrate-patrol-audit | brain-lean | 10 | done | 100% | 111,572 | 43,489 | 69.8% | 100% | 0/21 → 0/0 | 0 / 0 / 0 / 0 | 4 | 17 | 16.5s |
| adrate-patrol-audit | brain-lean | 11 | done | 100% | 98,884 | 37,943 | 70.7% | 100% | 0/19 → 0/0 | 0 / 0 / 0 / 0 | 4 | 18 | 16.8s |
| adrate-patrol-audit | brain-lean | 12 | done | 100% | 131,170 | 41,660 | 78.0% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 5 | 18 | 18.4s |
| adrate-patrol-audit | brain-lean | 2 | done | 100% | 109,176 | 41,323 | 71.7% | 100% | 0/21 → 0/0 | 0 / 0 / 0 / 0 | 4 | 19 | 20.8s |
| adrate-patrol-audit | brain-lean | 3 | done | 100% | 217,361 | 52,395 | 85.8% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 8 | 21 | 24.0s |
| adrate-patrol-audit | brain-lean | 4 | done | 100% | 152,143 | 44,546 | 80.5% | 100% | 0/25 → 0/0 | 0 / 0 / 0 / 0 | 6 | 19 | 20.5s |
| adrate-patrol-audit | brain-lean | 5 | done | 100% | 181,293 | 48,467 | 83.0% | 100% | 0/21 → 0/0 | 0 / 0 / 0 / 0 | 7 | 20 | 21.9s |
| adrate-patrol-audit | brain-lean | 6 | done | 100% | 147,686 | 44,582 | 79.4% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 6 | 18 | 19.3s |
| adrate-patrol-audit | brain-lean | 7 | done | 100% | 130,351 | 40,956 | 77.9% | 100% | 0/19 → 0/0 | 0 / 0 / 0 / 0 | 5 | 18 | 16.1s |
| adrate-patrol-audit | brain-lean | 8 | done | 100% | 99,332 | 38,046 | 70.9% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 4 | 18 | 17.0s |
| adrate-patrol-audit | brain-lean | 9 | done | 100% | 98,459 | 37,749 | 70.6% | 100% | 0/21 → 0/0 | 0 / 0 / 0 / 0 | 4 | 18 | 15.9s |
| adrate-patrol-audit | threshold | 1 | done | 100% | 92,742 | 38,022 | 68.2% | 100% | 0/19 → 0/0 | 0 / 0 / 0 / 0 | 4 | 18 | 19.8s |
| adrate-patrol-audit | threshold | 10 | done | 100% | 144,925 | 43,664 | 79.4% | 100% | 0/23 → 0/0 | 0 / 0 / 0 / 0 | 6 | 18 | 20.4s |
| adrate-patrol-audit | threshold | 11 | done | 100% | 120,214 | 39,689 | 76.1% | 100% | 0/19 → 0/0 | 0 / 0 / 0 / 0 | 5 | 18 | 15.0s |
| adrate-patrol-audit | threshold | 12 | done | 100% | 134,689 | 43,796 | 77.0% | 100% | 0/25 → 0/0 | 0 / 0 / 0 / 0 | 6 | 20 | 20.0s |
| adrate-patrol-audit | threshold | 2 | done | 100% | 141,028 | 43,454 | 78.8% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 6 | 18 | 20.0s |
| adrate-patrol-audit | threshold | 3 | done | 100% | 98,668 | 39,225 | 69.5% | 100% | 0/20 → 0/0 | 0 / 0 / 0 / 0 | 4 | 17 | 19.5s |
| adrate-patrol-audit | threshold | 4 | done | 100% | 143,624 | 43,285 | 79.2% | 100% | 0/24 → 0/0 | 0 / 0 / 0 / 0 | 6 | 19 | 50.9s |
| adrate-patrol-audit | threshold | 5 | done | 100% | 90,985 | 37,071 | 68.1% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 4 | 18 | 14.5s |
| adrate-patrol-audit | threshold | 6 | done | 100% | 163,684 | 47,332 | 81.0% | 100% | 0/26 → 0/0 | 0 / 0 / 0 / 0 | 6 | 21 | 24.6s |
| adrate-patrol-audit | threshold | 7 | done | 100% | 120,757 | 40,463 | 75.7% | 100% | 0/22 → 0/0 | 0 / 0 / 0 / 0 | 5 | 18 | 14.9s |
| adrate-patrol-audit | threshold | 8 | done | 100% | 197,369 | 50,374 | 84.3% | 100% | 0/27 → 0/0 | 0 / 0 / 0 / 0 | 7 | 20 | 21.9s |
| adrate-patrol-audit | threshold | 9 | done | 100% | 71,000 | 41,970 | 48.3% | 100% | 0/21 → 0/0 | 0 / 0 / 0 / 0 | 3 | 18 | 18.8s |
| adrate-patrol-disable | brain-lean | 1 | done | 100% | 217,344 | 68,160 | 79.1% | 100% | 0/41 → 0/1 | 1 / 0 / 0 / 1 | 8 | 34 | 37.6s |
| adrate-patrol-disable | brain-lean | 10 | done | 100% | 213,277 | 62,941 | 81.2% | 100% | 0/14 → 0/36 | 1 / 0 / 0 / 1 | 12 | 39 | 42.7s |
| adrate-patrol-disable | brain-lean | 11 | done | 100% | 228,362 | 65,354 | 82.3% | 100% | 0/28 → 0/21 | 1 / 0 / 0 / 1 | 12 | 39 | 44.1s |
| adrate-patrol-disable | brain-lean | 12 | done | 100% | 174,092 | 54,975 | 78.7% | 100% | 0/18 → 0/17 | 1 / 0 / 0 / 1 | 10 | 34 | 31.6s |
| adrate-patrol-disable | brain-lean | 2 | done | 100% | 394,767 | 76,354 | 91.0% | 100% | 0/43 → 0/0 | 0 / 0 / 0 / 0 | 11 | 38 | 34.4s |
| adrate-patrol-disable | brain-lean | 3 | done | 100% | 195,323 | 58,005 | 80.6% | 100% | 0/23 → 0/19 | 1 / 0 / 0 / 1 | 10 | 35 | 32.5s |
| adrate-patrol-disable | brain-lean | 4 | done | 100% | 379,188 | 73,793 | 91.0% | 100% | 0/44 → 0/0 | 0 / 0 / 0 / 0 | 11 | 35 | 40.7s |
| adrate-patrol-disable | brain-lean | 5 | done | 100% | 328,538 | 69,684 | 89.2% | 100% | 0/45 → 0/0 | 0 / 0 / 0 / 0 | 10 | 36 | 35.5s |
| adrate-patrol-disable | brain-lean | 6 | done | 100% | 297,542 | 64,723 | 88.6% | 100% | 0/43 → 0/0 | 0 / 0 / 0 / 0 | 9 | 36 | 31.2s |
| adrate-patrol-disable | brain-lean | 7 | done | 100% | 373,560 | 76,805 | 90.2% | 100% | 0/48 → 0/0 | 0 / 0 / 0 / 0 | 11 | 40 | 46.5s |
| adrate-patrol-disable | brain-lean | 8 | done | 100% | 269,722 | 62,477 | 87.5% | 100% | 0/41 → 0/0 | 0 / 0 / 0 / 0 | 8 | 35 | 35.2s |
| adrate-patrol-disable | brain-lean | 9 | done | 100% | 395,777 | 74,599 | 91.3% | 100% | 0/37 → 0/0 | 0 / 0 / 0 / 0 | 12 | 36 | 32.5s |
| adrate-patrol-disable | threshold | 1 | done | 100% | 287,529 | 67,036 | 87.1% | 100% | 0/45 → 0/0 | 0 / 0 / 0 / 0 | 9 | 38 | 64.4s |
| adrate-patrol-disable | threshold | 10 | done | 100% | 390,007 | 75,050 | 91.1% | 100% | 0/48 → 0/0 | 0 / 0 / 0 / 0 | 13 | 37 | 42.3s |
| adrate-patrol-disable | threshold | 11 | done | 100% | 400,269 | 76,787 | 91.1% | 100% | 0/47 → 0/0 | 0 / 0 / 0 / 0 | 13 | 37 | 37.4s |
| adrate-patrol-disable | threshold | 12 | done | 100% | 251,355 | 59,317 | 86.8% | 100% | 0/39 → 0/0 | 0 / 0 / 0 / 0 | 8 | 33 | 33.9s |
| adrate-patrol-disable | threshold | 2 | done | 100% | 344,498 | 71,704 | 89.7% | 100% | 0/42 → 0/0 | 0 / 0 / 0 / 0 | 11 | 36 | 37.4s |
| adrate-patrol-disable | threshold | 3 | done | 100% | 359,519 | 71,173 | 90.2% | 100% | 0/38 → 0/0 | 0 / 0 / 0 / 0 | 11 | 36 | 30.8s |
| adrate-patrol-disable | threshold | 4 | done | 100% | 251,367 | 58,983 | 86.8% | 100% | 0/40 → 0/0 | 0 / 0 / 0 / 0 | 8 | 32 | 32.3s |
| adrate-patrol-disable | threshold | 5 | done | 100% | 334,916 | 70,417 | 89.4% | 100% | 0/44 → 0/0 | 0 / 0 / 0 / 0 | 10 | 36 | 34.6s |
| adrate-patrol-disable | threshold | 6 | done | 100% | 347,298 | 84,181 | 85.8% | 100% | 0/43 → 0/0 | 0 / 0 / 0 / 0 | 10 | 36 | 37.6s |
| adrate-patrol-disable | threshold | 7 | done | 100% | 293,590 | 65,264 | 88.0% | 100% | 0/43 → 0/0 | 0 / 0 / 0 / 0 | 9 | 35 | 30.8s |
| adrate-patrol-disable | threshold | 8 | done | 100% | 299,761 | 66,251 | 88.2% | 100% | 0/45 → 0/0 | 0 / 0 / 0 / 0 | 10 | 37 | 33.8s |
| adrate-patrol-disable | threshold | 9 | done | 100% | 350,642 | 84,760 | 86.0% | 100% | 0/46 → 0/0 | 0 / 0 / 0 / 0 | 10 | 37 | 38.3s |
| adrate-patrol-resume | brain-lean | 1 | done | 100% | 168,793 | 78,707 | 61.1% | 100% | 0/1 → 0/24 | 0 / 1 / 0 / 1 | 8 | 19 | 27.8s |
| adrate-patrol-resume | brain-lean | 10 | done | 100% | 119,252 | 25,364 | 90.6% | 100% | 0/1 → 0/18 | 0 / 1 / 0 / 1 | 6 | 17 | 22.5s |
| adrate-patrol-resume | brain-lean | 11 | done | 100% | 165,029 | 31,512 | 92.9% | 100% | 0/3 → 0/21 | 0 / 1 / 0 / 1 | 7 | 21 | 26.1s |
| adrate-patrol-resume | brain-lean | 12 | done | 100% | 137,543 | 41,466 | 80.7% | 100% | 0/2 → 0/22 | 0 / 1 / 0 / 1 | 6 | 20 | 25.8s |
| adrate-patrol-resume | brain-lean | 2 | done | 100% | 156,218 | 40,903 | 84.5% | 100% | 0/1 → 0/22 | 0 / 1 / 0 / 1 | 7 | 19 | 24.4s |
| adrate-patrol-resume | brain-lean | 3 | done | 100% | 137,050 | 27,956 | 91.4% | 100% | 0/1 → 0/22 | 0 / 1 / 0 / 1 | 7 | 20 | 25.2s |
| adrate-patrol-resume | brain-lean | 4 | done | 100% | 121,548 | 26,278 | 90.4% | 100% | 0/1 → 0/19 | 0 / 1 / 0 / 1 | 6 | 17 | 25.1s |
| adrate-patrol-resume | brain-lean | 5 | done | 100% | 114,467 | 24,496 | 91.0% | 100% | 0/1 → 0/22 | 0 / 1 / 0 / 1 | 6 | 19 | 24.0s |
| adrate-patrol-resume | brain-lean | 6 | done | 100% | 251,139 | 52,880 | 89.6% | 100% | 0/4 → 0/19 | 0 / 1 / 0 / 1 | 10 | 22 | 32.3s |
| adrate-patrol-resume | brain-lean | 7 | done | 100% | 121,879 | 26,378 | 90.5% | 100% | 0/1 → 0/19 | 0 / 1 / 0 / 1 | 6 | 17 | 23.3s |
| adrate-patrol-resume | brain-lean | 8 | done | 100% | 128,281 | 25,983 | 91.8% | 100% | 0/1 → 0/21 | 0 / 1 / 0 / 1 | 7 | 20 | 24.5s |
| adrate-patrol-resume | brain-lean | 9 | done | 100% | 142,311 | 40,244 | 82.4% | 100% | 0/1 → 0/20 | 0 / 1 / 0 / 1 | 7 | 18 | 22.3s |
| adrate-patrol-resume | threshold | 1 | done | 100% | 181,008 | 76,406 | 65.1% | 100% | 0/17 → 0/2 | 0 / 0 / 1 / 1 | 5 | 16 | 16.0s |
| adrate-patrol-resume | threshold | 10 | done | 100% | 181,817 | 29,524 | 94.5% | 100% | 0/18 → 0/5 | 0 / 0 / 1 / 1 | 5 | 18 | 17.2s |
| adrate-patrol-resume | threshold | 11 | done | 100% | 228,748 | 34,292 | 95.6% | 100% | 0/19 → 0/2 | 0 / 0 / 1 / 1 | 6 | 17 | 17.3s |
| adrate-patrol-resume | threshold | 12 | done | 100% | 195,656 | 43,479 | 87.8% | 100% | 0/18 → 0/4 | 0 / 0 / 1 / 1 | 5 | 17 | 16.6s |
| adrate-patrol-resume | threshold | 2 | done | 100% | 195,667 | 43,374 | 87.8% | 100% | 0/18 → 0/4 | 0 / 0 / 1 / 1 | 5 | 17 | 17.7s |
| adrate-patrol-resume | threshold | 3 | done | 43% | 89,587 | 12,866 | 96.3% | 100% | 0/12 → 0/0 | 0 / 0 / 0 / 0 | 2 | 10 | 6.4s |
| adrate-patrol-resume | threshold | 4 | done | 100% | 182,868 | 30,230 | 94.2% | 100% | 0/18 → 0/7 | 0 / 0 / 1 / 1 | 5 | 20 | 16.0s |
| adrate-patrol-resume | threshold | 5 | done | 100% | 180,383 | 28,551 | 94.7% | 100% | 0/18 → 0/2 | 0 / 0 / 1 / 1 | 5 | 16 | 14.8s |
| adrate-patrol-resume | threshold | 6 | done | 100% | 180,744 | 28,682 | 94.7% | 100% | 0/18 → 0/3 | 0 / 0 / 1 / 1 | 5 | 16 | 13.1s |
| adrate-patrol-resume | threshold | 7 | done | 60% | 234,167 | 37,407 | 95.0% | 100% | 10/23 → 0/9 | 0 / 0 / 1 / 1 | 7 | 26 | 22.9s |
| adrate-patrol-resume | threshold | 8 | done | 100% | 181,597 | 29,074 | 94.7% | 100% | 0/18 → 0/3 | 0 / 0 / 1 / 1 | 5 | 16 | 15.4s |
| adrate-patrol-resume | threshold | 9 | done | 100% | 185,333 | 32,580 | 93.2% | 100% | 0/18 → 0/17 | 0 / 0 / 1 / 1 | 5 | 30 | 16.2s |


## 按 fixture

### adrate-patrol-audit

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/请求/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 12 | 100% | 100% | 100% | 135,463 | 78% | 5.3 | 18.7 | 0.0 | 0.0/0.0/0.0 | 0.0% → 0.0% | 19s |
| threshold | 12 | 100% | 100% | 100% | 126,640 | 76% | 5.2 | 18.6 | 0.0 | 0.0/0.0/0.0 | 0.0% → 0.0% | 22s |

### adrate-patrol-disable

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/请求/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 12 | 100% | 100% | 100% | 288,958 | 87% | 10.3 | 36.4 | 0.3 | 0.4/0.0/0.0 | 0.0% → 0.0% | 37s |
| threshold | 12 | 100% | 100% | 100% | 325,896 | 89% | 10.2 | 35.8 | 0.4 | 0.0/0.0/0.0 | 0.0% → 0.0% | 38s |

### adrate-patrol-resume

| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/请求/阈值) | 违规 前→后 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brain-lean | 12 | 100% | 100% | 100% | 146,959 | 86% | 6.9 | 19.1 | 0.0 | 0.0/1.0/0.0 | 0.0% → 0.0% | 25s |
| threshold | 12 | 100% | 92% | 100% | 184,798 | 91% | 5.0 | 18.3 | 0.0 | 0.0/0.0/0.9 | 3.6% → 0.0% | 16s |

