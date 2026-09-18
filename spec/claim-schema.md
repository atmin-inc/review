# Spec: claim schema

**Status:** Draft. Not implemented.
**Source:** [claim-lifecycle-design-2026-09-17.md](../docs/claim-lifecycle-design-2026-09-17.md), section 2.

A claim is one falsifiable assertion about one location. It is what an
investigator emits. It is **not** a finding, and it is never shown to a user in
this form. A finding is what survives verification, and it carries the evidence
chain in [evidence-chain.md](./evidence-chain.md).

Markdown by intent. Do not promote this to JSON Schema until the field set has
survived a real implementation.

## Fields

| Field | Type | Required | Notes |
| --- | --- | :---: | --- |
| `claim_id` | string | yes | Content hash over `type`, normalized `location` and `suspected_condition`. Not a sequence number. See stability below. |
| `type` | string | yes | Check category, from a closed vocabulary. Routes the claim to ladder rungs. |
| `location` | string | yes | `path:line` in the reviewed revision. Exactly one location per claim. |
| `description` | string | yes | What the code does that prompted the claim. States behavior, not judgment. |
| `suspected_condition` | string | yes | The trigger under which the defect manifests. A claim with no trigger is not falsifiable and must be rejected at emit time. |
| `severity` | enum `P0`–`P4` | yes | Proposed only. The verifier may raise or lower it. |
| `evidence_to_check[]` | string[] | yes | Specific propositions the verifier must check. At least one. |
| `investigator_confidence` | number 0–1 | no | Prior. Never shown to a user, never used to rank findings, never combined with verifier confidence. |

## `claim_id` stability

Normalized `location` means path plus enclosing symbol, not a raw line number. A
rebase that shifts lines must not mint a new claim, or the regression harness
cannot diff findings across revisions. Two claims colliding within one run get an
appended ordinal.

## `type` vocabulary

Closed and versioned. Adding a type is a schema change, because ladder routing
and per-category calibration both key off it. Initial set:

`injection_risk`, `hardcoded_secret`, `auth_bypass`, `race_condition`,
`data_loss`, `contract_break`, `error_handling_gap`, `resource_leak`.

Note that a claim `type` and a Jev check name are different namespaces. A claim
of type `injection_risk` may be checked by a Jev `sql_injection` noul on rung 3.

## Example

```json
{
  "claim_id": "c-0142",
  "type": "injection_risk",
  "location": "orders.py:47",
  "description": "The SQL query interpolates `user_input` directly into the string.",
  "suspected_condition": "A request reaches this query with a `user_input` value containing a quote or a semicolon.",
  "severity": "P1",
  "evidence_to_check": [
    "The interpolation is not sanitized upstream.",
    "No parameterized binding is used.",
    "`user_input` is reachable from a user-controlled route."
  ],
  "investigator_confidence": 0.6
}
```

## Validation rules

1. `evidence_to_check` must be non-empty.
2. `suspected_condition` must name a trigger, not restate `description`.
3. `location` must resolve in the reviewed revision.
4. `type` must be in the vocabulary above.
5. An investigator that cannot fill `suspected_condition` must drop the claim
   rather than emit a vague one. Wide emission is cheap; unfalsifiable emission
   is not.
