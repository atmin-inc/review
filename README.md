# atmin review

Source code review with evidence, clear verdicts, and bounded model spending.
Run the CLI yourself or operate the included GitHub App worker. Experimental
alpha: model quality and severity calibration are still being measured.

## Install the alpha

### Homebrew

On macOS or Linux:

```sh
brew install atmin-inc/tap/atmin
gh auth login
cp "$(brew --prefix atmin-inc/tap/atmin)/share/atmin/profiles/smoke-openrouter-free.json" ./review-profile.json
```

Set `OPENROUTER_API_KEY` in your environment, then run:

```sh
atmin review https://github.com/OWNER/REPO/pull/123 \
  --profile ./review-profile.json --out ./private-review
```

Homebrew installs Node, Git and the GitHub CLI. The
[tap documentation](https://github.com/atmin-inc/homebrew-tap) also explains how
to coexist with another `atmin` installation. All commands below are available
through `atmin-review` and `atmin-review-github` without the `npx` prefix.

### npm

Requires Node 24 or newer, Git, and an authenticated GitHub CLI (`gh auth login`).
Install the versioned release in a fresh directory:

```sh
npm install @atmin.ai/review@0.1.0-alpha.2
npx atmin-review --help
cp node_modules/@atmin.ai/review/profiles/smoke-openrouter-free.json ./review-profile.json
```

Set `OPENROUTER_API_KEY` in your environment, then review a PR:

```sh
npx atmin-review review https://github.com/OWNER/REPO/pull/123 \
  --profile ./review-profile.json --out ./private-review
```

Replace the example URL with a repository you may access and send to the model
provider. The free profile enforces zero model pricing with no paid fallback;
availability and rate limits depend on the provider. The bundled paid DeepSeek
profile caps a run at $2; copying it is an explicit choice to use paid inference.
Direct OpenAI support uses `OPENAI_API_KEY` and an explicit profile.

`review` runs the claim pipeline described under [Current review direction](#current-review-direction)
below, the same run the GitHub worker publishes. Use `profiles/review-luna-openrouter.json`
(GPT-6 Luna through OpenRouter, capped at $2 a run, about $0.035 a run measured on benchmark
PRs). It is the measured `martian-luna-openrouter.json` with a larger input cap, so diffs up
to 512 KB fit with room to read; the benchmark profile keeps the cap it was measured with. Set `TYPESAFE_API_KEY` as well to turn on
the Jev rung, which is how it was measured; without it the report says the rung was off.
Confirmed findings the reviewer rated P3 are listed by location, not shown.

Each run captures immutable commits, reads changed files and relevant callers,
records anchored findings, and renders a report. It never executes repository
scripts. Keep snapshot directories private: they contain repository source.
Interrupted or partial reviews exit with status 2. Errors exit with status 1.

You can also prepare, investigate, render, and inspect costs separately:

```sh
npx atmin-review prepare https://github.com/OWNER/REPO/pull/123 --out ./private-review
npx atmin-review investigate ./private-review --profile ./review-profile.json
npx atmin-review render ./private-review --check-current
npx atmin-review cost ./private-review
```

A directory is investigated once, so previous spending reservations cannot be
lost by rerunning it. Create a new snapshot for a new review. `--check-current`
checks live commits; rendering without it explicitly leaves freshness unverified.

## Read the verdict

**No issues found** means the completed source review reported no visible
findings. Required validation is separate. It does not mean the code is perfect
or that tests passed. Incomplete or historical reviews never receive a clean
headline. A numerical average cannot cancel out a serious defect.

| Priority | Meaning | Default check behavior |
|---|---|---|
| P0 | Critical, immediate intervention | Changes needed |
| P1 | High-impact defect needing a prompt fix | Changes needed |
| P2 | Material defect that should be fixed | Changes needed |
| P3 | Minor defect with limited impact | Non-blocking suggestion |
| P4 | Optional improvement | Hidden by default; non-blocking |

Priority depends on a concrete trigger, impact, reachability and counterevidence.
Findings cite immutable source. A model's reasoning is not proof of execution.
The target commit's `.atmin/review.json` may enable optional suggestions and name
required validation checks; a PR cannot weaken its own policy. Without the file no
check is required, and the `atmin review` check reflects the review alone:

```json
{"schemaVersion":1,"rubricVersion":"1","includeOptional":false,"requiredChecks":["change-validation"]}
```

## GitHub App worker

The current source adds automatic CI refresh and inline findings. These changes
are not yet in the npm/Homebrew `0.1.0-alpha.2` package; use a source checkout
to operate this worker until the next packaged release.

The worker receives signed webhooks, stores jobs in SQLite, updates one bot
summary per PR, and publishes an `atmin review` check. Each review is a claim-pipeline run
(see `review` above); point `profile` at `profiles/review-luna-openrouter.json` and set
`OPENROUTER_API_KEY` and, for the Jev rung, `TYPESAFE_API_KEY`. The first review of a PR
reads the whole change. Each later push is reviewed incrementally: only the commits since
the last completed review are read for new findings, and that review's findings are
re-checked against the new head. A force-push or a merge from the target branch gets a full
review. Automatic reviews pause after five reviewed heads of one PR; comment
`/atmin review` for a full review, which also restarts the count. Reviews are bounded by
`maxReviewsPerDay`. Diffs over 512 KB are not reviewed. Maintainers can comment
`/atmin review` to rerun. Use a dedicated host user. Source review does not execute repository code.
Optional [isolated checks](docs/isolated-checks.md) run selected commands and
verify proposed patches on a configured Linux worker. This private pilot is not
a hardened isolation boundary for many tenants.

Register an App with repository Contents read, Issues read, Pull requests write and
Checks write. Issues read is what makes GitHub offer the Issue comment event, which carries
`/atmin review`. Subscribe to Pull request, Push, Issue comment and Check run events. Install it only
on the intended repository. Set its webhook to your HTTPS proxy's
`/webhooks/github`, forwarding to the worker on loopback port 8787.

Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`
(at least 32 bytes), and the selected model credential. Put actual repository
and installation IDs in a local configuration:

```json
{
  "repository":"OWNER/REPO",
  "repositoryId":123,
  "installationId":456,
  "profile":"./review-profile.json",
  "stateDirectory":"./private-worker-state",
  "host":"127.0.0.1",
  "port":8787,
  "maxReviewsPerDay":6,
  "trustedChecks":[{"name":"change-validation","appId":15368}]
}
```

`trustedChecks` is optional. Use the actual check name and producer App ID you
trust; check names must match the target policy's required checks. App 15368 is
an illustrative configuration; verify the producer in your repository before
using it. The worker queries GitHub on the exact reviewed head. CI that runs on
both push and pull_request leaves one run per event there; a pass needs every run
of the check from that App completed and successful, and any failed run fails it.
Missing, skipped, cancelled, still-running or unavailable checks remain unverified. A check on a different merge commit is
not automatically treated as evidence for the head. The review does not wait for CI: while
unverified required checks are all that stand between a clean review and a pass, the
`atmin review` check stays pending (in progress) instead of failing, and a required check
that never passes keeps it pending.

Protect CI workflow changes according to your repository's policy: trusting an
App and check name is not verification of the workflow's code. Trusted Check run
creation and completion events refresh the saved report and check, including
events arriving during publication. Events are only wakeups: results are fetched
from GitHub again. Stale commits, unrelated checks and duplicate deliveries do
not start reviews. There is no background polling; use explicit reconciliation
if GitHub cannot deliver an event.

Findings also appear in one commit-bound advisory review per run, with up to 20
inline comments. Only anchors present in GitHub's diff are attached; the summary
retains every visible finding. Optional P4 findings follow target-branch policy.
CI refreshes reuse the batch; an explicit model rerun creates a new review run.
Unknown publication outcomes require reconciliation and never blindly repeat a
POST. Historical inline findings retain their original commits and run identity.

```sh
npx atmin-review-github check ./pilot.json
npx atmin-review-github serve ./pilot.json
# In another terminal; a new worker starts paused:
npx atmin-review-github enable ./pilot.json
npx atmin-review-github status ./pilot.json
npx atmin-review-github reconcile ./pilot.json 123
npx atmin-review-github pause ./pilot.json
```

Reconciliation refreshes the saved report and CI without new inference. Pausing
cancels active work. Failed and cancelled starts count toward the rolling daily
limit. Stop the service before backups; retain the database and spending receipts.
Provide snapshot retention and disk limits before widening access. Capture
fetches repository history, so large repositories can exceed the pilot's capacity.
No hosted signup, billing, or repository execution is included.

With `REVIEW_DASHBOARD_CONFIG` pointing at a JSON file (`origin`, `clientId`, `models`,
and optionally `operators` and `appSlug`) and `GITHUB_OAUTH_CLIENT_SECRET` set, `serve`
also hosts the dashboard API. Repository administrators sign in with GitHub, connect
up to ten repositories in total, and pause or configure each one. `operators` lists
GitHub user IDs, not logins, because a login can be renamed and taken by someone else.
An operator sees every installation of the App they can access and approves one by
connecting its first repository. Everyone else sees only approved installations. With
`appSlug` set, the dashboard offers the App's install link; set the App's Setup URL to
the dashboard origin so GitHub returns people there after installing.

## Develop

```sh
npm ci
npm test
node packaging/verify.mjs
```

Tests use local repositories, fake provider responses and temporary databases;
they do not consume model credits or establish model quality. Package verification
installs the actual tarball in a clean directory and exercises both CLI entry
points and snapshot rendering. Apache-2.0; see LICENSE and NOTICE.

## Rating presets (current source)

Set `rating` inside target-branch `.atmin/review.json`:

```json
{
  "schemaVersion": 1,
  "rubricVersion": "1",
  "includeOptional": true,
  "requiredChecks": ["change-validation"],
  "rating": {
    "preset": "strict-conventions",
    "perfectRequires": { "noP3": true }
  }
}
```

Presets: `balanced` (default: fit, simplicity, appropriate verification and required
checks), `correctness-first` (5/5 for a complete current review without P0–P2), and
`strict-conventions` (Balanced plus documented rules). Overrides are booleans:
`codebaseFit`, `simplicity`, `verification`, `documentedConventions`, `passingChecks`,
`noP3`. A concern in a required criterion caps the score at 4; an assessed criterion
left unknown makes it unrated. P0/P1 cap at 1 and P2 at 3. A review with no quality
assessment, which is every claim-pipeline review, is scored by its findings alone, so a
clean one earns 5/5. Missing required check results are noted and do not withhold the
score; a failed one caps it at 4. No average, test-count quota,
or automatic penalty for optional P4 suggestions or unavailable patches.

Ratings are subjective and independent from finding severity and GitHub check
conclusions. An incomplete or stale review cannot be rated. Repository policy is
captured from the target branch; a PR cannot relax its own rules. These additions
are available in current source and await the next versioned package release.

## Current review direction

The current design centres review on the **claim**: one falsifiable assertion
about one location, carried through investigation, verification and disposition.
Read the [claim-lifecycle design](docs/claim-lifecycle-design-2026-09-17.md) for
the claim schema, the ordered evidence ladder and the eval methodology.

The earlier [repository-state direction](docs/repository-state-direction.md)
stays published for context. Its versioned per-branch artifact is deferred by the
claim-lifecycle design in favour of a thin human-knowledge file, and one review
agent with separate investigation and verification phases carries forward. Both
are proposals, not claims about the current engine.

That lifecycle now runs end to end:

```sh
npx atmin-review claim-review https://github.com/OWNER/REPO/pull/123 \
  --profile ./review-profile.json
```

A wide pass emits falsifiable claims, a separate pass settles each claim's
propositions against the frozen revision with none of the first pass's reasoning
in scope, and the verdict is composed from what survived. The report shows the
claims that died alongside the findings that lived: emitting widely is only
trustworthy when the discarding is visible. It accepts a prepared snapshot
directory in place of a URL, and writes `claims.json` and `verification.json`
beside the snapshot.

Whether a rung earns its place is a measurement, not an assumption:

```sh
npx atmin-review claim-ablate ./private-review --rung cross_family_llm
npx atmin-review claim-ablate ./private-review --rung symbolic
```

That re-verifies a finished run with one rung switched off, replaying recorded
model answers on both sides, so the difference between the two is that rung and
nothing else. It spends nothing and changes nothing. The report
counts what the rung added, what it took away, what it raised and what it called
into question, because a rung that only removes findings is still earning its
place when those findings were wrong.

Two limits are current, not permanent. The cross-family rung does not run, so no
claim reaches high confidence through agreement, and the report says so. Rung 1
knows three assertions — what a declaration contains, what a body contains, and
whether a symbol is referenced outside a file — each askable of the head or the
merge base.

The specs a v1 implementation targets are the [claim schema](spec/claim-schema.md),
the [evidence chain](spec/evidence-chain.md) and the
[verdict policy constraints](spec/verdict-policy.md). The
[regression harness layout](harness/README.md) and the
[pre-registered paired benchmark](bench/PLAN.md) describe how it gets measured.
Ship bar: 70% precision on the 15 Martian development cases.
