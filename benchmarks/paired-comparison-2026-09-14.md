# Paired controller comparison — 2026-09-14

**Complete: all 60 attempts and all 60 grades retained. Discovery-first completed more reviews, but did not improve measured bug detection.** Both versions matched 27 of 72 Core annotation opportunities. The candidate generated more unmatched report candidates, so its upstream Core F2 was slightly lower.

This is 15 development PRs × two reviewers × two repeats, using gpt-5.6-sol at medium effort through the same repaired local Codex adapter. The 72 opportunities are **36 expected Core issues reviewed twice**, not 72 unique bugs. Thirty-five reserved cases remain unrun.

## Final results

| Measure | Repaired r02-24 | Discovery-first r02-26 |
| --- | ---: | ---: |
| Core annotations matched | 27/72 | 27/72 |
| Core recall | 37.5% | 37.5% |
| Upstream Core precision | 19.4% | 17.2% |
| Upstream Core F2 | **0.316** | 0.303 |
| Structured findings | 56 | 74 |
| Candidates extracted from full reports | 143 | 165 |
| Upstream unmatched candidates | 112 | 130 |
| Reviews completed | 24/30 (80.0%) | **29/30 (96.7%)** |
| Completed within ten minutes | 21/30 | **27/30** |
| Median attempt, including partial attempts | 5m33s | 5m25s |
| 95th percentile attempt | 40m12s | 10m23s |
| Slowest attempt | 42m57s | 11m18s |
| Sum of attempt durations | 261.8 minutes | 162.8 minutes |

The completion advantage is observed in this experiment. It does not establish a production service-level guarantee or isolate the effect of a single controller change. Durations come from review receipts, include model waits and assessment, and exclude source preparation and grading. The 95th percentile uses nearest rank across all 30 attempts. The review run took **3h55m19s wall-clock**; sums above combine concurrent work. Two extreme baseline waits dominate the duration difference; the medians are close.

### Repeats and consistency

| Repeat | Baseline Core matches / F2 | Candidate Core matches / F2 | Baseline / candidate completed |
| --- | --- | --- | --- |
| 1 | 14/36 · 0.320 | 15/36 · 0.326 | 12/15 · 15/15 |
| 2 | 13/36 · 0.313 | 12/36 · 0.279 | 12/15 · 14/15 |

The first repeat's one-match candidate advantage reversed in the second. Across both repeats, the candidate matched more annotations on four cases, the baseline on five, and six were tied.

- Baseline matched **11/36 annotations in both repeats**, five in only one, and 20 in neither.
- Candidate matched **10/36 in both repeats**, seven in only one, and 19 in neither.

The union of repeat detections is a consistency diagnostic, not a best-of-two score. These are repeated observations on 15 public development cases, not independent new cases or evidence of superiority over hosted bots. The [older plain-agent comparison](martian-comparison-2026-09-11.md) used a different adapter setup and is historical context, not a fresh paired competitor result.

## What “unmatched” means here

Upstream unmatched candidates are **not an independently established count of false bug claims**. The pinned extractor processes the entire rendered report, including quality advice, suggested fixes and operational status. For example, case-006 baseline repeat 2 records zero structured findings, yet extraction creates six unmatched candidates: five testing concerns and the controller's “validation not run” statement.

The source audit also finds unannotated issues, overlapping or disputed annotations, and semantic matching disagreements. None is used to rewrite this score. The candidate emitted more findings, but this experiment does not supply an exhaustive, blinded precision estimate for them. A separately labeled findings-only diagnostic and adjudicated clean controls are needed to distinguish discovery quality from report extraction.

## Why reviews stopped

All seven incomplete attempts remain in both accuracy and operational denominators; their retained findings were graded.

| Attempt | Duration | Observed stop |
| --- | ---: | --- |
| Baseline case-038 r1 | 8m35s | Adapter returned an incomplete response with known usage; four findings and quality retained. Exact failure stage unavailable. |
| Baseline case-015 r1 | 15m45s | Input-count guard after 50 calls; 46 tool rejections, six findings, no quality checkpoint. |
| Baseline case-022 r1 | 8m04s | Input-count guard; three findings and 13/14 file coverage. |
| Baseline case-050 r2 | 42m57s | Long model wait followed by an incomplete response; zero accepted findings. Exact adapter failure stage unavailable. |
| Baseline case-015 r2 | 40m12s | A 38m53s response caused the timing heuristic to expose only finish, despite 20m27s remaining. One finding and 10/28 file coverage retained. |
| Baseline case-022 r2 | 5m53s | Input-count guard after 19 calls; three findings and 13/14 file coverage. |
| Candidate case-046 r2 | 3m33s | Adapter rejected an error event followed by a completed turn. Saved final output contains 11 schema-valid investigation calls; zero were applied. |

