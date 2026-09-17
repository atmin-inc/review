# Calibrated decision models in the review loop

**Status:** Notes, September 17, 2026. No integration exists and none is
planned until the repository-state experiment has a measured result.

TypeSafe AI opened early access to Jev on September 15, 2026. Public coverage
describes a "System One" model that returns typed decisions with calibrated
probabilities instead of text: a yes/no answer with a probability, a choice
among defined options, or a score on a scale, with end-to-end latency of
roughly 70–500 ms and list pricing of about $0.042 per million input tokens.
The vendor site could not be fetched from the engineering environment, so the
API shape below is inferred from press coverage and needs checking against the
actual documentation before any code is written.

## Where a decision-only model would fit

atmin's rules already reserve the model for judgment calls and keep routing,
retries and deterministic transforms in code. A decision model is a cheap,
fast judgment call with no prose to parse, which suits a handful of places:

| Decision | Input | Output | Why it fits |
| --- | --- | --- | --- |
| Candidate recheck | Finding, cited source ranges, base/head comparison | `withdraw` / `keep` with probability | A second, differently trained opinion on a candidate before it is published. Correlation with the reviewer's own model family is the known weakness of self-verification; a different model class is a partial answer. |
| Section relevance | Section summary and a changed-hunk cluster | `relevant` probability | Today selection is by path prefix. A calibrated relevance score could gate sections that share no path with the change, without inventing a retrieval service. |
| Disposition classification | Free-text maintainer feedback | One of the eight structured dispositions | The disposition ledger must not let free text rewrite prompts; a typed classification with a confidence keeps the human in the loop for low-confidence cases. |
| Grader assist | Candidate finding and a golden annotation | `same defect` probability | Suggests matches for human adjudication in the benchmark. Never the reviewer's own judge. |
| Pre-existing check | Finding, merge-base read, head read | `introduced` / `pre-existing` | The audit's recurring "already present at base" false alarm is a narrow question with two source excerpts as input. |

## What it does not replace

- Investigation. A decision model cannot navigate source, trace callers or
  read both revisions; it answers a question about material the controller
  already captured.
- Evidence. A probability is not a citation. Findings still require captured
  reads, and a withdrawal still records the counterevidence.
- The benchmark. Any decision-model use is a new experiment factor with its
  own paired comparison, protocol and cost report, measured after repository
  state, not bundled with it.

## Constraints before trying it

- Early access only; no pricing, rate limit, data-retention or model-version
  pinning terms are confirmed. A benchmark result must pin the model identity
  or record that it cannot be pinned.
- Calibration claims are the vendor's own evaluation. The first use should be
  a shadow measurement: record the decision and probability in the receipt
  without changing the published review, then compare against the source
  audit.
- Source excerpts sent to a third provider are a new data flow. It needs the
  same credential separation, spending reservation and no-fallback rules as
  the existing adapters, and repository owners must be able to opt out.
