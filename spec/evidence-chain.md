# Spec: evidence chain

**Status:** Draft. Not implemented.
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

### Evidence entry

| Field | Type | Required | Notes |
| --- | --- | :---: | --- |
| `rung` | enum | yes | `symbolic`, `executable`, `cross_family_llm`. |
| `check` | string | yes | What was run, precisely enough to re-run. |
| `result` | string or number | yes | `hit`, `miss`, or a probability for rung 3. |

## Confidence rules

These are policy, evaluated in code, not by a model.

1. LLM-only evidence caps `verifier_confidence` at **moderate**, whatever the
   probability returned.
2. **high** requires a symbolic or executable hit **and** cross-family LLM
   agreement.
3. A hitting symbolic rung that disagrees with the LLM rung lowers confidence and
   routes the claim to a human. The majority does not win.
4. A symbolic refutation ends the claim immediately. Later rungs are not run.
5. Rung 2 being unavailable is recorded as a limitation, not silently skipped.
   Until the sandbox question is settled, claims needing rung 2 cap at moderate.

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
    { "rung": "executable",
      "check": "scoped test drives the query with user_input=\"' OR '1'='1\"",
      "result": "hit, returns all rows rather than the open subset" },
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
