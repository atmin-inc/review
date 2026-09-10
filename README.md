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
required validation checks; a PR cannot weaken its own policy:

```json
{"schemaVersion":1,"rubricVersion":"1","includeOptional":false,"requiredChecks":["change-validation"]}
```

## Hosted private pilot

The hosted dashboard at [review.atmin.ai](https://review.atmin.ai) is available
for repositories in the pilot's approved GitHub installation. It is not yet
open for public onboarding. The hosted service currently runs ahead of the
published npm and Homebrew alpha.

Repository administrators can sign in with GitHub, open **Repositories → Connect
repository**, and use **Manage GitHub access** to select another repository.
Return to the dashboard, refresh, and connect it. New connections start paused;
check the model and budget settings before enabling reviews.

Then open a pull request, or comment `/atmin review` on an existing open PR.
The App publishes its check and review summary in GitHub. The dashboard's
repository picker keeps each repository's settings and history separate, while
all connected repositories share the pilot's rolling 24-hour review limit.

## GitHub App worker

The current source adds automatic CI refresh and inline findings. These changes
are not yet in the npm/Homebrew `0.1.0-alpha.2` package; use a source checkout
to operate this worker until the next packaged release.

The worker receives signed webhooks, stores jobs in SQLite, updates one bot
summary per PR, and publishes an `atmin review` check. Maintainers can comment
`/atmin review` to rerun. Use a dedicated host user; the pilot worker is not a
sandbox for executing repository code or an isolation boundary for many tenants.

Register an App with repository Contents read, Pull requests write and Checks
write. Subscribe to Pull request, Push, Issue comment and Check run events. Install it only
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
using it. The worker queries GitHub on the exact reviewed head. Only a unique
completed success counts as a pass. Missing, skipped, ambiguous, cancelled or
unavailable checks remain unverified. A check on a different merge commit is
not automatically treated as evidence for the head.

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
