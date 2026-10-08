# atmin review

Source code review with evidence, clear verdicts, and bounded model spending.
Run the CLI yourself or operate the included GitHub App worker. Experimental
alpha: model quality and severity calibration are still being measured.

## Install the alpha

### Homebrew

On macOS or Linux:

```sh
brew install atmin-inc/tap/atmin-review
gh auth login
cp "$(brew --prefix atmin-inc/tap/atmin-review)/share/atmin-review/profiles/smoke-openrouter-free.json" ./review-profile.json
```

Set `OPENROUTER_API_KEY` in your environment, then run:

```sh
atmin review https://github.com/OWNER/REPO/pull/123 \
  --profile ./review-profile.json --out ./private-review
```

Homebrew installs Node, Git, the GitHub CLI and the `atmin` command. `atmin <tool>`
runs the installed `atmin-<tool>` binary, so other atmin tools sit beside this one:
`atmin review …` runs `atmin-review`, and `atmin code-review-runner …` runs your own
review runner. All commands below are available as `atmin review` (or
`atmin-review`) without the `npx` prefix. If you installed the older
`atmin-inc/tap/atmin` formula, run `brew uninstall atmin` first. If Homebrew refuses to load a
formula from an untrusted tap, run `brew trust atmin-inc/tap` and install again.

### npm

Requires Node 24 or newer, Git, and an authenticated GitHub CLI (`gh auth login`).
Install the versioned release in a fresh directory:

