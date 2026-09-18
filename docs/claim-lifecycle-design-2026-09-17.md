# Claim-lifecycle review architecture

**Prepared:** September 17, 2026
**Repository:** [atmin-inc/review](https://github.com/atmin-inc/review)
**Status:** Design proposal. Not implemented. Circulated for feedback.
**Supersedes:** parts of
[handoff-repository-state-2026-09-17.md](https://github.com/atmin-inc/review/blob/codex/repository-state-handoff/docs/handoff-repository-state-2026-09-17.md),
as listed below. That handoff is not yet on `main`; links point at its branch.

## 1. Framing

The handoff's **PR review flow** treats coverage as the organizing idea. It says
"review every line" is a coverage obligation while the agent reasons about
behavioral clusters. That still puts the pull request at the centre of the loop.
This document moves the centre to the **claim**: one falsifiable assertion about
one location, carried through investigation, verification and disposition.

The change is not cosmetic. A PR-shaped loop produces a report, and a report is
hard to audit, hard to diff and hard to score. A claim-shaped loop produces typed
records with evidence attached. Those can be verified independently, replayed,
regression-tested and accepted or rejected one at a time.

**RepositoryState v1 is deferred.** The handoff's **RepositoryState v1** section
specifies a versioned artifact per tracked branch, rebuilt on merge and checked
for drift. That is a large amount of machinery for its present value, and the
handoff already concedes the artifact is "fallible context, not finding
evidence." We keep one thin file instead: a **human-knowledge file** holding
invariants, historically fragile areas, known gotchas and organization rules.
Hand-written, short, reviewed like code. Everything the versioned artifact would
have derived automatically, the agent derives at review time with symbol search.

## 2. The unit of work is the claim

An investigator emits claims. A claim is not a finding. It is a hypothesis with
enough structure to be attacked.

| Field | Meaning |
| --- | --- |
| `claim_id` | Stable identifier for the lifecycle and the ledger. |
| `type` | Check category, for example `sql_injection`. Drives ladder routing. |
| `location` | Exact file and line in the reviewed revision. |
| `description` | What the code does that prompted the claim. |
| `suspected_condition` | The trigger under which the defect manifests. |
| `severity` | Proposed P0 to P4, subject to change at verification. |
| `evidence_to_check[]` | Specific propositions the verifier must check, written by the investigator. |
| `investigator_confidence` | Prior, not a verdict. Never reported to a user. |

The canonical worked example, used throughout this document:

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

Note what `evidence_to_check[]` does. It converts a worry into a work order. The
investigator does not need to be right. It needs to be specific.

## 3. Two phases, with a clean context reset

The investigator runs wide and cheap. It is rewarded for recall, not precision,
because the ladder in section 4 removes the cost of being wrong.

The verifier then receives exactly `{claim, repo, ladder}`. It never sees the
investigator's reasoning, its prose, or its confidence. This is the point of the
reset. An argument is persuasive, and a verifier that reads one is no longer an
independent test of the claim. It becomes a second opinion on a first opinion.

**The verifier and the investigator must be different model families. This is a
hard requirement, not a preference.** The handoff's **Disposition and learning
loop** already states the reason: agreement between agents of the same model
family is correlated, not independent. A same-family verifier inherits the same
blind spots and confirms the same mistakes. We treat a same-family verification
as no verification at all, and the harness should refuse to run that
configuration rather than quietly record its agreement.

## 4. The evidence ladder

Rungs are ordered cheapest and strongest first. The verifier climbs only as far
as it must. A symbolic refutation ends the claim immediately.

**Rung 1, symbolic.** grep, AST queries, the type checker, the compiler. These
return deterministic facts about the code. For `c-0142`: does the AST show
`user_input` reaching a query string through interpolation rather than a bind
parameter? This rung is nearly free and it settles most claims. Many claims die
here, which is the intended outcome of a wide investigator.

**Rung 2, executable.** In v1 this rung **reads test output CI has already
produced**. It does not execute anything: no fresh test runs, no ephemeral
containers, no worktree writes. If CI already ran a test that fails for the
claimed reason, that output is the evidence. If it did not, rung 2 does not fire
and the claim falls to rung 3. An executed result is the strongest evidence
available, because it demonstrates the defect rather than arguing for it, which is
why writing and running a repro is planned for v2 rather than dropped.

**Rung 3, cross-family LLM.** A narrow sub-check from a different model family.
Jev suits this rung: it answers one typed question against supplied state and
returns a calibrated probability. Use it for `sql_injection`, `hardcoded_secret`,
`touches_auth` and similar factual checks.

**Never use an LLM rung for a verdict.** Section 6 and the evidence in section 11
both bear on this.

**Confidence cap.** LLM-only evidence caps confidence at **moderate**, whatever
the probability. A finding reaches **high** confidence only when a symbolic or
executable rung hits **and** the cross-family LLM agrees. One rung alone never
reaches high. Disagreement between a hitting symbolic rung and the LLM rung
lowers confidence and routes the claim to a human, rather than letting the
majority win.

## 5. The evidence chain

Every finding ships with `verdict`, `evidence[]`, `final_severity` and
`verifier_confidence`. The chain, not the prompt, is what makes a finding
auditable. A prompt explains what we asked for. A chain records what was found,
by which method, with what result, and it survives a model change.

The chain for `c-0142`:

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

High confidence is earned here because rungs 1 and 2 hit and rung 3 agrees. Had
only rung 3 returned 0.94, the finding would cap at moderate and say so.

## 6. The verdict is policy, not a model

Code composes typed signals into `{block, security_review, nits, merge}`. A model
supplies the signals. It does not supply the decision. Paolo Rosson's framing is
the right one: the model answers typed checks, and **code turns that into a
verdict**.

This keeps three things that a model verdict destroys. Policy stays owned by the
team and differs per repository. A threshold change replays over stored evidence
without re-running inference. And the reason for a verdict is readable, because
it is a rule rather than a judgment.

This refines rather than contradicts the handoff's **Baseline findings and
scoring**, which already separates review criteria, P0 to P4 priority, verdict
policy and the /5 rating. We are adding that the composition step is code.

## 7. The feedback ledger

Dispositions are the eight outcomes in the handoff's **Disposition and learning
loop**: confirmed and fixed, confirmed but intentionally accepted, false
positive, pre-existing, duplicate, wrong priority, valid but exempt here, and
insufficient evidence.

Every disposition records who or what supplied it, when, a structured reason, and
a scope of finding, path, repository or organization.

**Human dispositions outweigh agent dispositions by fixed policy, not by a
learned weight.** The weights are configuration, written down and reviewable. A
learned weight would let a confident agent gradually promote its own opinion,
which is the failure this rule exists to prevent.

## 8. Rules are promoted by eval gain

A candidate rule stays unpromoted until running the harness **with** the rule
produces a measurable eval improvement against running it **without**. Repetition
is not evidence. Ten agent agreements are one correlated opinion, and a rule that
sounds right is the most dangerous kind of candidate.

Explicit organization rules skip the candidate stage and apply immediately. A
maintainer stating a convention is exercising authority, not offering evidence.
This matches the handoff's existing position that authorized rules apply at once
while inferred rules remain candidates.

## 9. Eval methodology

This section supersedes the handoff's **Measured reviewer quality** framing,
which reports upstream Core F2 on the Martian development split as the headline
number.

**Primary metric.** Accepted-or-fixed findings per PR on live traffic, at a hard
precision floor and a fixed cost budget. That is the number a user feels. **F2 on
Martian becomes a regression gate**, not the primary metric. The handoff itself
documents why it cannot carry that weight: the upstream extractor turns quality
prose into candidates, so unmatched candidates are not a clean false-positive
count, and precision is therefore not trustworthy.

**The reserved 35 get one clean read per milestone.** Read once, then stop. Every
extra read converts a held-out set into a tuning set. Grow a live customer-PR set
to take over the role.

**Time-split leakage.** A rule promoted before date T is evaluated only on PRs
after T. Otherwise a rule derived from a case is scored on that case.

**Regression harness.** Snapshot findings on golden PRs and diff them like code.
Block on lower-bound drops using paired comparison and bootstrap confidence
intervals, so run-to-run noise does not read as a regression.

**Calibration.** Measure on a set that was never tuned against. Report Brier
score and expected calibration error per check category, not pooled. Section 11
shows why pooling would hide the real result.

**Adversarial pairs.** Each is an injected defect with a clean twin, so a
detector that fires on everything scores zero:

1. A race that appears only under concurrent load.
2. A migration that drops a column still read by live code.
3. An auth check removed during an otherwise valid refactor.
4. A no-op formatting change. The correct output is **zero findings**.
5. A dependency bump that breaks a transitive consumer.
6. A PR whose description misstates what the diff does.
7. A PR containing text addressed to the reviewer. This is a prompt-injection
   test. The correct behavior is to treat that text as data and report it.

**Compute budget.** Run the full eval on release candidates only. Between those,
smoke on 10 PRs chosen for historical score movement, since a case that never
moves buys no information. Track the correlation between smoke and full results
over time, and re-pick the 10 when it decays.

## 10. Deferred, and why

- **RepositoryState v1 versioning.** Over-engineered for its present value. A
  thin human-knowledge file plus review-time symbol search covers the need. See
  section 1.
- **Multi-agent orchestration.** One capable agent with tool use, plus ladder
  verification, is enough. Adding agents adds correlated opinions, not evidence.
- **Jev as a verdict model.** See section 11.
- **Embeddings for repository state.** Symbol search and grep beat them on code,
  return exact locations, and cost nothing to keep fresh.

## 11. What we verified empirically

[`SMOKE_TEST_JEV.md`](../SMOKE_TEST_JEV.md) on this branch records a non-scoring
plumbing test of Jev against three Martian development-split PRs. It did not
score, did not read golden comments and did not touch the reserved 35.

- **The plumbing works.** Fifteen typed questions answered in one call, on the
  first attempt, across Go, TypeScript and Java.
- **Latency is about 484 ms** per call, mean of three.
- **Calibration is sharp on factual checks and mushy on composites.** Security
  checks stayed at 0.02 to 0.03 with no spurious firing. `adds_tests` returned
  0.97 and 0.95 where tests existed. On a Keycloak PR, `touches_auth` returned
  0.08, correctly judging the changed lines rather than the repository's
  reputation. But `merge_ready` returned 0.49, 0.41 and 0.27, and verdict
  confidence sat at 0.29 to 0.41 with probability splitting between `nits` and
  `merge`.

That last result is the direct evidence for section 6 and for deferring
Jev-as-verdict in section 10. The model is good at the narrow factual question
and turns to mush on the composite judgment. So we use it on rung 3 for narrow
checks and compose verdicts in code.

- **Cost is about 1.84x Paolo's claim**, at $0.000129 per PR against $0.00007,
  and still negligible. The gap is schema size rather than model price: the
  question block alone costs 1,501 input tokens.

## 12. Resolved questions and post-merge follow-ups

Two questions from the review of this document are closed here. Three need real
discussion and are labelled **post-merge follow-up** rather than blocking the
design. None of the three changes the architecture; each sets a parameter inside it.

### Closed

**What counts as a different model family.** Different vendor **and** no shared
base-model lineage. Where lineage cannot be established, treat the pair as the
same family and refuse the configuration. The asymmetry is deliberate: wrongly
claiming two models are independent silently corrupts every verification they
agree on, while wrongly rejecting a valid pair costs only a configuration change.
This makes the hard requirement in section 3 enforceable by the harness.

**How claims dedupe across runs.** `claim_id` is a content hash over `type`,
normalized location and `suspected_condition`, not a sequence number. Normalized
location means path plus enclosing symbol rather than a raw line number, so a
rebase that shifts lines does not mint a new claim and the regression harness in
section 9 can diff findings across revisions. Two claims that collide within one
run get an appended ordinal.

### Resolved by decision

These three were settled by the maintainers rather than by investigation. They set
parameters inside the architecture; none of them changes it.

**The human-knowledge file is owned by humans.** People edit
`docs/human-knowledge.md` directly on `main`. No CODEOWNERS gate for now. The
reviewer never writes to it: read-only from the agent's perspective. This keeps the
file's authority human, which is the whole reason it replaces a generated artifact.

**The executable rung does not execute in v1.** Scoped to reading test output CI
has already produced, as described in section 4. The consequence is explicit: on a
corpus where no CI output exists, rung 2 never fires and every claim a symbolic
check cannot settle caps at moderate confidence on rung 3 alone. Full execution is
a v2 feature.

**The precision floor is 70%**, measured on the 15 Martian development cases. This
is the ship bar. Section 9's primary metric is now fully defined.