The input-count guard uses a conservative local adapter estimate. It is not evidence of actual provider context exhaustion: the last settled inputs for baseline case-015 r1 and case-022 r2 were 113,001 and 226,214 tokens respectively. The reporting-time failure is distinct from transport failure. A successful model response can still leave the review incomplete.

## Source-level gaps

The [source audit](paired-audit-2026-09-14.md) covers all 15 cases and records unresolved claims. It is source-based, not blinded, and does not independently validate every emitted finding. Historical target applications were not executed.

- **Inspect actual dependencies, not just file prefixes.** All four case-042 reviews miss a reachable optional-member dereference. The relevant type is below an inspected prefix. A separate Discourse false alarm misses initialization near the end of a base class.
- **Verify framework assumptions.** Baseline case-015 r1 claims an enum starts at zero and proposes changing a correct migration. The repository's implementation explicitly starts at one; the candidate reads it and avoids that false alarm.
- **Check whether the failure is newly introduced.** A baseline SMS duplicate-retry claim describes a risk already present at base.
- **Use narrow mechanical validation where it can decide the question.** Candidate case-015 misses an invalid ERB closure in both repeats. An existing syntax-only reproduction on the same source demonstrates the error.
- **Validate fixes separately from findings.** A correct Sentry filtered-marker finding suggests a direct offset commit that could bypass earlier queued work. Source applicability alone does not establish a safe fix.

The existing prompt already requests callers, guards, invariants and counterevidence. Repeating that instruction is not a sufficient improvement plan. We need better verification capability, evidence handling and a way to withdraw a disproved claim.

## Usage and cost

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Model calls | 471 | 457 |
| Tool calls / rejections | 3,134 / 138 | 2,639 / 62 |
| Reported input tokens | 41,621,063 | 37,677,229 |
| Cached subset | 37,486,976 | 34,539,520 |
| Reported output tokens | 279,891 | 259,565 |
| Attempts with incomplete usage accounting | 0 | 0 |

Candidate input usage was about 9.5% lower; rejections were about 55% lower. These are aggregate tokens across requests, not maximum context lengths. For the 29 candidate attempts with a discovery checkpoint, median discovery took 252 seconds and subsequent assessment took 60 seconds. Assessment occupied 1,858 of 9,554 aggregate seconds in those attempts (19.5%); phase medians need not add to the full-review median.

Reviews used the existing local ChatGPT subscription: **$0 additional review API charges**, with subscription allocation unknown and plan allowance consumed. This agent did not redeem a reset credit. An account allowance refresh occurred outside this agent's tool calls during the run.

Grading used OpenRouter openai/gpt-5.2: **$3.279808 settled**, plus **$0.37149525 reserved for three unknown-charge requests**. Total charged-or-reserved accounting is **$3.65130325**, within the **$5 cap**. All 1,038 judge requests remain in the ledger; uncertain charges are not treated as zero.

## Fixes delivered separately

These changes are committed and copied to the working tree, but **none changes, retries or rescores the 60 frozen attempts**:

- `3385130`: accept an earlier CLI stream error only after a later valid completed turn. Preserve process, session, usage, output and native-tool checks; an error after completion still fails. Trace recovered-error counts without message contents.
- `b00bc22` / r02-27: check encoded source-response size before recording evidence. An offline fixture proved that a rejected oversized read previously counted toward coverage. This is not an observed cause of the live benchmark outcomes.
- Harness fixes: matching runtime identity (`02c7bb3`), a three-worker queue without idle wave barriers (`5018dd9`), and reliable CLI entrypoints through symlinked paths (`c2c6980`). The frozen run retains its original scheduler and module-loading behavior.

The full isolated review suite passed **193 tests**, with one Linux-only execution test skipped on macOS. The focused checks reproduced the adapter and coverage failures before their fixes. No live accuracy or completion improvement from these follow-ups has yet been measured.

## Next experiment

1. **Finish the reliability work before another broad comparison.** Investigate conservative input forecasting using confirmed usage, and prevent one extreme response from reserving the remaining inspection window for reporting. Verify bounds and failure handling; keep every new live attempt separate from this run.
2. **Improve defect verification one factor at a time.** Start with narrow base/head syntax checks and an explicit source-backed recheck/withdraw path for findings. Add regression cases for incomplete dependency reads, incorrect framework assumptions and pre-existing risks; do not encode the Martian answers into reviewer prompts.
3. **Make the accuracy measure trustworthy.** Add reviewed benign controls and a separate structured-findings diagnostic alongside the unchanged full-report score. Select a candidate on development evidence before opening the 35 reserved cases.

