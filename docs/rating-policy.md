# Repository rating policy

A rating is a subjective assessment of the whole change. Severity describes an
individual finding. Choosing a preset never hides a finding, changes its priority,
or authorizes a commit. Optional P4 suggestions and unavailable patches do not
independently lower a rating.

Configure `.atmin/review.json` on the PR's **target branch**. The engine captures
the policy and its digest with the review; a PR cannot weaken its own rules.
Omitting `rating` selects Balanced.

```json
{
  "schemaVersion": 1,
  "rubricVersion": "1",
  "includeOptional": true,
  "requiredChecks": ["change-validation"],
  "rating": { "preset": "balanced" }
}
```

Use the names of your repository's required checks, or `[]` when the repository
has no required CI checks. This does not waive the quality assessment of whether
verification is appropriate to the change. The hosted service must also
trust their GitHub App identities; naming a check does not make arbitrary CI
output trusted. A check may be not applicable when supported by review evidence.

## Presets

| Preset | What earns 5/5 |
| --- | --- |
| `balanced` (default) | Positive quality assessment, no P0–P2 defects, appropriate fit, justified complexity, appropriate verification, and required checks passed or not applicable |
| `correctness-first` | Completed, current review with no P0–P2 defects; P3/P4 and the subjective quality score do not lower it |
| `strict-conventions` | Balanced requirements plus no unresolved violations of documented conventions |

All presets require a completed review across every changed file and matching
current PR commits. Incomplete, superseded and freshness-unverified reviews are
**Not rated**, while known findings remain visible.

## Customize a perfect score

Add only the overrides you want. Unspecified values come from the preset.

```json
"rating": {
  "preset": "correctness-first",
  "perfectRequires": {
    "documentedConventions": true,
    "passingChecks": true,
    "noP3": true
  }
}
```

| Requirement | Meaning | Balanced | Correctness first | Strict conventions |
| --- | --- | :---: | :---: | :---: |
| `codebaseFit` | Fits the repository's architecture and established practices | true | false | true |
| `simplicity` | Added complexity is justified by the change | true | false | true |
| `verification` | Evidence is appropriate for the changed behavior and risk | true | false | true |
| `documentedConventions` | Follows explicit repository rules | false | false | true |
| `passingChecks` | Required checks pass or are not applicable | true | false | true |
| `noP3` | No unresolved minor defects | false | false | false |

These are **perfect-score requirements**, not weights or exclusions from review.
A supported concern in an enabled criterion caps the rating at **4/5**. An
unknown enabled criterion or missing required check result makes it **Not rated**.
A known failed required check caps it at 4/5. The GitHub check's existing
severity and validation rules remain independent: disabling `passingChecks`
can allow a rating even while the GitHub check fails for missing validation.
The report always shows both states.

For Balanced and Strict conventions, the model supplies a holistic score with a
concrete rationale. Turning off a perfect-score requirement removes its automatic
cap; it does not force the model to ignore a real problem when judging the change.
Correctness first starts at 5 and applies only defect caps and enabled overrides.

## Judgment and evidence

The model uses these anchors, rather than averaging dimension scores:

| Score | Judgment |
| --- | --- |
| 5 | Strong net-positive change, ready based on available evidence |
| 4 | Good change with a minor actionable concern |
| 3 | Useful direction with meaningful changes needed |
| 2 | Substantial problems undermine the change |
| 1 | Fundamentally unsafe or incorrect as written |

The controller caps any P0/P1 result at 1/5 and any P2 result at 3/5. These are
ceilings, not a conversion of priority into quality. A serious defect cannot be
averaged away by positive attributes. P0 and P1 remain individually labeled.

`record_quality` records a rationale, a proposed score, and separate judgments
for fit, simplicity, verification and documented conventions. Each assessed
criterion must cite controller-captured source reads; missing evidence is
`unknown`. No quality assessment means Balanced/Strict conventions are unrated,
even if no findings were reported.

A documented-convention concern must quote an explicit rule whose exact text
exists in the captured target branch, and cite source showing the violation.
The engine verifies the quote at recording and artifact reload. Whether the
quote actually establishes the claimed requirement remains a reviewer judgment.
Inferred style preferences alone must not lower the score. When there are no
explicit conventions, the reviewer should say so rather than invent requirements.

Verification is proportional to the change, not a test count. Source inspection
can assess whether existing tests cover a changed failure path or why a change
does not need tests. It cannot claim a test, typecheck or linter ran. Execution
status comes from the separate validation evidence. A stated preference to avoid
tests does not erase a concrete unresolved risk.

Markdown, CLI JSON, GitHub check summaries and the website detail projection use
the same controller-computed rating, resolved policy and rationale. A rating is
not a correctness probability or a GitHub approval. Tests of this policy verify
the workflow, not model judgment quality; model calibration requires benchmarks.
