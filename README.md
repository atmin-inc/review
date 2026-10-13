# atmin review

Pull request review with evidence, deterministic verdicts and bounded model spending.
Run it from the command line, or operate the included GitHub App service.

atmin review is an experimental alpha. Model quality and severity calibration are still
being measured; [docs/research-log.md](docs/research-log.md) records what has been.

## How it works

Every review starts from an immutable snapshot of the PR: its head, its merge base and
the diff. Repository code is never executed during review.

1. A model reads the change through bounded tools and records **claims**: falsifiable
   assertions about one location each, with the propositions that would test them.
2. A separate verification pass settles each proposition against the frozen revision,
   with none of the first pass's reasoning in scope: first by deterministic search, then,
   optionally, by a second model family asked one proposition at a time.
3. Code, not a model, composes the verdict from what survived. The report shows the claims
   that died beside the findings that lived.

Every model call reserves its worst-case price against the profile's budget before it
runs, and a cost that is not yet known is reported as unsettled, never as zero.

## Install

### Homebrew

On macOS or Linux:

```sh
brew install atmin-inc/tap/atmin-review
gh auth login
cp "$(brew --prefix atmin-inc/tap/atmin-review)/share/atmin-review/profiles/smoke-openrouter-free.json" ./review-profile.json
```

Homebrew installs Node, Git, the GitHub CLI and the `atmin` command. `atmin <tool>` runs
the installed `atmin-<tool>` executable, so `atmin review …` runs `atmin-review` and
`atmin code-review-runner …` runs the review runner. If you installed the older
`atmin-inc/tap/atmin` formula, run `brew uninstall atmin` first. If Homebrew refuses to
load a formula from an untrusted tap, run `brew trust atmin-inc/tap` and install again.

### npm

Requires Node 24 or newer, Git, and an authenticated GitHub CLI (`gh auth login`).

```sh
npm install @atmin.ai/review@0.1.0-alpha.4
npx atmin-review --help
cp node_modules/@atmin.ai/review/profiles/smoke-openrouter-free.json ./review-profile.json
```

## Review a pull request

Set `OPENROUTER_API_KEY`, then:

```sh
atmin review https://github.com/OWNER/REPO/pull/123 \
  --profile ./review-profile.json --out ./private-review
```

With npm, run `npx atmin-review review` with the same arguments. Use a repository you may
access and may send to the model provider. Snapshot directories contain repository
source; keep them private.

A profile names the model and the run's limits. The npm package and the Homebrew
formula include three; the others are in this repository's `profiles/` directory.

| Profile | Model | Spending |
|---|---|---|
| `smoke-openrouter-free.json` | a free OpenRouter model | Zero-priced only, no paid fallback; availability and rate limits depend on the provider |
| `baseline-deepseek.json` | DeepSeek V3.2 on OpenRouter | Paid, capped at $2 a run |
| `smoke-openai.json` | GPT-5.4 on OpenAI, with `OPENAI_API_KEY` | Paid, capped at $2 a run |
| `review-luna-openrouter.json` (repository) | GPT-6 Luna on OpenRouter | Paid, capped at $2 a run; about $0.035 a run on benchmark PRs |
| `review-luna-openai.json` (repository) | GPT-6 Luna on OpenAI, with `OPENAI_API_KEY` | Paid, capped at $2 a run; not yet measured on real reviews |

`review-luna-openrouter.json` is what the GitHub worker runs and what the benchmark
numbers describe. It is the measured `martian-luna-openrouter.json` with a larger input
cap, so diffs up to 512 KB fit with room to read. Set `TYPESAFE_API_KEY` as well to turn
on the cross-family rung (Jev), as it was measured; without it the report says the rung
was off. The OpenAI profile prices calls from OpenAI's reported usage, including prompt
tokens written to the cache and the higher rate for prompts over 272K tokens.

Confirmed findings the reviewer rated P3 are listed by location, not shown;
`claim-review --show-minor` shows them. Interrupted or partial reviews exit with status
2; errors exit with status 1.

### Step by step

