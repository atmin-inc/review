# Guide for agents and contributors

How to build, test and change atmin review. Keep this file short and current: when
something here stops being true, fix the line rather than adding a second one. The
measurements behind the current design live in [docs/research-log.md](docs/research-log.md);
read the section for the area you are changing before you change it.

## Rules that are not negotiable

- **Never name a customer.** No customer, customer repository, customer employee,
  customer code or finding text in code, tests, docs or commit messages. Write "the
  pilot repository", "a production monorepo" or "a customer PR" instead. This repository
  is public.
- **Never execute repository code during source review.** The reviewer reads Git blobs
  of a frozen snapshot. Only the optional isolated checks (`docs/isolated-checks.md`)
  run commands, inside Bubblewrap, from operator configuration, never from model output.
- **Provider and repository text never reaches a log, an error message or a PR comment.**
  Errors carry controller-authored messages only (`src/contracts.ts`,
  `src/provider-error.ts`), because provider text can quote repository source.
- **Spending is bounded before it happens.** Every model call reserves its worst-case
  price against the profile's `maxUsd` first; unknown cost is shown as unsettled, never
  as zero.
- **An incomplete review never gets a clean verdict.**

## Build, test, run

Node 24 or newer, Git, and for capturing PRs an authenticated GitHub CLI (`gh`).

```sh
npm ci --ignore-scripts
npm run typecheck
npm test                    # builds dist/, then runs test/*.test.mjs
node packaging/verify.mjs   # packs the npm archive and exercises the installed CLIs
npm --prefix web ci --ignore-scripts && npm --prefix web test   # dashboard, when web/ changes
```

Tests use local Git repositories, fake provider responses and temporary SQLite
databases; they spend nothing and say nothing about model quality. A few tests skip
unless `ATMIN_REVIEW_VERIFY_LINUX=1` is set on a Linux host with Bubblewrap (see
`docs/isolated-checks.md`).

Running a review needs a model key: `OPENROUTER_API_KEY` for the OpenRouter profiles,
`OPENAI_API_KEY` for the OpenAI ones, and `TYPESAFE_API_KEY` to turn on rung 3 (Jev).

```sh
node dist/cli.js review https://github.com/OWNER/REPO/pull/123 \
  --profile profiles/review-luna-openrouter.json --out ./private-review
node dist/cli.js claim-review ./private-review --profile profiles/review-luna-openrouter.json
node dist/cli.js claim-ablate ./private-review --rung cross_family_llm
```

`claim-review` and `claim-ablate` accept a prepared snapshot directory in place of a PR
URL. Snapshot directories contain repository source; keep them private.

`prepare` needs `gh` and runs `git fetch` with a scrubbed environment (`commandEnv()` in
`src/snapshot.ts`), which drops proxy variables. Where that cannot work, build the
snapshot directly: `capture()` and `git` from `src/snapshot.ts` and `initialResult` from
`src/contracts.ts`, then write `change.diff`, `packet.json` and `result.json` as
`prepare` does.

## Architecture in brief

A review is a **claim pipeline** over an immutable snapshot of one PR:

1. **Capture** (`src/snapshot.ts`): the head, the merge base and the diff, fetched into a
   private bare repository. Nothing in it is executed.
2. **Emission** (`src/investigator.ts`, `src/claim-run.ts`): a model reads the change
   through bounded tools (`read_file`, `search_repository`) and records **claims**
   (`src/claim.ts`): one falsifiable assertion about one location, with propositions
   and the checks that would test them. A second pass looks only at failure paths
   (`src/failure-excerpt.ts`); it runs beside the first, on a third of the budget, so a
   review takes as long as its longer pass. A request unanswered after 5 minutes is sent
   again. Large diffs are reviewed in parts that share one budget. `telemetry.json` records
   each pass's `wallMs`, `modelMs` and `slowestCallMs`; `verification.json` `crossFamilyMs`.
3. **Verification** (`src/lifecycle.ts`, `src/evidence.ts`): each proposition is settled
   against the frozen revision by an ordered ladder of rungs, with none of the emitter's
   reasoning in scope. Rung 1 (`src/symbolic.ts`) is deterministic search over Git
   blobs; rung 3 (`src/jev.ts`) is a cross-family model asked one proposition at a time.
4. **Verdict** (`src/policy.ts`, `src/rating.ts`): code composes the verdict and rating
   from typed signals. A model never decides the verdict.
5. **Rendering** (`src/render-claim.ts`, `src/claim-result.ts`, `src/render.ts`): the
   report, plus `result.json` and `receipt.json` in the shapes the GitHub worker publishes.

Around it:

- `src/cli.ts`: the `atmin-review` command. `investigate` still runs the older
  single-pass engine (`src/investigation.ts`); `review` and the worker run the claim
  pipeline.
- `src/github/`: the GitHub App service. Signed webhooks, a SQLite job store, the router
  that offers reviews to runners, check runs and inline comments, the dashboard API,
  plans, Stripe billing and organizations' sealed model keys.
- `src/runner-cli.ts`, `src/code-review-runner.ts`: runners that take reviews from the
  service, either the service's own pool or a member's machine.
- `web/`: the dashboard (React, esbuild, Tailwind), served by the worker.
- `deploy/`: host setup and the release script; `.github/workflows/`: CI, deploy and release.
- `benchmarks/`, `bench/`, `harness/`, `spec/`, `docs/`: evaluation tooling, the
  pre-registered benchmark plan, specifications and design notes.

## Conventions

- **Match the surrounding style.** Do not reformat files or reorder code for taste.
- **Comments** follow the rules in [CONTRIBUTING.md](CONTRIBUTING.md#code-comments): say
  what the code does and why, in present tense; keep history in commit messages.
- **Every behavior change comes with a regression test that fails without it.** Test
  names describe the behavior; test comments say why it matters.
- **Measure before changing what the model is told.** Changes to prompts, tool
  descriptions or the verifier move benchmark numbers. Change one thing at a time,
  measure it on the verifier or emission bench first (`benchmarks/verifier-bench.mjs`,
  `benchmarks/emission-bench.mjs`), and record the result in `docs/research-log.md`.
- **A replay cannot measure a change that asks new questions.** If a change alters which
  propositions reach rung 3 (`questionsAsked()`), measure it live.
- **Keep benchmark profiles fixed.** `profiles/martian-*.json` are what the recorded
  numbers were measured with; production profiles are separate (`profiles/review-*.json`).
- **Commits:** imperative subject under 72 characters, a body that says why.

## Debugging notes

- "Investigation failed; provider or source operation unavailable" hides the real
  error on purpose. To see it locally, print `error.constructor.name` and
  `error.message` in the outer catch of `dist/investigator.js` for one run, then rebuild.
- A provider can serve a tiny request while refusing a real one: each call reserves
  `price(inputTokens, maxOutputTokens)` up front. On OpenRouter compare
  `total_usage` with `total_credits` from `GET /api/v1/credits`; `GET /api/v1/key` does
  not show an exhausted account balance.
- `maxInputTokens` is a local guard only and must stay under the model's real context
  window (read it from `https://openrouter.ai/api/v1/models`).
- A failed worker job records `service-or-github-failure (<cause>)`, and the worker logs
  `atmin review: review <id> of PR <n> failed: <cause>`. A GitHub cause names the status
  and the request, never the response body.
- Jev publishes its schema at `https://api.typesafe.ai/openapi.json`; `src/jev.ts`
  follows it.
