# Spec: claim schema

**Status:** Draft. Implemented in `src/claim.ts` and `src/lifecycle.ts`.
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
| `evidence_to_check[]` | object[] | yes | The propositions the claim rests on, each paired with the check that settles it. At least one. See below. |
| `investigator_confidence` | number 0–1 | no | Prior. Never shown to a user, never used to rank findings, never combined with verifier confidence. |

## `claim_id` stability

Normalized `location` means path plus enclosing symbol, not a raw line number. A
rebase that shifts lines must not mint a new claim, or the regression harness
cannot diff findings across revisions. Two claims colliding within one run get an
appended ordinal.

## `evidence_to_check[]`

Each entry is `{ proposition, check? }`. The proposition is one thing that must
hold for the claim to follow; the check is the rung-1 assertion that settles
that one proposition, selected and parameterized from the closed catalogue.

A check names the side it asks about with `revision`: `head` by default, or
`base` for the merge base. Every review claim is a claim that this change
introduced something, so a claim about a removed guard or a new behaviour needs
a base-side proposition of its own. Without one it has not been attributed. The
2026-09-14 audit recorded misattribution as one of three recurring
false-positive mechanisms: `sms-retry-non-idempotent` was reported as a new
defect although every step of its trigger predated the change.

Keeping the two apart was a mistake worth naming, because the shape invites it.
A check establishes a *syntactic* fact — the text `owner !== account` does not
appear in this function body. A claim states a *semantic* one — any account can
update any record. The second does not follow from the first alone, and a claim
list that carries the propositions in one field and the checks in another lets a
single grep hit stand in for the whole argument.

So the verifier settles each proposition on its own and composes:

- any proposition shown false → the claim is **refuted**;
- every proposition established → **confirmed**, and only then is a later rung
  worth spending;
- anything left unsettled → **inconclusive**, naming the propositions that were
  not reached.

An incomplete argument is not a contested one. The answer to an unsettled
proposition is to check it, not to ask a person to adjudicate the steps that
were checked.

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
    { "proposition": "The interpolation is not sanitized upstream.",
      "check": { "assertion": "body_contains", "symbol": "fetch_orders", "pattern": "sanitize", "expect": "absent" } },
    { "proposition": "No parameterized binding is used.",
      "check": { "assertion": "body_contains", "symbol": "fetch_orders", "pattern": "execute(", "expect": "absent" } },
    { "proposition": "`user_input` is reachable from a user-controlled route.",
      "check": { "assertion": "referenced_outside", "symbol": "fetch_orders", "path": "orders.py" } }
  ],
  "investigator_confidence": 0.6
}
```

## Validation rules

1. `evidence_to_check` must be non-empty, and every entry must name a proposition.
2. `suspected_condition` must name a trigger, not restate `description`.
3. `location` must resolve in the reviewed revision.
4. `type` must be in the vocabulary above.
5. An investigator that cannot fill `suspected_condition` must drop the claim
   rather than emit a vague one. Wide emission is cheap; unfalsifiable emission
   is not.
6. A claim is confirmed only when every proposition is established. A
   proposition with no check, or whose check could not settle it, leaves the
   claim inconclusive rather than confirmed.
