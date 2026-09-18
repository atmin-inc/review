# Spec: verdict policy

**Status:** Draft. DSL not chosen.
**Source:** [claim-lifecycle-design-2026-09-17.md](../docs/claim-lifecycle-design-2026-09-17.md), section 6.

Code composes typed signals into a verdict. A model supplies the signals. It does
not supply the decision. The smoke test in `SMOKE_TEST_JEV.md` is the evidence:
factual checks were sharp, composite judgments were not.

Verdict set, unchanged from the design doc: `block`, `security_review`, `nits`,
`merge`.

## Constraints on whatever DSL is chosen

The DSL is not picked. These constraints bound the choice.

1. **Total.** Every input maps to exactly one verdict. A fallback rule is
   mandatory.
2. **Ordered and first-match.** Rule order is the policy. No implicit precedence.
3. **Pure.** Reads stored findings only. No inference, no network, no clock.
4. **Replayable.** Changing a threshold must recompute verdicts over stored
   evidence without re-running inference. This is the main reason the composition
   step is code.
5. **Confidence-aware.** A rule must be able to require a confidence level. A
   `high`-confidence P1 and a `moderate`-confidence P1 should be separable.
6. **Explainable.** Output names the rule that fired. "Blocked by rule 1" beats a
   score.
7. **Per-repository, version-controlled, reviewed like code.**

## Sketch

Illustrative syntax only. Do not read this as a chosen language.

```
policy "balanced" {
  block            when any finding is P0 and confidence >= moderate
  block            when any finding is P1 and confidence == high
  security_review  when any finding has type in (injection_risk, auth_bypass, hardcoded_secret)
  security_review  when any finding is P1 and confidence == moderate
  nits             when count(findings where severity <= P2) >= 2
  nits             when any finding exists
  merge            otherwise
}
```

Read top to bottom, first match wins. Note that the design doc's verdict set has
no `warn`: a non-blocking advisory outcome is `nits`.

## Open

- Which DSL. A small declarative grammar, or a data-driven rule table.
- Whether a rule may reference the human-knowledge file, for example to suppress
  an accepted baseline risk. This risks making policy depend on advisory context.
- How a repository overrides an organization policy, and what an organization can
  mark non-overridable.
