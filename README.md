# atmin review

Source code review with evidence, clear verdicts, and bounded model spending.
Run the CLI yourself or operate the included GitHub App worker. Experimental
alpha: model quality and severity calibration are still being measured.

## Install the alpha

Requires Node 24 or newer, Git, and an authenticated GitHub CLI (`gh auth login`).
Install the versioned release in a fresh directory:

```sh
npm install https://github.com/atmin-ca/review/releases/download/v0.1.0-alpha.1/atmin-review-0.1.0-alpha.1.tgz
npx atmin-review --help
cp node_modules/@atmin/review/profiles/smoke-openrouter-free.json ./review-profile.json
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

## GitHub App worker

The worker receives signed webhooks, stores jobs in SQLite, updates one bot
summary per PR, and publishes an `atmin review` check. Maintainers can comment
`/atmin review` to rerun. Use a dedicated host user; the pilot worker is not a
sandbox for executing repository code or an isolation boundary for many tenants.

Register an App with repository Contents read, Pull requests write and Checks
write. Subscribe to Pull request, Push and Issue comment events. Install it only
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
App and check name is not verification of the workflow's code. This alpha reads
CI at publication and explicit reconciliation; it does not subscribe to CI
completion events or poll after publication.

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
No hosted signup, billing, inline comments, or repository execution is included.

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
