# Regression harness layout

**Status:** Layout proposal. No implementation.
**Source:** [claim-lifecycle-design-2026-09-17.md](../docs/claim-lifecycle-design-2026-09-17.md), section 9.

Snapshot findings on golden PRs and diff them like code. Block on lower-bound
drops, using paired comparison and bootstrap confidence intervals, so run-to-run
noise does not read as a regression.

This harness is separate from `benchmarks/`, which holds the frozen Martian split
and the paired comparison. This one answers "did we get worse since yesterday",
not "how good are we".

## Layout

```
harness/
  golden-prs/
    <pr_id>/
      snapshot.json     findings from the last accepted run
      notes.md          why this PR is in the set, and what it is meant to catch
  smoke/
    selection.json      the current 10 PR ids, with the reason each was picked
    correlation.csv     smoke-to-full agreement over time
```

`<pr_id>` is stable and provenance-bearing, for example `grafana-107534`.

### `snapshot.json`

One accepted run. Findings sorted by `claim_id` so a diff is readable.

```json
{
  "pr_id": "grafana-107534",
  "harness_commit": "<sha>",
  "engine_commit": "<sha>",
  "model": "<id>",
  "verifier_model": "<id>",
  "policy": "balanced",
  "recorded": "<YYYY-MM-DD>",
  "verdict": "nits",
  "findings": [
    { "claim_id": "c-0142", "type": "injection_risk", "location": "orders.py:47",
      "final_severity": "P1", "verifier_confidence": "high" }
  ]
}
```

Store the full evidence chain beside the snapshot, not inside it. The snapshot is
for diffing; the chain is for auditing a specific finding.

### `notes.md`

Why the case is in the set, what it is meant to catch, and any known limitation.
A golden PR nobody can justify should be retired, not carried.

## Smoke script

**Inputs:** the 10 ids in `smoke/selection.json`, an engine commit, a model pair
(investigator and verifier, which must be different families), a policy name and
a cost ceiling.

**Outputs:** a per-PR finding set, a diff against each `snapshot.json`, an
aggregate verdict of pass, regress or inconclusive, and the actual cost and
latency for the run. Exit non-zero only on regress, so inconclusive does not
block a merge on noise alone.

**Selection:** 10 PRs chosen for historical score movement. A case that never
moves buys no information. Record the reason per id.

## Correlation tracking

`smoke/correlation.csv` tracks whether the 10-PR smoke still predicts the full
eval. Re-pick the 10 when it decays. Columns:

| Column | Meaning |
| --- | --- |
| `date` | Run date. |
| `engine_commit` | Engine under test. |
| `smoke_selection_hash` | Hash of `selection.json`, so a re-pick is visible. |
| `smoke_score` | Aggregate smoke result. |
| `full_score` | Aggregate full-eval result, blank when no full eval ran. |
| `delta` | `full_score` minus `smoke_score`. |
| `rolling_correlation` | Correlation over the trailing window. |
| `window_n` | Paired runs in that window. |
| `action` | `none`, `repick`, `investigate`. |

A correlation that decays means the smoke set has stopped representing the full
eval. Re-pick, and record that as `repick` so the series stays interpretable.
