# atmin review benchmark plan

**Status:** Updated September 14, 2026. The paired controller experiment finished
60 reviews: 15 frozen Martian development PRs × two versions × two repeats.
Both versions matched 27/72 Core annotation opportunities; discovery-first
completed 29/30 reviews versus 24/30 for the older controller, without an accuracy
win. See the [final comparison](paired-comparison-2026-09-14.md),
[source audit](paired-audit-2026-09-14.md), and [protocol](paired-review.md).
Two separately tested fixes address recovered CLI errors and rejected reads
incorrectly counting as coverage; they are excluded from these frozen results.
Thirty-five PRs remain reserved. Reviewed clean controls, broader repeat evidence
and a fresh hosted-competitor evaluation remain outstanding. The next paired
experiment, repository state as a single factor, has a
[predeclared protocol](repository-state-protocol.md) and has not run. The six-case smoke
harness and [live GitHub acceptance evidence](../deploy/live-acceptance-2026-09-11.md)
also exist.

The [testing plan](../docs/testing-plan.md) stages this protocol: six smoke
cases, a 30-case development corpus for the public CLI alpha, then the full
held-out evaluation for general availability. Alpha/beta publication does not
imply the broader numeric quality gates below have passed.

## Immediate roadmap: benchmark v0

Treat this as product development infrastructure, before further model or
review-engine tuning. The Martian comparison establishes the first recorded
baseline; the smoke harness supplies owned regression checks and cost receipts.
No competitor ranking has been established. The verified corpus below is a
separate track from the frozen Martian 15/35 development/reserved split.

1. **Define and curate 30 cases across 4–6 real open-source repositories.** Start
   with 15 historical regressions, five deliberately seeded defects and ten
   reviewed benign changes. Include nonempty clean improvements, already-fixed
   counterparts, and an empty-diff case. Cover supported TypeScript/JavaScript,
   Python and Go workloads without claiming comprehensive language coverage.
   Preserve licenses and provenance. Admit a historical case only after its
   actual introducing change and independent reproduction have been verified.
   Freeze split membership before tuning; keep related bug/fix variants together.
2. **Expand the local comparison runner and report.** The two-repeat controller
   comparison is complete. Next verify the reliability fixes and test defect
   verification changes on development cases with clean controls. Compare model
   configurations and a simple diff-only baseline as separate experiments. Keep model comparisons on one engine build, prompt, policy, context
   allowance and resource budget. Change one factor at a time. Repeat each
   configuration three times, retaining every attempt and its cost. Run the six
   smoke cases first to validate configuration before spending on the full set.
3. **Add live GitHub bot adapters.** Materialize identical base/head trees and
   neutral PR descriptions into separate benchmark-owned repository copies for
   each tool. Wait for indexing/readiness, trigger the bot, collect its complete
   review and comments, and enforce an observation deadline. Start with atmin,
   then CodeRabbit and Greptile using their supported installation flows. Keep
   each bot's prior comments and other bots' outputs out of a new trial. Use
   neutral case identities that do not disclose defect category or expected
   outcome. Record all infrastructure and hosted-plan limits.
4. **Make comparisons a release input.** For changes to the engine, prompt,
   model, retrieval or verification, report newly caught bugs, lost detections,
   new false alarms, incomplete runs, patch outcomes and cost/latency changes.
   Use small targeted regression runs during development and the frozen suite
   for release candidates. Do not automatically run paid suites on every code
   edit. Open-source the protocol and harness; publish frozen results and
   retired cases with the limitations needed to reproduce them.

The first 30 cases validate the process and expose gaps; they cannot establish
broad superiority. Expand only after case quality and adjudication are reliable.
The larger corpus below is an expansion proposal, not a prerequisite for v0.

## Two distinct comparison tracks

| Track | Held constant | Question answered |
|---|---|---|
| Engine/model regression | Frozen cases, engine version, prompts, policy, available context, budgets and grader | Does this specific atmin or model change improve results? |
| Hosted product comparison | Equivalent PR trees/descriptions, declared repository preferences, observation window and repeat protocol | What does a developer receive from each complete review bot? |

A hosted bot may use undisclosed models, indexing and compute. Record product
version when exposed, date, plan, settings, permissions and readiness; label
unknowns. Run hosted products close together with randomized order and an atmin
baseline in the same evaluation window. Publish default-configuration and any
aligned-policy track separately. Report a subscription's actual bill and its
allocation assumptions separately from metered inference cost; unavailable
per-review cost is unknown, not zero.

