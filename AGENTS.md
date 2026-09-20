# Notes for agents working in this repository

Operational facts that are expensive to rediscover. Keep it short; if a section stops
being true, fix it rather than adding a second one.

## Running the reviewer in a container

- `npm ci` before `npm run build` — a fresh clone has no `node_modules`. Node here is 22
  while `package.json` asks for 24; both build and suite pass anyway.
- Suite is 306 tests: 304 pass, 2 skip by design behind `ATMIN_REVIEW_VERIFY_LINUX`.
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

## The one rule the live runs kept teaching

**A rung must be asked a question it can answer, about material it was sent, at a
revision it was told.** Three separate findings turned out to be this rule broken three
ways, each costing a correct `auth_bypass`:

- *Material it was sent.* `jevState` carried only the file the claim was located in, so
  a proposition about a test asked Jev about text it had never seen.
- *A question it can answer.* `body_contains` searched the declaration line, so
  "actorId is not referenced in the function body" was refuted by the parameter list —
  the check could not express the question the proposition asked.
- *A revision it was told.* A proposition naming no side is true at head and false at
  base. Rung 1 ran at head and missed, correctly; rung 3, handed the bare sentence and a
  state carrying both sides, answered for base; `suspectChecks` held the claim back.
  Neither rung was wrong. They were answering different questions.

Each was invisible downstream, because in every case both rungs behaved exactly as
specified. When two rungs disagree, suspect the question before either answer. The
revision is now a field on the proposition, resolved once by `propositionSide` in
`src/claim.ts` and used by every rung, with the invariant tested rather than commented.

**Enforce it in the structure, not in the prompt.** The first attempt at the revision
named it in the question — "judge this at the head revision" — and made things worse.
With both revisions in the state, naming one narrowed the model to the changed file, so
"the tests expect a Forbidden error" read as "does a Forbidden error still happen after
this change" and Jev answered 0.1 to a fact grep had confirmed. Contradicted checks went
from 1 in 52 propositions to 8 in 94, and one run lost the finding outright. Three
wordings were measured and all three suppressed it identically, which is what says the
phrasing was never the problem. Sending only the revision the question is about scored
6 of 7 against 4 for both-sides and 3 for both-sides-with-a-qualifier, on statements all
true of the code. A state that holds one revision cannot be misread; a sentence asking
the model to hold one in mind can. One claim with propositions on both sides now takes
two calls, each carrying half the source.

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
- Run-to-run variance was high before those fixes. Measured again over 5 repeats per PR
  at `03fda12`: PR #2 returned `block` 5/5 with 0 unsettled propositions out of 46, and
  the surviving finding was the `auth_bypass` itself every time. Claim counts still vary
  (2 to 3) and the emitter picks different line numbers for the same defect, but the
  spread is between correct verdicts rather than between a correct one and a miss.
- **Keep a negative control in any run set.** PR #4 (242 lines of docs, nothing to find)
  is the one here. Without it, "blocks a real defect 5/5" cannot be told apart from a
  reviewer that blocks everything. It returned `merge` with no claims 4/5.
- **A soundness fix buys correctness, not recall.** A claim ships only when some rung
  can actually settle every proposition, so turning a wrong answer into *no* answer
  removes a false verdict without recovering the finding. Measured exactly: replaying
  the captured bad run through the fixed verifier moves both claims from `refuted` to
  `inconclusive` — the confident denial is gone — and the `auth_bypass` still does not
  ship, because `inconclusive` does not ship either. Asking Jev live over the same
  claims left the proposition unsettled, since the check named a symbol and the state
  therefore never carried the file that would answer it. Recall has to come from the
  checks being able to reach the right file. `test/self-refuting-regression.test.mjs`
  freezes both halves of that result.
- **Check whether a fix actually fired before crediting it.** The 10-run set after the
  verifier fix came back 10/10, and the new rule fired zero times — the emitter simply
  did not produce the bad proposition in those runs. The score was variance. A failure
  mode that appears roughly 1 run in 5-10 cannot be measured by 5 repeats at all; replay
  the captured run that exhibited it instead, which is deterministic and free.
- **A refutation is never questioned, and that is the asymmetry to watch.**
  `verifyClaim` short-circuits on the first refuted proposition and never reaches rung
  3, by design — a symbolically refuted claim is not carried to a later rung. So
  `suspectChecks`, which exists precisely to catch a check that does not mean what its
  proposition says, only ever protects *established* checks. A mismatched check that
  **refutes** is unprotected, and refuting is the strongest verdict there is. Seen
  2026-09-20: the proposition "there is no other function or middleware that enforces
  ownership" was checked with `referenced_outside(renameAccount, expect: absent)`, which
  asks whether the function is called elsewhere — a different statement. The test file
  calls it, so the check missed and refuted a correct `auth_bypass`. That miss rests on
  having *found* references, so it is sound as a check and the circularity rule above
  correctly leaves it alone. The fault is the proposition-to-check mapping, and nothing
  downstream can see it. `--question-refutations` asks rung 3 when a single check
  carries the whole refutation, which turns that trade-off into a number rather than a
  judgement. It is off by default. Measured live over 30 runs (PR #2 and PR #4,
  deepseek-v3.2): it fires on 2 of them, costs 1 extra Jev question each (~$0.0003 a
  question, $0.0006 across all 30), and reversed 2 of 2 refutations — both of them wrong
  refutations of a correct `auth_bypass`, with Jev at 0.92 and 0.90. **0 correct
  refutations reversed, 0 verdicts changed.** So like the circularity rule it buys
  correctness and not recall: the claim moves from `refuted` to `inconclusive`, which
  still does not ship.
  It stays off until there is evidence it is worth a default, and 2 firings is not that.
  Flip it when a run set of 30 or more produces at least 10 firings, still with no
  correct refutation reversed; or flip it sooner if a single correct refutation is ever
  reversed, in the other direction — that is the result that would retire the flag
  instead. Until then the cost of leaving it off is nothing, and turning it on is one
  line in `src/cli.ts`.
  The sentence to keep whatever happens to the flag: **refutation is the strongest
  verdict the verifier can reach, and it is the one nothing else checks.**
