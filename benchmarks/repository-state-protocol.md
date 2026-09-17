# Paired repository-state comparison — predeclared protocol

**Declared:** September 17, 2026, before any trial ran. **Status:** not run.
This protocol is frozen with the experiment directory; results, when
produced, are reported against it without changing it.

## Hypothesis

Supplying RepositoryState v1 sections relevant to the changed paths, built by
the same model under the same budget, increases supported Core detections or
reduces unsupported findings on the 15 frozen Martian development cases
without materially harming completion or cost. The
[repository-state document](../docs/repository-state.md) defines the artifact;
this protocol defines how it is measured.

## Arms

| | Baseline | Candidate |
| --- | --- | --- |
| Engine | r02-28, this repository at the recorded commit | identical build |
| Adapter, model, effort | local Codex adapter, `gpt-5.6-sol`, medium | identical |
| Profile | `profiles/completion-codex-local.json` | identical |
| Snapshot | frozen case packet, diff and `source.git` | identical |
| `repository-state.json` | absent | present, built for the case's target commit |
| `withdraw_finding` | available | available |

The single manipulated factor is the presence of the frozen state file in the
trial directory. Both arms include the withdrawal tool and the r02-28 prompt,
so the comparison isolates repository state, not withdrawal. `contextHash` in
each receipt records which arm ran.

## Cases, order and repeats

- The 15 development cases from `martian-development-split.json`, using the
  same frozen packets as the 2026-09-14 comparison. The 35 reserved cases are
  not built, copied, inspected or run.
- Seed `atmin-repository-state-pairs-20260917-v1` orders cases and chooses the
  first arm per case; repeat two reverses arm order. Two repeats, 60 trials.
- Three PR pairs run concurrently; the two arms of a pair run sequentially. The
  second repeat waits for the whole first repeat.
- Every attempt is retained. Provider authentication, quota or funding errors
  stop new dispatch; nothing is silently resumed or replaced.

## State builds

- One state per case, built with `benchmarks/build-states.mjs` from the case's
  `packet.json` (`baseSha`, `baseRef`) using the same adapter, model, effort
  and profile as the reviews. Builds retain `repository-state.json`,
  `repository-state.receipt.json` and a trace per case.
- A build that stops early keeps its partial artifact (`complete: false`) and
  the case still runs; the summary reports how many states were complete. A
  case without any retained state cannot be frozen.
- State builds run before preparation, never during the comparison, and never
  see PR diffs, annotations or discussions.

## Measurements

Primary, from the pinned upstream extractor, deduplicator, semantic judge and
Core/F2 scorer, per repeat and pooled:

- Core annotations matched (recall), upstream precision, upstream F2.

Secondary, from receipts and trials:

- Completion (`completed` with `stopReason: finished`), completion within ten
  minutes, median and maximum attempt duration, all attempts included.
- Actual input, cached input and output tokens; model calls; tool calls and
  rejections; withdrawals per arm; `repositoryState` status per candidate
  trial (`current`, `stale`).
- State-build cost per case and in total: duration, calls, tokens, tool calls,
  completeness. Reported beside review cost, never folded into it.

Source audit, after grading, grouped by root cause without arm labels:
supported extra defects, unsupported claims, pre-existing behavior at the
merge base, duplicate or split matching issues, and unresolved judgments. For
misses: uninspected relevant source, missed consequence despite inspection,
or a concern lost during reporting. Withdrawn candidates are audited
separately as correct or incorrect withdrawals.

## Decision rule

Repository state is adopted for the next slice only if all hold:

1. Pooled Core matches across both repeats are strictly greater than the
   baseline's, and the candidate does not match fewer annotations in either
   repeat.
2. The source audit does not find more unsupported candidate findings than
   baseline findings, counted per unique root cause.
3. Completed reviews are within one of the baseline, and median attempt
   duration is within 25%.
4. State-build cost is reported with the result.

A tie, a single-repeat advantage, or an advantage that depends on relabeling
is reported as no measured improvement. Two repeats on 15 public cases cannot
establish statistical significance and are not claimed to.

## Commands

```
node benchmarks/build-states.mjs <states> <previous-frozen-comparison> profiles/completion-codex-local.json
node benchmarks/prepare-state-comparison.mjs <frozen> <previous-frozen-comparison> <states>
node <frozen>/engine/benchmarks/paired-review.mjs <frozen>
# grade with the pinned upstream pipeline as in the 2026-09-14 comparison
node benchmarks/paired-summary.mjs <frozen>
```