Every result must bind corpus/split and case hashes, original provenance,
materialized source-tree hashes, harness commit, model/provider identity,
prompt/tool/policy hashes, budgets, runtime image, scorer/rubric versions,
retry count, timestamps and raw review artifacts. For hosted engines, explicitly
record identities that cannot be pinned. Store immutable run artifacts with a
small index and generate a static comparison report before building a benchmark
website or introducing another service.

Report baseline-versus-candidate deltas with the actual changed cases, not just
one aggregate score. Distinguish completed valid detections from useful findings
salvaged from incomplete reviews. Include all attempts in operational metrics;
repeated trials must not become best-of-three cherry-picking. A known newly
missed serious defect warrants investigation even when the average improves.

## Replay integrity and grading extensions

Forking or mirroring real projects is the intended live-test mechanism. Renaming
a fork is only organization: it does not prevent recognition or memorization.
The controlled track exposes only the history needed to understand the proposed
change, never later fix commits, solution-bearing issue discussions, expected
labels or grader tests. Preserve genuine project instructions and attribution.
For hosted bots, disclose any external lookup/indexing access we cannot constrain.
Use fresh private held-out cases and prospective cases to complement public
historical bugs; keep them private only where source licensing permits it.

Keep hidden regression checks in the grader, separate from ordinary tests a
reviewer is permitted to inspect or run. Confirm the baseline passes, introducing
head fails for the intended reason, and reference fix passes. Where execution
cannot prove a defect, require a reviewed alternative oracle and label that
case separately. Invalid fixtures are infrastructure failures, handled the same
way for all configurations.

Extend defect metrics with two separate scorecards:

- **Patch quality:** proposal coverage, exact applicability, hidden regression
  success, preservation of existing behavior, and harmful-patch rate. Report
  successful fixes per eligible defect as well as per submitted patch, so an
  engine cannot win simply by rarely proposing a fix. A passing test alone does
  not establish semantic correctness.
- **Policy and rating behavior:** identical changes under explicit preset and
  convention requirements, appropriate abstention, serious-defect caps and
  relative judgments between buggy, corrected and benign variants. Use human
  consensus or acceptable ranges for subjective ratings; do not pretend every
  PR has one objectively correct /5 score. An empty diff should be distinguishable
  from a net-positive improvement. Grade these separately from bug detection.

A finding counts by the underlying defect, trigger and impact, regardless of
wording or whether a bot places it in a summary or inline. Measure useful
localization separately. Preserve severity disagreements as judgments to audit,
with acceptable severity ranges where appropriate. Candidate findings outside
the expected set require independent adjudication before being called false
positives. Version label corrections and rescore every contender consistently.

## What we need to establish

Does the reviewer find consequential defects across different codebases while
avoiding costly false alarms? How much do sandbox execution, repository context,
model choice, and verification improve the answer per dollar and minute?

Use external benchmarks for comparability and an atmin-owned corpus for
controlled experiments. Report them separately. A benchmark grade measures a
reviewer configuration; it is unrelated to the verdict shown on a customer's PR.

## External starting points

### First external run: Martian offline