- **A replay cannot measure a change that alters which questions get asked.** Replay is
  the right tool for a change to how recorded answers are *composed*, and the wrong one
  for a change to *reach* — anything that sends a rung somewhere it did not go before.
  The recorded log holds answers only to the questions the old code asked, so a
  proposition the new code newly reaches has no recorded answer, the replaying rung
  returns neutral, and the old outcome survives by construction. The measurement then
  reports "no effect" for a change that has one. Seen twice on 2026-09-20: replaying
  `--question-refutations` reported 0 reversals where a live run reversed 2 of 2. The
  test: does the change alter the set `questionsAsked()` returns? If yes, measure live.
- **Self-refuting propositions are the live emission failure mode.** The model states a
  proposition about data shape or intent — "the account object has an ownerId property"
  — and then scopes its check to the changed function's body, where the defect it is
  reporting guarantees the pattern is absent. The grep misses, and a miss on rung 1 is a
  refutation, the strongest negative verdict available. A true finding becomes a
  confident denial. Seen in both run sets (pre-fix on a `contract_break`, post-fix on the
  `auth_bypass` itself, which cost that run the finding), so it is emission variance, not
  a regression. Worth fixing; no deterministic detector is obvious, because the check is
  well-formed and only its placement is wrong.
- **A claim's type is not verified against what it is about.** The fifth control run
  emitted 9 claims about the documentation — a stale commit hash, undefined jargon —
  typed `error_handling_gap` and `contract_break`, and confirmed 6 at high confidence,
  because as statements about the text the propositions are true. Claims located in
  prose are now rejected at emit time (`PROSE` in `src/claim.ts`); the general hole,
  that verification settles propositions and never asks whether the type fits, is still
  open for code files.
- **The recall ceiling was rung 1 being asked the wrong question, not a missing rung.**
  Categorised every correct claim across the 31 runs on disk — correct meaning located in
  `examples/suggestion-demo/accounts.mjs` and describing the missing ownership check. 57
  emitted, 37 shipped, 20 did not. Replaying all 20 through the verifier showed **every
  one of the 20 was settleable by a rung already present**; none needed a rung the
  reviewer does not have. Ten now ship: six from the `jevState` fix and four from the
  `bodyOf` fix below. The other ten carry checks written by emitter versions that predate
  `file_contains` and the prompt guidance, and a replay cannot recover them because the
  check bytes are frozen — none of those failure shapes recurs in the 20 most recent runs.
- **`body_contains` did not mean the body, and that alone killed four correct claims.**
  `bodyOf` sliced from the declaration line inclusive, so the signature was searched too.
  `renameAccount(accounts, actorId, accountId, displayName)` mentions `actorId` exactly
  once, in its parameter list, so the proposition *"actorId is not referenced in the
  function body"* — true, and the sharpest statement of this defect, a parameter accepted
  and never used — was refuted by the parameter list itself. The invariant now holds and
  is tested, not just commented: **`declaration_contains` reads the declaration line,
  `body_contains` reads everything under it, and the two do not overlap.** The one
  exception is a definition with nothing indented under it, which is its own body;
  otherwise an `expect: 'present'` check would be refuted by an empty body.
- **A cheaper rung can be wrong, and the ladder's ordering assumes it cannot.** Rung 1 is
  ordered first because it is deterministic and free, and a refutation from it is final —
  no later rung argues with it. The `actorId` case broke that: rung 1 refuted, rung 3
  answered 0.92 that the proposition held, and **rung 3 was right**. Determinism is not
  correctness; it only means the same wrong answer every time. So a disagreement between
  rungs is evidence about the cheaper rung's *definitions*, not only about the claim, and
  the useful thing to do with one is read the check's semantics rather than pick a winner.
  That is how the `bodyOf` bug was found, and it is why `--question-refutations` looked
  valuable: it was compensating for this bug at rung 3's price. Fix the cheap rung first;
  a model call is a bad way to pay for a grep that means the wrong thing.
- Rung 3 contributed nothing to claim selection in the one measured ablation — no claim
  gained or lost, no proposition settled that symbolic had not already settled. Its only
  effect was raising the surviving finding to high confidence, moving the verdict from
  `security_review` to `block`. Treat it as escalation, not filtering.
