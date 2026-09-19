# Versioned repository state for PR review

**Status:** **Deferred**, September 17, 2026. Kept for context and for the
problem statement below, which still holds.

The versioned per-branch artifact this document proposes is deferred as
over-engineered for its present value. The current direction replaces it with a
thin human-authored knowledge file plus review-time symbol search. See
[claim-lifecycle-design-2026-09-17.md](./claim-lifecycle-design-2026-09-17.md),
sections 1 and 10, and `docs/human-knowledge.template.md` for the replacement.

The source-audit gaps recorded below are not deferred. They are what the
claim lifecycle's evidence ladder exists to close.

## Why try this

The current reviewer can inspect an immutable PR diff and navigate repository
source. On the 15-PR Martian development split, separating discovery from
assessment improved completion but did not improve measured detection: both
the repaired r02-24 baseline and discovery-first r02-26 matched 27 of 72 Core
annotation opportunities across two repeats. The full result and its caveats
are in [the paired comparison](../benchmarks/paired-comparison-2026-09-14.md).

The source audit found recurring gaps:

- The reviewer inspected nearby code but missed the actual dependency or
  initialization site.
- It assumed framework behavior instead of checking the implementation.
- It sometimes reported a risk that was already present at the base revision.
- It missed defects that a narrow syntax, type or runtime check could decide.
- It lacked an explicit way to withdraw a candidate after finding
  counterevidence.

The next experiment gives the reviewer a compact, maintained model of the
repository before it investigates a PR. Start with a plain versioned artifact;
a graph or vector database must earn its cost in evaluation.

## RepositoryState v1

Maintain a repository-state artifact for each tracked branch such as `main`
or `prod`. Each artifact is tied to an exact commit and describes:

- Repository purpose and major user-visible behavior.
- Subsystems, boundaries, entry points and important dependencies.
- Execution, data, authorization and persistence flows.
- Public and internal contracts and invariants.
- Established patterns and explicit conventions, with source references.
- Applicable build, lint, typecheck and test commands.
- Deployment or branch-specific behavior.
- Known debt, intentional exceptions and accepted baseline risks.
- High-risk or historically fragile areas.

Build the first state through a full source exploration. After a merge or
tracked-branch push, update the affected sections from the previous state and
the exact branch diff. Periodically rebuild from source to detect accumulated
drift.

The artifact records repository, branch, source commit, generator/profile
version, creation time and freshness. Inferred facts and uncertainty remain
explicit. Every convention or invariant points to repository evidence.

Repository state is context, not proof. A published finding must still read
and cite the exact source at the reviewed base or head. If the PR's exact base
commit has no compatible state, rebuild or mark the context stale or partial;
never silently substitute a newer branch summary.

## Review flow

Use one capable agent initially:

1. Resolve the exact base, head, merge base and target-branch policy.
2. Enumerate every changed path and hunk, including deletions and unsupported
   paths.
3. Determine intended behavior from the PR, linked intent and code.
4. Group changed hunks into functional clusters.
5. Select only the repository-state sections relevant to each cluster.
6. Form plausible failure hypotheses and trace affected callers, consumers,
   types, state, tests and configuration.
7. Record candidates with a concrete trigger, path, violated expectation,
   observable impact, introduced-or-worsened reasoning, priority and exact
   source evidence.
8. Enter a distinct verification phase and try to disprove each candidate
   with counterevidence, base/head comparison and narrow deterministic checks
   when available. Withdraw unsupported candidates.
9. Compute changed-hunk coverage, limitations, validation, verdict and
   whole-change rating separately.

“Review every line” is a coverage obligation, not the reasoning strategy.
The controller accounts for every changed hunk while the agent investigates
behavioral clusters deeply enough to follow dependencies outside the diff.

A minimal trusted instruction is:

> Determine what this PR intends to change. Review every changed hunk and
> investigate the surrounding code required to understand its behavior.
> Compare the change against the repository state, applicable organization
> rules and established patterns. Identify only issues introduced or made
> materially worse by this PR. For every candidate, establish the triggering
> condition, execution path, violated expectation, observable impact, severity
> and supporting source evidence. Attempt to disprove each candidate before
> reporting it.

Multiple specialist agents are a later measured optimization. The first
prototype uses one continuous reviewer with controller-enforced investigation
and verification phases.

## Baseline findings

A serious issue discovered while building repository state is useful, but it
does not automatically fail an unrelated PR. Record it as a baseline finding.
It affects the PR verdict only when the change introduces it, worsens it,
exposes it, depends on it unsafely or makes remediation necessary for the
changed behavior.

Review criteria, finding priority and the /5 whole-change rating stay separate.
For example, a repository can require documented conventions for 5/5 without
mislabeling a convention concern as P1. The existing
[rating policy](./rating-policy.md) remains authoritative.

## Finding dispositions and learning

Users and authorized agents should be able to record structured dispositions:

- Confirmed and fixed.
- Confirmed but intentionally accepted.
- False positive.
- Pre-existing.
- Duplicate.
- Wrong priority.
- Valid generally but exempt for this path or subsystem.
- Insufficient evidence or uncertain.

Each disposition records actor/provenance, reason, time, finding/evidence
version and intended scope: finding, path/subsystem, repository or organization.
Free-text feedback does not immediately rewrite a global prompt. Explicit
authorized rules can apply immediately; inferred rules remain candidate
learnings until repeated evidence or maintainer promotion supports their scope.

Human confirmation, a fix commit and executable evidence are stronger learning
signals than another agent's opinion. If coding, reviewing and feedback agents
share a model family, treat their agreement as correlated rather than
independent verification.

## Acceptance experiment

Prove value locally before changing the hosted service:

1. Define a strict `RepositoryState v1` schema, evidence contract and
   freshness behavior.
2. Build state for one development repository and update it from one merge.
3. Select relevant state sections for a PR while requiring exact source reads
   for findings.
4. Add an explicit candidate recheck and withdrawal operation.
5. Compare current discovery-first against the same agent, model and budget
   with repository state.

Keep the 35 reserved Martian cases untouched. Track structured-finding recall,
source-adjudicated precision, benign controls, completion, latency, input and
cached tokens, plus state-build/update cost. Add syntax/type/base-head execution
as a separate later factor rather than bundling it with this experiment.

Repository state succeeds only if it repeatedly increases supported detections
or reduces unsupported findings without materially harming completion or cost.
A detailed summary by itself is not an improvement.