```sh
npx atmin-review prepare https://github.com/OWNER/REPO/pull/123 --out ./private-review
npx atmin-review claim-review ./private-review --profile ./review-profile.json --cross-family jev
npx atmin-review claim-ablate ./private-review --rung cross_family_llm
```

`prepare` captures the snapshot. `claim-review` runs the claim pipeline on it (or on a PR
URL) and writes `claims.json` and `verification.json` beside the snapshot;
`--cross-family jev` turns on the Jev rung. `claim-ablate` re-verifies a finished run with
one rung switched off, replaying the recorded model answers on both sides, and reports
what that rung added, removed, raised and called into question. It spends nothing.

The older single-pass engine is still available on a prepared directory:

```sh
npx atmin-review investigate ./private-review --profile ./review-profile.json
npx atmin-review render ./private-review --check-current
npx atmin-review cost ./private-review
```

A directory is investigated once, so earlier spending reservations cannot be lost by
rerunning it; create a new snapshot for a new review. `--check-current` checks the live
commits; without it the report says freshness is unverified.

### On your own machine and subscription

`atmin code-review-runner` reviews the PRs you author with the Claude Code CLI you are
signed in to, for a repository whose administrator turned on "Members' own runners":

```sh
atmin code-review-runner login
atmin code-review-runner setup
atmin code-review-runner
```

## Read the verdict

**No issues found** means the completed source review reported no visible findings. It
does not mean the code is perfect or that tests passed; required validation is separate.
Incomplete or historical reviews never receive a clean headline, and no average can
cancel out a serious defect.

| Priority | Meaning | Default check behavior |
|---|---|---|
| P0 | Critical, immediate intervention | Changes needed |
| P1 | High-impact defect needing a prompt fix | Changes needed |
| P2 | Material defect that should be fixed | Changes needed |
| P3 | Minor defect with limited impact | Non-blocking suggestion |
| P4 | Optional improvement | Hidden by default; non-blocking |

Priority depends on a concrete trigger, impact, reachability and counterevidence.
Findings cite immutable source. A model's reasoning is not proof of execution.

### Repository policy

The target branch's `.atmin/review.json` may enable optional suggestions, name required
validation checks and choose a rating preset. A PR cannot weaken its own policy: the file
is always read from the target branch. Without the file no check is required, and the
`atmin review` check reflects the review alone.

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

Rating presets: `balanced` (the default: fit, simplicity, appropriate verification and
required checks), `correctness-first` (5/5 for a complete, current review without P0–P2)
and `strict-conventions` (balanced plus documented rules). Overrides are booleans:
`codebaseFit`, `simplicity`, `verification`, `documentedConventions`, `passingChecks`,
`noP3`.

A concern in a required criterion caps the score at 4; an assessed criterion left unknown
makes it unrated. P0 and P1 cap the score at 1 and P2 at 3. A review with no quality
assessment, which is every claim-pipeline review, is scored by its findings alone, so a
clean one earns 5/5. A missing required check result is noted and does not withhold the
score; a failed one caps it at 4. There is no average, test-count quota or automatic
penalty for optional P4 suggestions. Ratings are independent of finding severity and of
the GitHub check conclusion, and an incomplete or stale review is not rated.

## Run the GitHub App service

`atmin-review-github` receives signed webhooks, stores jobs in SQLite, keeps one bot
summary per PR and publishes an `atmin review` check. Each review is a claim-pipeline
run. Use a dedicated host user. [deploy/](deploy/README.md) has the setup the maintainers'
hosted service uses.

### Set up the App

