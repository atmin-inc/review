# Paired controller comparison

Compare repaired r02-24 with discovery-first r02-26 on the existing 15 development
PRs. Each arm reviews each case twice: 60 reviews. The 35 reserved cases remain
unrun; only development annotations are copied into the evaluator's directory.

Both controllers use the same continuous local Codex adapter, gpt-5.6-sol at medium
effort, immutable source packets, completion profile and report renderer. Snapshot
preparation does not fetch new commits. No target commands execute and no expected
annotations or PR discussions enter reviewer context. Quality and optional fixes
remain part of both workflows; this experiment does not change their publication
order. The candidate is cdd925d, including changed-range attribute hardening.

A fixed hash seed selects case order and the first arm. The second repeat reverses
arm order for each PR. Three independent PR pairs run concurrently, with the two
arms within each pair sequential. Failed and unattempted outcomes remain in the
index. A free worker starts the next pair without waiting for the other pairs;
the second repeat still waits for the entire first repeat. The earlier frozen
2026-09-14 v2 experiment retains its original three-pair wave barriers.
Provider authentication, quota or funding errors stop new dispatch; runs
are never silently resumed or replaced. No reset credits are consumed.

The frozen manifest pins both runtimes, the common adapter and renderer, source
packets, grader code and selected labels. Hashes are checked before inference and
again before publishing results. Raw reports, structured findings, receipts and
traces are retained. Intermediate findings are not fed back into reviewers.

Primary grading uses the existing pinned Martian extractor, deduplicator, semantic
judge and Core/F2 scorer. The OpenRouter judge retains its $5 total reservation
ledger, zero SDK retries and existing upstream retry behavior. Unknown charges
retain reservations. Each arm/repeat has a distinct evaluation key; no repeated
result can overwrite an earlier one. Grading errors prevent a final score.

Report each repeat and pooled counts per arm, paired case deltas, repeat agreement,
precision, recall, F2, completion, all-attempt latency, settled usage and unknown
usage. A slow or failed run is not excluded to improve averages. Do not claim a
statistically established improvement from two repeats or a public development set.

Keep the unchanged upstream score separate from a source audit. Group findings by
root cause without arm labels for the audit; distinguish supported extra defects,
unsupported claims, pre-existing behavior, duplicate/split matching issues and
unresolved judgments. For misses, distinguish uninspected relevant source from
missed consequences despite inspection and concerns lost during reporting. Record
uncertainty and source references; do not silently rewrite labels to favor atmin.
Choose subsequent changes from recurring classes supported by these results.
