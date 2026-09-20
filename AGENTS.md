# Notes for agents working in this repository

Operational facts that are expensive to rediscover. Keep it short; if a section stops
being true, fix it rather than adding a second one.

## Running the reviewer in a container

- `npm ci` before `npm run build` — a fresh clone has no `node_modules`. Node here is 22
  while `package.json` asks for 24; both build and suite pass anyway.
- Suite is 285 tests: 283 pass, 2 skip by design behind `ATMIN_REVIEW_VERIFY_LINUX`.
- **Check credit, not just reachability.** As of 2026-09-20 `OPENAI_API_KEY` reaches the
  API but has no credits — every call is 429 `insufficient_quota`, which surfaces only
  as "Investigation failed; provider or source operation unavailable", and the reported
  spend is the *reservation*, so a non-zero figure does not mean anything was billed.
  Use `profiles/baseline-deepseek.json` (OpenRouter). `TYPESAFE_API_KEY` works.
- Model hosts are allowed by an egress policy fixed at session start. Allowing a host
  mid-session does not reach a session already running.
- `prepare` shells out to the `gh` CLI, which these containers lack, and its `git fetch`
  runs under `commandEnv()`, which strips proxy variables. Build the snapshot directly
  instead: `capture()` and `git` are exported from `src/snapshot.ts` and `initialResult`
  from `src/contracts.ts`. Take the PR identity from the GitHub API, init a bare repo,
  fetch the two SHAs from a local clone over the file transport, then write
  `change.diff`, `packet.json` and `result.json` as `prepare` does. `claim-review`
  accepts that directory in place of a PR URL.

## Jev (rung 3)

The API publishes its own schema at `https://api.typesafe.ai/openapi.json`, with Swagger
UI at `/docs`. Read that rather than guessing; `.smoke/jev-schema.json` is missing from
the public export. `GET /v1/models` lists `jev-latest` and `jev-preview`. Verified live
2026-09-20; `src/jev.ts` matches it.

## What the first live runs showed (2026-09-20, PR #2, deepseek-v3.2)

- A real model emits usable claims: it found the defect every run, typed and located it
  correctly, and wrote propositions the symbolic rung settled.
- **Closed since.** Its dominant failure mode was scoping a check to a symbol that is
  not a declaration — `symbol: "test"`, or a file path — which left the proposition
  unsettled and made the whole claim inconclusive. `file_contains(path, pattern)` was
  added for this; the model now reaches for it and no proposition goes unsettled.
- **Watch the state, not just the check.** Adding `file_contains` exposed a second bug:
  `jevState` sent Jev only the file the claim was *located* in, so a proposition about
  a test asked the model about text it had never been shown. It answered no, correctly,
  and the verifier read that as rung 3 contradicting a true symbolic fact — grep found
  `/Forbidden/` at `test/suggestion-demo.test.mjs:12` and Jev returned 0.12 on the same
  proposition. The state now carries every file the claim's checks name, capped at four.
  The general rule: a rung may only be asked about what it was sent.
- Run-to-run variance was high before those fixes. Measured again over 5 repeats per PR
  at `03fda12`: PR #2 returned `block` 5/5 with 0 unsettled propositions out of 46, and
  the surviving finding was the `auth_bypass` itself every time. Claim counts still vary
  (2 to 3) and the emitter picks different line numbers for the same defect, but the
  spread is between correct verdicts rather than between a correct one and a miss.
- **Keep a negative control in any run set.** PR #4 (242 lines of docs, nothing to find)
  is the one here. Without it, "blocks a real defect 5/5" cannot be told apart from a
  reviewer that blocks everything. It returned `merge` with no claims 4/5.
- **A claim's type is not verified against what it is about.** The fifth control run
  emitted 9 claims about the documentation — a stale commit hash, undefined jargon —
  typed `error_handling_gap` and `contract_break`, and confirmed 6 at high confidence,
  because as statements about the text the propositions are true. Claims located in
  prose are now rejected at emit time (`PROSE` in `src/claim.ts`); the general hole,
  that verification settles propositions and never asks whether the type fits, is still
  open for code files.
- Rung 3 contributed nothing to claim selection in the one measured ablation — no claim
  gained or lost, no proposition settled that symbolic had not already settled. Its only
  effect was raising the surviving finding to high confidence, moving the verdict from
  `security_review` to `block`. Treat it as escalation, not filtering.