Reuse the [upstream offline pipeline](https://github.com/withmartian/code-review-benchmark/tree/e616e849755441da38f18bf3adba2c9583b03803/offline)
at commit `e616e849755441da38f18bf3adba2c9583b03803` rather than rebuilding its
extraction, deduplication and semantic grading. The repository is MIT licensed.
Its fixed suite contains 50 PRs across Sentry, Grafana, Cal.com, Discourse and
Keycloak, with 173 golden comments. The default Core scoring profile includes
158 of those comments; keep the profile explicit in every comparison.

1. Inspect the pinned replay and collection scripts, then add the smallest atmin
   integration needed to collect both summary and inline findings. Use isolated
   benchmark-owned copies and explicit organization/tool arguments; upstream
   defaults refer to its own benchmark organization and existing tools.
2. Pilot three to five cases across different projects before scheduling all 50.
   Verify source trees, bot readiness, author filtering, completion detection and
   grading artifacts. Keep golden comments and judge inputs away from the review
   runtime. Budget review inference and extraction/deduplication/judging separately.
3. Run the complete frozen suite with fixed scoring and judge configurations.
   Preserve raw findings, retries, incomplete reviews, cost and timing. Report
   upstream-compatible scores separately from our audited interpretation of
   unexpected findings and operational failures.
4. Compare fresh competitor runs under the same evaluation protocol when their
   installations are available. Published historical results are context, not a
   current head-to-head result or official leaderboard entry for atmin.

This is the first external baseline, alongside the owned corpus above. Public
cases cannot serve as a fresh holdout. Keep benign-change false alarms, verified
fixes and repository-specific rating behavior as additional owned evaluations.
Defer the upstream online pipeline: observed developer reactions answer a
different question from a controlled comparison on identical PRs.

**Execution status:** one [local Discourse pilot](./martian-pilot-2026-09-11.md)
ran with r02-18 and DeepSeek for $0.066592355. It remained incomplete and missed
the expected issue. A [structured-reporting replay](./martian-reporting-2026-09-11.md)
with r02-19 also remained incomplete after the model returned disallowed source
calls during reporting and its correction request reached the deadline. Known
cost was $0.057771643, plus a retained $0.029674846 unsettled reservation.
The full suite and upstream grading pipeline have not run;
this pilot establishes a workflow gap, not a comparative quality result.

A [six-case reporting diagnostic](./reporting-probe-2026-09-11.md) then confirmed
that the default route can return the structured report on short inputs, with
or without one prior source call. Disabling parallel calls caused HTTP 404s;
the route also advertises no named-function support. Request controls remain
unchanged. r02-20 adds [private local traces](../docs/telemetry.md) for timing,
tool behavior and spending, viewable in Perfetto. The long-run failure still
needs a representative reporting-only reproduction before another full replay.

The [longer-history comparison](./reporting-history-2026-09-11.md) preserved 11
Discourse source reads in conversational and fresh-handoff forms. All six
45-second probes timed out. In one additional two-minute pair, conversation
history returned one valid report while the handoff returned three finish
calls with identical argument hashes. This does not justify replacing history;
duplicate reporting and latency remain separate reliability issues to address.

| Source | Useful property | Limitation |
|---|---|---|
| [Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark) | Open offline and online evaluation; offline set spans 50 PRs in five codebases | Public cases may be memorized; developer follow-up is an incomplete proxy for truth |
| [Greptile benchmark](https://www.greptile.com/benchmarks) | Published replay methodology using real defects across five repositories | Vendor-authored and dated 2025; historical rankings are not current atmin comparisons |
| [SWE-PRBench](https://arxiv.org/abs/2603.26130) | 350 PRs with annotated review ground truth and context ablations | Comment matching and context configurations differ from execution-based review |
| [SWE-Review-Bench](https://github.com/SWE-Lego/SWE-Review/blob/main/SWE-Review-Bench/README.md) | 1,384 generated PRs from 500 SWE-bench Verified issues; supports review/revision evaluation | Repair-derived distribution and revision success do not directly establish low-noise PR review |

Pin dataset commits, tools and scorer versions. Inspect overlap between
benchmark suites before aggregating; related PRs cannot count as independent
evidence twice. Do not present ordinary SWE-bench repair scores as code-review
accuracy or copy an external leaderboard into an atmin result.

## atmin-owned corpus

Begin with 30 manually curated cases to validate the harness. Expand to a
proposed 240-case first release corpus:

| Partition | Cases | Purpose |
|---|---:|---|
| Real defect-introducing changes | 120 | Reproduce genuine failure mechanisms with regression evidence |
| Manually designed seeded defects | 60 | Cover underrepresented risks and controlled counterexamples |
| Reviewed clean or benign changes | 60 | Measure false alarms and correct abstention |

Target at least 12 repositories across TypeScript/JavaScript, Python, Go,
Java, Rust, and Ruby, including applications, libraries, monorepos and services.
The first three languages form the initial supported release; the rest expose
coverage gaps before broader claims. Record repository/license, language,
domain, size, change size, runtime requirements, and toolchain image.

Cover authority/tenant isolation, injection and unsafe input handling, data
loss and transaction boundaries, concurrency/idempotency, API compatibility,
error recovery, resource leaks/performance, and UI/state behavior. Include
cross-file bugs and difficult negative examples such as valid compatibility
guards and intentional complexity. Keep style/simplicity evaluation separate
from defect detection. Synthetic defects supplement real cases; they do not
stand in for them.

For each defect case, record the repository revision before introduction, the
actual introducing change, the failing head, a fix, and a test or other
reviewed oracle. The reviewer sees the introducing change, not the later fix
PR. The oracle runs in a separate grader environment. Reject cases whose
failure cannot be attributed to the intended change or whose setup is broken.

Each case has expected root causes, severity, trigger, acceptable evidence and
anchor regions, not just a preferred comment sentence. Clean means clean
within the adjudicated scope, not universally bug-free. Newly discovered valid
bugs trigger adjudication and a versioned correction, not automatic FP labels.

Split approximately 50/25/25 into development, validation and held-out cases,
grouped by repository and defect family to avoid related-case leakage. Do not
tune prompts against the held-out split. Maintain a rotating prospective set
from opted-in projects to reduce exposure to memorized public changes.

Before evaluation, construct a minimal repository view containing the required
base history and proposed head, with no fix branches, labels, expected comments,
issue solutions or benchmark IDs in model-visible files. Disable external
search and unrestricted GitHub access for this track. Record residual training
contamination as a limitation. Keep grader credentials and expected results
outside the review sandbox and the investigation controller.

Publish retired test sets, manifests, harness, prompts and grading decisions.
An active holdout can remain sealed until its evaluation window closes. Private
customer cases never enter a public corpus without explicit authorization.

## Evaluation and adjudication

Normalize findings into root causes before scoring. Match a finding to an
expected defect only if its trigger and consequence identify that defect;
vague warnings about a file do not count. Use one-to-one matching within each
run: five comments about one bug earn one true positive. Report duplicate
burden separately so a spammy reviewer cannot look equally usable.

Use blinded human adjudication for the initial small corpus, all serious
findings, unmatched candidate findings, and scorer disagreements. Later use
a versioned LLM judge to suggest matches, with independent human audit and
measured agreement. Never let the reviewer be its own only judge. Executable
reproductions support an adjudication but do not validate every assertion in
a generated comment. Preserve disputed labels and report sensitivity.

| Metric | Definition |
|---|---|
| Precision | Matched valid unique findings / all adjudicated unique findings |
| Recall | Expected unique defects found / expected unique defects |
| Serious-defect recall | Recall for expected P0 and P1 defects under rubric v1 |
| Clean-change false-alarm rate | Adjudicated clean cases with a false actionable finding / clean cases |
| Noise burden | False findings and duplicate comments per reviewed PR |
| Completion rate | Completed reviews / all eligible attempted reviews |
| Cost | All attempt costs / completed reviews; also all costs / true findings |
| Latency | End-to-end p50/p95, plus queue, setup, inference and validation phases |

Zero-denominator precision or cost per true finding is undefined, not perfect
or free. Failed, timed-out and budget-exhausted reviews remain in the attempted
denominator; their missed expected defects remain misses in end-to-end recall.
Publish conditional-on-completion metrics only as an additional view. Fix
benchmark infrastructure errors consistently across all contenders rather
than selectively deleting poor outcomes.

Report counts, per-repository and per-language breakdowns, severity/category
breakdowns, macro averages across repositories, and micro totals. Repeat each
configuration at least three times and report variance; repeated runs on one
PR do not create new independent defect cases. Use paired repository-clustered
bootstrap intervals for comparisons and state when the small corpus gives
wide uncertainty. Never hide weak languages behind a global average.

## Experiments that choose the implementation

Compare a plain diff-only prompt, targeted repository context, and context
plus sandbox validation using the same pinned model, cases, policy and budget.
Then compare model tiers and targeted second-pass verification. Run a wider
budget track separately from the fixed-budget track; compare both quality and
cost rather than treating extra compute as an algorithmic improvement.

For sandbox providers, hold image/toolchain, review configuration and resource
request constant. Compare cold/warm setup, representative builds, test
completion, p95 wall time, effective cost, cleanup and isolation failures.
Provider capability failures are reportable outcomes. Record hardware and
architecture differences instead of calling unlike shapes identical.

Competitor comparisons require fresh authorized runs, recorded settings,
review date, pricing basis and comparable access to context. A hosted product
whose underlying model cannot be pinned gets that limitation explicitly.
Evaluate the full product and atmin engine separately when settings differ.

## Proposed gates

These are initial decision thresholds, not achieved results or marketing
claims. Freeze them before evaluating the release candidate.

- The deterministic safety suite must never classify partial, stale, failed or
  unverified evidence as passing, and must pass publication/billing race cases.
- On the held-out corpus, target at least 85% actionable precision, at least
  70% serious-defect recall, and at most 10% clean-change false alarms.
  Publish uncertainty and slice sample sizes; passing point estimates on a
  tiny sample is insufficient for broad quality claims.
- At a comparable budget, demonstrate a useful improvement over the diff-only
  baseline with paired uncertainty. Do not declare superiority from a tie.
- For the declared supported workload envelope, target at least 95% completion
  and p95 end-to-end time under 10 minutes. Large/toolchain-heavy repositories
  use separately declared limits and measured results.
- Any escape of credentials or cross-tenant isolation failure blocks hosted
  launch regardless of review quality. A sandbox failing cleanup cannot pass
  the provider qualification gate.

Every model, prompt, retrieval, policy and verification change reruns the
relevant regression cases. Full release evaluation runs against a frozen
candidate; record a release manifest linking results and costs to that build.