Register a GitHub App with repository Contents read, Issues read, Pull requests write and
Checks write. Issues read is what makes GitHub offer the Issue comment event, which
carries `/atmin review`. Subscribe to Pull request, Push, Issue comment, Pull request
review comment and Check run events. Install it only on the intended repository, and set
its webhook to your HTTPS proxy's `/webhooks/github`, forwarding to the worker on
loopback port 8787.

Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET` (at least 32
bytes) and the model credentials: `OPENROUTER_API_KEY` and, for the Jev rung,
`TYPESAFE_API_KEY`. Put the repository and installation IDs in a local configuration:

```json
{
  "repository": "OWNER/REPO",
  "repositoryId": 123,
  "installationId": 456,
  "profile": "./profiles/review-luna-openrouter.json",
  "stateDirectory": "./private-worker-state",
  "host": "127.0.0.1",
  "port": 8787,
  "maxReviewsPerDay": 6,
  "trustedChecks": [{ "name": "change-validation", "appId": 15368 }]
}
```

`trustedChecks`, `localChecks`, `minFreeDiskMb` and `maxInstallationDiskMb` are optional.

```sh
npx atmin-review-github check ./pilot.json
npx atmin-review-github serve ./pilot.json
# In another terminal; a new worker starts paused:
npx atmin-review-github enable ./pilot.json
npx atmin-review-github status ./pilot.json
npx atmin-review-github reconcile ./pilot.json 123
npx atmin-review-github pause ./pilot.json
```

Reconciliation refreshes the saved report and CI results without new inference. Pausing
cancels active work. Failed and cancelled starts count toward the rolling daily limit.
Stop the service before backups, and keep the database and spending receipts.

### What triggers a review

- The first review of a PR reads the whole change. Each later push is reviewed
  incrementally: only the commits since the last completed review are read for new
  findings, and that review's findings are re-checked against the new head. A force-push
  or a merge from the target branch gets a full review. A push to the target branch
  itself starts nothing.
- Automatic reviews pause after five reviewed heads of one PR. Comment `/atmin review` (or
  `@atmin review`) for a full review, which also restarts the count. A repository's
  settings can turn automatic reviews off, so that only that comment starts a review.
- Reviews are bounded by `maxReviewsPerDay`.
- A maintainer accepts a finding that needs no change by replying `/atmin accept` under
  its inline comment, or accepts every finding of the latest review by commenting
  `/atmin accept` on the PR. Accepted findings leave the summary and the check without
  another model call.

### What a review reads

A deleted file is read as its deletion (its old content stays readable through the source
tools). Lock files are left out; they and binary files are listed as not reviewed and do
not hold the rating open.

A diff over 512 KB is reviewed in parts of 256 KB, files kept in path order (a file whose
own diff is bigger gets a part to itself). The parts are investigated side by side, all
findings are verified together, and the parts share the review's one budget (`maxUsd`, $2
by default), which covers one part per $0.15: 13 parts at $2. Past what the budget
covers, or for a file whose own diff is over 512 KB, files are left out: deleted files are
read first, then source files before tests, docs and generated files, smallest first. The
rest are listed as not reviewed, the review is incomplete, and the next push gets a full
review. When no file's part of the diff fits on its own, the PR gets a "review not run"
comment, and the review is neither counted nor charged.

A failed review's comment and the service log name the phase that failed and its cause:
one of atmin's own messages about its limits or input, or else only the error's kind, so
no source or provider text is shown.

### CI checks

`trustedChecks` names the CI checks and producer App IDs you trust; check names must
match the target policy's `requiredChecks`. App 15368 is illustrative; verify the
producer in your repository before using it. The worker queries GitHub on the exact
reviewed head. A pass needs every run of the check from that App completed and
successful, and any failed run fails it. Missing, skipped, cancelled, running or
unavailable checks remain unverified, and a check on a different merge commit is not
evidence for the head.

The review does not wait for CI. While unverified required checks are all that stand
between a clean review and a pass, the `atmin review` check stays pending instead of
failing. Trusted check run events refresh the saved report and check; events are only
wake-ups, and results are fetched from GitHub again. Stale commits, unrelated checks and
duplicate deliveries do not start reviews. There is no background polling; use
`reconcile` if GitHub cannot deliver an event. Trusting an App and check name does not
verify the workflow's code, so protect CI workflow changes according to your
repository's policy.

[Isolated checks](docs/isolated-checks.md) can run operator-configured commands on the
captured head and on proposed patches, on a Linux worker with Bubblewrap.

### Inline findings and outcomes

Findings also appear in one commit-bound advisory review per run, with up to 20 inline
comments, each posted once per PR. Only anchors present in GitHub's diff are attached;
the summary keeps every visible finding. CI refreshes reuse the batch; an explicit rerun
creates a new review run. An unknown publication outcome requires reconciliation and
never blindly repeats a POST.

When a PR closes, the worker records what became of each finding its completed reviews
published. `changed` means the flagged line or a line next to it was edited or removed by
the PR's last head; `unchanged` means those three lines are still in the file, ignoring
indentation, wherever they moved. An unrelated edit to the same lines also counts as
changed, so the changed share is an upper bound on findings acted on. The worker also
records whether the PR merged, and the reactions and human replies on each inline comment
(found through a hidden `<!-- atmin-finding:... -->` marker; comments posted before
2026-09-30 have none). Resolved conversations are not read. A read that fails is recorded
as `unknown` with its cause. `/admin` shows the totals per repository.

### Storage and isolation

Each connected repository has its own state directory, database and shared copy of its
history (`source-cache.git`); each run's snapshot borrows that copy and is deleted when
the run ends, while the JSON records stay.

- A repository over 2 GB on GitHub does not connect.
- No review starts while the state disk has less than `minFreeDiskMb` (default 2048) free.
- A shared copy over 3 GB is wiped before the next capture.
- A runner's copy of a repository is deleted after 24 hours without a review of it.
- Run records older than 90 days are deleted, except each PR's latest completed review.
- Each organization's run records and shared copies together are held to
  `maxInstallationDiskMb` (default 5120), checked before each review, so one review can go
  past it. Over the limit, the organization's shared copies are wiped first; if its run
  records alone are still over, the review does not start and the PR comment says why.

On the hosted runners every review step (capture, investigation, checks) runs in a
Bubblewrap sandbox that mounts only the system, the release's code, that run's directory
and that one repository's copy, so a step broken by a hostile repository cannot read
another organization's code. The release script refuses to deploy if the sandbox cannot
start. Root on the host can still read code while a review runs, and the model provider
receives the code it reviews: Luna is sent only to OpenRouter's zero-data-retention
route. A member's own runner runs on their machine without this sandbox. The service is
not a hardened isolation boundary between tenants.

### Dashboard

With `REVIEW_DASHBOARD_CONFIG` pointing at a JSON file (`origin`, `clientId`, `models`,
and optionally `operators` and `appSlug`) and `GITHUB_OAUTH_CLIENT_SECRET` set, `serve`
also hosts the dashboard: the API, and the pages `npm run build:web` builds into
`web/dist` from a source checkout (pages answer 503 until that build exists). With
`appSlug` set, the dashboard offers the App's install link; set the App's Setup URL to the
dashboard origin so GitHub returns people there after installing.

Anyone can install the App and sign in with GitHub. Repository administrators connect up
to ten repositories per installation and pause or configure each one. Each installation
has a monthly plan: 20 free reviews per UTC calendar month by default. A review counts
once inference starts, failed runs included. A review cancelled before it finished (by a
newer commit or a pause), or one that asked no model because it had nothing new to read,
is neither counted nor charged. A `/atmin review` comment while a full review of the PR is
already running is ignored. Past the limit the PR gets a "review not run" comment with
the reason and no model call is made. `maxReviewsPerDay` still applies to all
installations together.

### Billing

With `STRIPE_SECRET_KEY` set, reviews past the free ones are paid from prepaid credit. An
administrator of a connected repository buys credit on the Billing page through Stripe
Checkout ($10, $25, $50 or $100); it does not expire. Each review past the free ones takes
its price from the credit once its cost settles, as one row per review in the `credit`
table, so a later plan change never prices it again. Once the free reviews are used, a
review starts only while credit is above zero, so the last one can take it slightly below
and the next purchase covers that. At zero the PR comment says so and links to the Billing
page; each paid review's comment says what credit is left and warns below $2. Without a
key nobody can buy credit, and past the free reviews only credit an operator adds pays.
Reviews that started before 2026-10-01 are never charged.

A purchase is credited when the browser returns from Checkout, once the worker has
checked with Stripe that this organization's customer paid the amount sold; if the buyer
closes the page first, the hourly check credits it. Paying saves the card. With auto
top-up on, the worker charges that card the chosen amount off-session whenever credit
falls below $5, checked after each review and hourly. A top-up's PaymentIntent is created
unconfirmed under an idempotency key, recorded in the `payments` table, then confirmed, so
an interrupted top-up is finished by reading it back, never by charging again. A declined
card, or one whose bank asks the card holder to approve the charge, stops auto top-up until
an administrator buys credit or turns it on again. Stripe emails receipts when Settings >
Emails > Successful payments is on in the Stripe dashboard.

Stripe's test and live modes share no customers, cards or payments, so the worker records
the mode of the key it last ran with. Started with a key of the other mode, it forgets
every organization's Stripe customer, saved card and auto top-up, closes open payments as
expired, and logs the counts. Credit balances stay. A key that is neither a test nor a
live key stops the worker at start.

### Organizations' own model keys

An operator can set an organization's own model key with Model key in `/admin`. Only
Amazon Bedrock is supported: reviews then run GPT-6 Luna on the organization's Bedrock
account through Bedrock's US inference profile (us-east-1, us-east-2, us-west-2) on its
OpenAI-compatible `bedrock-runtime` endpoint, at Bedrock's rates, with the repository
profile's limits. Such reviews use none of the organization's free reviews or credit and
do not count toward the daily limits, which bound the service's own model spend; a
monthly limit of 0 still turns its reviews off. The PR comment says the review ran on the
organization's own key.

Saving a key first makes one small call with it, so a key that cannot reach Luna is
refused. The key's IAM policy needs `bedrock:CallWithBearerToken`, and
`bedrock:InvokeModel` on the `us.openai.gpt-6-luna` inference profile and on the account's
default project (`arn:aws:bedrock:us-east-1:<account>:project/default`). Keys are stored
sealed with `ATMIN_REVIEW_KEY_SECRET` (at least 32 bytes); without it none can be set or
used, and a key sealed under a different secret stops that organization's reviews rather
than running them on the service's key. Only the service's own runners receive the key,
with that organization's job, and the job forgets it once claimed. The Jev rung still runs
on the service's TypeSafe key.

### Operators

`operators` lists GitHub user IDs, not logins, because a login can be renamed and taken
by someone else. Operators get `/admin`, which lists every installation of the App with
its repositories, reviews this month, model cost, billing and margin, and can change a
plan: `freeReviews`, `monthlyReviews` (0 turns reviews off), `multiplier` and
`minimumUsd`. A review past the free ones is billed at the larger of its cost times the
multiplier and the minimum. Operators can also add or remove credit, with a note the
organization does not see.

On OpenRouter, cost is the amount OpenRouter reports billing for each call; on OpenAI it
is priced from the call's usage, cache writes included. A call whose charge or cache
writes are not reported stays unsettled and is left out of billing. OpenRouter's fee on
credit purchases is not included.

## Develop

```sh
npm ci --ignore-scripts
npm test
node packaging/verify.mjs
```

Tests use local repositories, fake provider responses and temporary databases; they
spend nothing and do not establish model quality. Package verification installs the
actual npm archive in a clean directory and exercises both CLI entry points and snapshot
rendering. [AGENTS.md](AGENTS.md) describes the layout and conventions, and
[CONTRIBUTING.md](CONTRIBUTING.md) how to send a change.

## Design and evaluation

- [Claim-lifecycle design](docs/claim-lifecycle-design-2026-09-17.md): the claim schema,
  the evidence ladder and the evaluation method. The earlier
  [repository-state direction](docs/repository-state-direction.md) stays for context.
- Specifications: the [claim schema](spec/claim-schema.md), the
  [evidence chain](spec/evidence-chain.md) and the
  [verdict policy](spec/verdict-policy.md).
- Measurement: the [regression harness layout](harness/README.md), the
  [pre-registered paired benchmark](bench/PLAN.md), the [benchmark plan](benchmarks/README.md)
  and the [research log](docs/research-log.md).

The ship bar is 70% precision on the 15 Martian development cases.

Known limits: rung 1 asks four kinds of question of the head or the merge base (what a
declaration contains, what a body contains, what a file contains, and whether a symbol is
referenced outside a file). Without `TYPESAFE_API_KEY` the cross-family rung does not run,
no claim reaches high confidence through agreement, and the report says so.

## License

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