The decision is to keep discovery-first as a working candidate with better observed completion, **not to declare it a more accurate reviewer**.

## Per-case Core matches

Numbers are repeat 1 / repeat 2; every partial attempt is included.

| Case / original PR | Expected Core issues | Baseline r1 / r2 | Candidate r1 / r2 |
| --- | ---: | ---: | ---: |
| [case-032](https://github.com/keycloak/keycloak/pull/32918) | 2 | 0 / 1 | 0 / 1 |
| [case-023](https://github.com/grafana/grafana/pull/107534) | 1 | 1 / 0 | 0 / 0 |
| [case-050](https://github.com/getsentry/sentry/pull/95633) | 1 | 0 / 0 | 0 / 0 |
| [case-009](https://github.com/calcom/cal.com/pull/8087) | 1 | 1 / 1 | 1 / 1 |
| [case-042](https://github.com/ai-code-review-evaluation/sentry-greptile/pull/2) | 4 | 3 / 3 | 3 / 1 |
| [case-017](https://github.com/ai-code-review-evaluation/discourse-graphite/pull/6) | 1 | 0 / 0 | 0 / 0 |
| [case-006](https://github.com/calcom/cal.com/pull/22345) | 1 | 0 / 0 | 0 / 0 |
| [case-038](https://github.com/keycloak/keycloak/pull/37634) | 4 | 2 / 3 | 2 / 2 |
| [case-046](https://github.com/getsentry/sentry/pull/77754) | 2 | 1 / 1 | 1 / 0 |
| [case-015](https://github.com/ai-code-review-evaluation/discourse-graphite/pull/4) | 8 | 0 / 0 | 1 / 1 |
| [case-040](https://github.com/keycloak/keycloak/pull/40940) | 2 | 2 / 2 | 2 / 2 |
| [case-028](https://github.com/grafana/grafana/pull/90939) | 2 | 2 / 1 | 1 / 1 |
| [case-005](https://github.com/calcom/cal.com/pull/14943) | 2 | 0 / 0 | 1 / 0 |
| [case-016](https://github.com/ai-code-review-evaluation/discourse-graphite/pull/5) | 3 | 1 / 0 | 1 / 1 |
| [case-022](https://github.com/grafana/grafana/pull/106778) | 2 | 1 / 1 | 2 / 2 |

## Integrity and reproduction

See the [protocol](paired-review.md), [machine-readable result](paired-comparison-2026-09-14.json), and [source audit](paired-audit-2026-09-14.md).

- Candidate reviewed: r02-26 / `cdd925d`; local CLI 0.145.0. Model, effort, source packets, profile, shared adapter and renderer were fixed. Each pair ran sequentially; repeat 2 reversed the starting arm. Three pairs ran concurrently in waves.
- Frozen manifest SHA256: `91c7f1682fab794e93d753bf969567c3200f9da6a00d5d3998fa94c5d47f7c81`.
- Pinned [upstream benchmark](https://github.com/withmartian/code-review-benchmark/tree/e616e849755441da38f18bf3adba2c9583b03803): extractor, deduplicator, semantic judge and scorer unchanged.
- An explicit grader transport correction reduced actual concurrency from 20 to 3 after ten completed grades and 151 settled requests, with none in flight. All retained grades and the ledger prefix were preserved exactly. Original and continuation protocols are separately hashed.
- The frozen harness loads the common adapter through the candidate runtime for both arms. Baseline controller traces and receipts exist, but module identity suppresses adapter-specific baseline traces and affects provider-error class identity. This limits failure attribution; the future correction is excluded from these results.
- Final summarization verified every frozen file, all 60 rendered report hashes, matching evaluation identities, the original retained grades, and the cost-ledger prefix. All 60 evaluations completed without unresolved grading errors. Three charge uncertainties remain as described above.

Raw evidence is in `review/.runs/paired-review-20260914-v2/`. Its verified `summary.json` SHA256 is `da5d477bc608ec07966196a93e1b3c86570d60187435a0e145193d6108ba6f54`. The tracked JSON preserves those metrics and adds descriptive analysis, caveats and follow-up fix references. New code lives separately from the immutable experiment; no failed attempt was replaced.
