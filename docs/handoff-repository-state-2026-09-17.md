# Handoff: repository-state review direction

**Prepared:** September 17, 2026  
**Repository:** [atmin-inc/review](https://github.com/atmin-inc/review)  
**Purpose:** Continue reviewer-quality work from the current public source and
evaluate versioned repository state as the next review-context improvement.

## Goal

atmin review is an open-source GitHub code reviewer with optional
atmin-operated compute. It should automatically review pull requests, publish
a clear advisory verdict and /5 whole-change rating, provide evidence for
P0–P4 findings, and offer bounded native GitHub suggestions for minimal fixes.
GitHub is the primary review surface. The hosted website is for setup,
configuration, history, usage and expanded evidence.

The next experiment is deliberately small:

1. Maintain a versioned description of each tracked target branch's current
   repository state.
2. Give one capable review agent the exact PR change, applicable repository
   state, organization/repository rules and source-navigation tools.
3. Separate candidate investigation from candidate verification.
4. Record structured accept, reject, fix and exemption feedback so repository
   review knowledge can improve over time.

Read [the full repository-state proposal](./repository-state-direction.md)
before changing the reviewer.

## Current public state

Public `main` at `5cdc68fc319af30819e46c061c5cddbfc82367b1`
contains:

- The TypeScript review engine and GitHub App worker.
- Immutable PR snapshot, policy, evidence, usage and report contracts.
- OpenAI/OpenRouter adapters and a local Codex adapter used by the benchmark.
- Discovery-first review phases and changed-hunk coverage.
- P0–P4 findings, deterministic verdicts and configurable /5 rating presets.
- Trusted CI reconciliation, inline findings and GitHub Apply suggestion
  support for bounded replacements.
- The public benchmark harness, 15-case development split, paired result and
  source audit.

Relevant documents:

- [Public README](../README.md)
- [Repository-state direction](./repository-state-direction.md)
- [Rating policy](./rating-policy.md)
- [Minimal GitHub fixes](./minimal-fixes.md)
- [Isolated checks](./isolated-checks.md)
- [Benchmark protocol](../benchmarks/README.md)
- [Review-quality research](../benchmarks/review-quality-research-2026-09-13.md)
- [Latest paired comparison](../benchmarks/paired-comparison-2026-09-14.md)
- [Source audit](../benchmarks/paired-audit-2026-09-14.md)

The standalone export at that commit passed 191 tests with one Linux-only skip.
Package verification built and installed the tarball and rendered a saved
review. The corresponding
[`change-validation` workflow](https://github.com/atmin-inc/review/actions/runs/35241835322)
passed.

## Measured reviewer quality

The latest frozen comparison evaluated 15 Martian development pull requests,
two repeats per reviewer and `gpt-5.6-sol` at medium effort through the same
repaired local adapter.

| Measure | Repaired r02-24 | Discovery-first r02-26 |
| --- | ---: | ---: |
| Core matches | 27/72 | 27/72 |
| Core recall | 37.5% | 37.5% |
| Upstream Core precision | 19.4% | 17.2% |
| Upstream Core F2 | 0.316 | 0.303 |
| Completed reviews | 24/30 | 29/30 |

Discovery-first improved completion and tail latency but did not improve
measured detection. The upstream extractor processes whole reports and can
turn quality or status prose into candidates, so unmatched candidates are not
a clean false-positive count. Preserve the raw result and add a separately
labeled structured-findings/source-adjudicated view.

The source audit found these recurring gaps:

- The reviewer reads nearby code but misses the actual dependency or
  initialization site.
- It assumes framework behavior instead of checking implementation evidence.
- It sometimes reports a risk already present in the base revision.
- It misses defects a narrow syntax, type or runtime check could decide.
- It can find a valid defect but propose an unsafe fix.
- It needs an explicit way to retract a candidate after counterevidence
  disproves it.

Thirty-five Martian cases remain reserved. Do not inspect or run them until a
candidate wins on the development split under a predeclared protocol.

## RepositoryState v1

Maintain an artifact for each tracked branch such as `main` or `prod`, tied
to an exact commit. It should describe:

- Repository purpose and major functionality.
- Subsystems, boundaries, entry points and dependencies.
- Important execution, data, authorization and persistence flows.
- Public and internal contracts and invariants.
- Established patterns and explicit conventions with source references.
- Applicable build, lint, typecheck and test commands.
- Deployment or branch-specific behavior.
- Known debt, intentional exceptions and accepted baseline risks.
- High-risk or historically fragile areas.

Build the first state from a full source exploration. Update affected sections
after a tracked-branch merge or push. Periodically rebuild from source to detect
drift.

Keep the first implementation plain: versioned JSON or Markdown plus source
references. Do not start with a graph database, vector database, agent fleet or
new service. Repository state is fallible context, not finding evidence. A
finding must still read and cite the exact reviewed source. If state for the
PR's exact base commit is unavailable, rebuild it or report stale/partial
context.

## PR review flow

Use one capable agent initially:

1. Resolve exact base, head, merge base and target-branch policy.
2. Enumerate every changed path and hunk.
3. Determine intended behavior and note conflicting or absent intent.
4. Group hunks into functional change clusters.
5. Select only repository-state sections relevant to each cluster.
6. Form failure hypotheses and trace callers, consumers, types, state, tests
   and configuration beyond the diff.
7. Record candidates with trigger, execution path, violated expectation,
   observable impact, introduced-or-worsened reasoning, priority and exact
   source evidence.
8. Enter a distinct verification phase. Try to disprove every candidate using
   counterevidence, base/head comparison and narrow deterministic checks when
   available. Withdraw unsupported candidates.
9. Compute changed-hunk coverage, limitations, validation, verdict and /5
   rating separately.

“Review every line” is a coverage obligation, not the reasoning strategy.
The controller accounts for every changed hunk while the agent reasons about
behavioral clusters and relevant dependencies.

## Baseline findings and scoring

A serious issue already present on the target branch is a baseline finding. It
does not automatically fail an unrelated PR. It may affect the PR verdict when
the change introduces it, worsens it, exposes it, depends on it unsafely or
makes remediation necessary for the changed behavior.

Keep these concepts separate:

- Review criteria: correctness, security, data integrity, contracts,
  conventions, verification and maintainability.
- P0–P4 priority: impact under a concrete trigger.
- Verdict policy: what produces Changes needed, Suggestions, No issues found,
  incomplete review or validation needed.
- /5 rating: subjective whole-change net-positive judgment under the selected
  repository preset.

A team can require convention compliance for 5/5 without mislabeling a
convention concern as P1.

## Disposition and learning loop

Support structured outcomes for each finding:

- Confirmed and fixed.
- Confirmed but intentionally accepted.
- False positive.
- Pre-existing.
- Duplicate.
- Wrong priority.
- Valid generally but exempt for this path or subsystem.
- Insufficient evidence or uncertain.

Store actor/provenance, reason, time, finding/evidence version and intended
scope: finding, path/subsystem, repository or organization. Free-text feedback
must not immediately rewrite global prompts. Explicit authorized rules can
apply immediately; inferred rules remain candidate learnings until repeated
evidence or maintainer promotion supports their scope.

Human confirmation, fix commits and executable evidence are stronger signals
than another agent's opinion. Treat agreement from agents using the same model
family as correlated rather than independent verification.

## Next implementation slice

1. Define a strict `RepositoryState v1` schema, freshness behavior, evidence
   references and update rules in the review system.
2. Build a local prototype for one development repository and update its state
   from one merge diff.
3. Select relevant state sections for a PR while retaining exact source
   verification.
4. Add an explicit candidate recheck and withdrawal operation.
5. Run a predeclared paired development experiment: current discovery-first
   versus the same model, agent and budget with repository state.
6. Track structured-finding recall, source-adjudicated precision, benign
   controls, completion, latency, input/cached tokens and state-build/update
   cost.
7. If state helps, add the smallest structured disposition ledger and CLI
   interface.
8. Test syntax/type/base-head execution later as a separate factor.

Repository state succeeds only if it repeatedly improves supported detections
or reduces unsupported findings without materially harming completion or cost.
A detailed summary alone is not a quality improvement.

## Durable constraints

- Write the product name as `atmin` in prose.
- Open-source and hosted operation use the same engine.
- GitHub remains the primary review flow.
- Reviews are advisory initially; no merge authority or automatic commits.
- Native GitHub suggestions remain the initial minimal-fix acceptance path.
- Severity, completion, validation, freshness, rating and lifecycle remain
  separate.
- Preserve immutable evidence and honest incomplete states.
- Do not optimize prompts for known benchmark answers.
- Do not inspect the 35 reserved cases prematurely.
- Keep changes small and review-owned. Avoid new dependencies and speculative
  infrastructure.

## Suggested skills

- **`ponytail:ponytail`** for the smallest implementation that can test the
  hypothesis.
- **`codebase-design`** for the RepositoryState contract and module boundary.
- **`domain-modeling`** for repository state, invariant, baseline finding,
  disposition and learned-rule terminology.
- **`tdd`** for version/freshness contracts, retraction and feedback scope.
- **`diagnosing-bugs`** for benchmark or adapter failures.

## How to begin

Read this handoff and the linked repository-state proposal. Inspect the public
source and current tests before proposing changes. State the smallest design
slice and its paired evaluation before implementing it. Do not begin by adding
a graph/vector database, multiple agents or a hosted service.
