# Spec: evidence chain

**Status:** Draft. Implemented in `src/evidence.ts`.
**Source:** [claim-lifecycle-design-2026-09-17.md](../docs/claim-lifecycle-design-2026-09-17.md), sections 4 and 5.

Every finding ships with `verdict`, `evidence[]`, `final_severity` and
`verifier_confidence`. The chain, not the prompt, is what makes a finding
auditable. A prompt explains what was asked for. A chain records what was found,
by which method, with what result, and it survives a model change.

## Fields

| Field | Type | Required | Notes |
| --- | --- | :---: | --- |
| `claim_id` | string | yes | Links back to the claim in [claim-schema.md](./claim-schema.md). |
| `verdict` | enum | yes | `confirmed`, `refuted`, `inconclusive`. |
| `evidence[]` | Evidence[] | yes | Ordered by rung. Non-empty even when refuted. |
| `final_severity` | enum `P0`–`P4` | when confirmed | May differ from the claim's proposed severity. |
| `verifier_confidence` | enum | yes | `low`, `moderate`, `high`. See the cap below. |
| `suspect_checks[]` | string[] | yes | Symbolic checks the LLM rung contradicted. Calibration input, never shown to a user. Empty in the ordinary case. |

### Evidence entry

| Field | Type | Required | Notes |
| --- | --- | :---: | --- |
| `rung` | enum | yes | `symbolic`, `ci_output`, `cross_family_llm`. In v1 the middle rung reads test output CI already produced; it never executes. |
| | | | Every rung answers one proposition of the claim, never the claim itself. |
| `check` | string | yes | What was run, precisely enough to re-run. |
| `result` | string or number | yes | `hit`, `miss`, or a probability for rung 3. |

## Confidence rules

These are policy, evaluated in code, not by a model.

1. LLM-only evidence caps `verifier_confidence` at **moderate**, whatever the
   probability returned. So does a claim with any single proposition that only a
   model could settle: an argument is no stronger than its weakest step.
2. **high** requires a symbolic or executable hit **and** cross-family LLM
   agreement.

   The LLM rung is asked about one proposition at a time, never about the claim.
   SMOKE_TEST_JEV.md is the reason: factual checks came back sharp and composite
   judgments clustered around a coin flip, so "is this an auth bypass?" is the
   question to avoid and "does any caller compare owner to account before
   update()?" is the question to ask. That is also how a proposition no symbolic
   check can express gets settled at all, rather than leaving every claim that
   has one inconclusive.
3. A hitting symbolic rung that disagrees with the LLM rung lowers confidence and
   makes the claim inconclusive, so it does not ship. The majority does not win,
   and neither does a person: there is no human-escalation verdict.

   A check is a text proxy for a proposition, so a contradiction here is a report
   about the proxy rather than a dispute about the code. A check reading "the body
   lacks `owner !== account`" hits when the comparison has moved into a helper, and
   the model is right to say there is no bypass. The other two shapes are the same
   kind of defect: propositions that do not add up to the claim, or a wrong model.
   The contradicted checks are recorded in `suspect_checks` so the catalogue can be
   tightened; nobody is asked to adjudicate.
4. A symbolic refutation ends the claim immediately. Later rungs are not run.
5. Rung 2 being unavailable is recorded as a limitation, not silently skipped.
   In v1 rung 2 reads existing CI output and never executes, so on any corpus
   without CI output it cannot fire and claims needing it cap at moderate.

## Worked example

```json
{
  "claim_id": "c-0142",
  "verdict": "confirmed",
  "evidence": [
    { "rung": "symbolic",
      "check": "AST: query string at orders.py:47 built by interpolation with non-literal `user_input`, no bind parameter",
      "result": "hit" },
    { "rung": "symbolic",
      "check": "call graph: `user_input` reaches orders.py:47 from a user-controlled route with no sanitizer on the path",
      "result": "hit" },
    { "rung": "ci_output",
      "check": "existing CI run: test_orders_search_filters_by_status fails on head with an unexpected row count",
      "result": "hit" },
    { "rung": "cross_family_llm",
      "check": "jev noul sql_injection over the changed hunk (cross-family)",
      "result": 0.94 }
  ],
  "final_severity": "P1",
  "verifier_confidence": "high"
}
```

High confidence is earned because rungs 1 and 2 hit and rung 3 agrees. Had only
rung 3 returned 0.94, the finding would cap at moderate and say so.

## Refuted example

A refuted claim still ships a chain. This is what makes wide investigation safe.

```json
{
  "claim_id": "c-0187",
  "verdict": "refuted",
  "evidence": [
    { "rung": "symbolic",
      "check": "AST: value at cache.py:22 is a module-level literal, never caller-supplied",
      "result": "miss" }
  ],
  "verifier_confidence": "high"
}
```