```sh
npm install @atmin.ai/review@0.1.0-alpha.4
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
`profiles/review-luna-openai.json` runs the same model directly on OpenAI with
`OPENAI_API_KEY`. It has not been measured on a real review yet. Its cost is priced from
OpenAI's usage, including prompt tokens written to the cache (1.25x input) and the higher
rate for prompts over 272K tokens.
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
`maxReviewsPerDay`. Diffs over 512 KB are not reviewed: the PR gets a "review not run" comment
saying so, and the review is neither counted nor charged. A failed review's comment and the
service log name the phase that failed and its cause: one of atmin's own messages about its
limits or input, or else only the error's kind, so no source or provider text is shown. Maintainers can comment
`/atmin review` to rerun. Use a dedicated host user. Source review does not execute repository code.
Optional [isolated checks](docs/isolated-checks.md) run selected commands and
verify proposed patches on a configured Linux worker. This private pilot is not
a hardened isolation boundary for many tenants. Each connected repository has its own
state directory, database and shared copy of its history. A repository over 2 GB on GitHub
does not connect; no review starts while the state disk has less than `minFreeDiskMb`
(default 2048) free; a shared copy over 3 GB is wiped before the next capture; a runner's copy of a
repository is deleted after 24 hours with no review of it; and run
records older than 90 days are deleted, except each PR's latest completed review. Each
organization's run records and shared copies together are held to `maxInstallationDiskMb`
(default 5120), checked before each review, so one review can go past it. Over the limit,
the organization's shared copies are wiped first, since the next review fetches its own
again; if its run records alone are still over, the review does not start, the PR comment
says why, and nothing counts against the plan. `/admin` shows each organization's use.

On the hosted runners every review step (capture, investigation, checks) runs in a Bubblewrap
sandbox that mounts only the system, the release's code, that run's directory and that one
repository's copy, so a step broken by a hostile repository cannot read another organization's
code. The release script refuses to deploy if the sandbox cannot start. Anyone with root on the
host can still read code while a review runs, and the model provider receives the code it
reviews: Luna is sent only to OpenRouter's zero-data-retention route. A member's own runner runs
on their own machine without this sandbox.

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

`trustedChecks`, `minFreeDiskMb` and `maxInstallationDiskMb` are optional. Use the actual check name and producer App ID you
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

When a PR closes, the worker records what became of each finding the PR's completed
reviews published, first publication counted once. `changed` means the flagged line or a
line next to it was edited or removed by the PR's last head; `unchanged` means those three
lines are still in the file, ignoring indentation, wherever they moved to. An unrelated
edit to the same lines also counts as changed, so the changed share is at most the share of
findings acted on. It also records whether the PR merged, and the thumbs up, thumbs down
and human replies on the finding's inline comments (each carries a hidden
`<!-- atmin-finding:... -->` marker; comments posted before 2026-09-30 have none, so their
reactions are not read). Resolved conversations are not read, since GitHub reports them
only through GraphQL. A read that fails is recorded as `unknown` with its cause, and one
log line per closed PR gives the counts. `/admin` shows the totals per repository.

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
The worker keeps one copy of each connected repository's history in its state directory
(`source-cache.git`) and fetches only the commits it lacks. Each run's snapshot borrows
that copy and is deleted when the run ends; the JSON records stay. Disk limits per account
are still needed before widening access.
No repository execution is included.

With `REVIEW_DASHBOARD_CONFIG` pointing at a JSON file (`origin`, `clientId`, `models`,
and optionally `operators` and `appSlug`) and `GITHUB_OAUTH_CLIENT_SECRET` set, `serve`
also hosts the dashboard: the API, and the pages built into `web/dist` by
`npm run build:web` (pages answer 503 until that build exists). Anyone can install the
App and sign in with GitHub. Repository administrators connect up to ten repositories
per installation and pause or configure each one. Each installation is held to a
monthly plan: 20 free reviews per UTC calendar month by default. A review counts
once inference starts, failed runs included; one cancelled before it finished (by a newer
commit or a pause) posted nothing and is neither counted nor charged, and neither is one that
asked no model because it had nothing new to read (a draft marked ready unchanged). A `/atmin review`
comment while a full review of the PR is already running is ignored. Past the limit the PR gets a "review not
run" comment with the reason and no model call is made. The daily `maxReviewsPerDay`
cap still applies to every installation together.

With `STRIPE_SECRET_KEY` set, reviews past the free ones are paid from prepaid credit. An
administrator of a connected repository buys credit on the Billing page through Stripe
Checkout, $10, $25, $50 or $100 in US dollars, and it does not expire. Each review past the
free ones takes its price from the credit once its cost settles: one row per review in the
`credit` table, written once, so a later plan change never prices it again. Once the free
reviews are used, a review starts only while credit is above zero, so the last one can take it
slightly below and the next purchase covers that. At zero the PR comment says so and links to
the Billing page; each paid review's comment says what credit is left and warns below $2.
Without a key nobody can buy credit, and past the free reviews only credit an operator adds
pays. Reviews that started before 2026-10-01 are never charged.

A purchase is credited when the browser comes back from Checkout, once the worker has checked
with Stripe that this organization's customer paid the amount sold; if the buyer closes the
page first, the hourly check credits it. Paying saves the card. With auto top-up on, the
worker charges that card the chosen amount off-session whenever credit falls below $5,
checked after each review and hourly. A top-up's PaymentIntent is created unconfirmed under
an idempotency key, recorded in the `payments` table, then confirmed, so an interrupted
top-up is finished by reading it back, never by charging again. A card that declines, or
whose bank wants the card holder to approve the charge, stops auto top-up until an admin buys
credit or turns it on again. Stripe emails receipts to the address entered in Checkout when
Settings > Emails > Successful payments is on in the Stripe dashboard. The `invoices` table
of the earlier monthly-invoice release is left as it is.

Stripe's test and live modes share no customers, cards or payments, so the worker records the
mode of the key it last ran with. When it starts with a key of the other mode (going live, say),
it forgets every organization's Stripe customer, saved card and auto top-up, closes open
payments as expired, and logs the counts. Credit balances stay: credit bought with test cards
still counts until an operator takes it away in `/admin`. A key that is neither a test nor a
live key stops the worker at start.

An organization can bring its own model key: an operator sets it with Model key in `/admin`.
Only Amazon Bedrock for now: reviews then run GPT-6 Luna on the organization's Bedrock account
through Bedrock's US inference profile (us-east-1, us-east-2, us-west-2) on its OpenAI-compatible
bedrock-runtime endpoint, at Bedrock's rates (OpenAI's plus 10%), with the repository profile's
limits. Such reviews use none of its free reviews or credit, and its plan does not count them;
the daily limits still do, and a monthly limit of 0 still turns its reviews off. The PR comment
says the review ran on the organization's own key. Saving a key first makes one small call with
it, so a key that cannot reach Luna is refused then. The key's IAM policy needs
`bedrock:CallWithBearerToken`, and `bedrock:InvokeModel` on the `us.openai.gpt-6-luna` inference
profile and on the account's default project (`arn:aws:bedrock:us-east-1:<account>:project/default`). Keys are
stored sealed with `ATMIN_REVIEW_KEY_SECRET` (at least 32 bytes, in `service.env`); without it
none can be set or used, and a key sealed under a different secret stops that organization's
reviews instead of running them on our key. Only this service's runners receive the key, with
that organization's job, and the job forgets it once claimed. The Jev rung still runs on our
TypeSafe key.

`operators` lists GitHub user IDs, not logins, because a login can be renamed and taken
by someone else. Operators get `/admin`, which lists every installation of the App (read
with the App's credentials) with its repositories, reviews this month, model cost,
billing and margin, and changes a plan: `freeReviews`, `monthlyReviews` (0 turns
reviews off), `multiplier` and `minimumUsd`. Billing for each review past the free ones
is the larger of its cost times the multiplier and the minimum. An operator-set plan
applies as set; past its free reviews it is paid from credit like any other. Operators also
add credit to an organization, or take it away, with a note the organization does not see.
On OpenRouter, cost is the amount OpenRouter reports billing for each call, not a rate
card estimate; on OpenAI directly, it is priced from the call's usage, cache writes
included. A call whose charge or cache writes are not reported stays unsettled and is left
out of billing. OpenRouter's fee on credit purchases is not included. With
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
