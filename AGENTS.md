# Notes for agents working in this repository

Operational facts that are expensive to rediscover. Keep it short; if a section stops
being true, fix it rather than adding a second one.

## Running the reviewer in a container

- `npm ci` before `npm run build` — a fresh clone has no `node_modules`. Node here is 22
  while `package.json` asks for 24; both build and suite pass anyway.
- Suite is 327 tests: 325 pass, 2 skip by design behind `ATMIN_REVIEW_VERIFY_LINUX`.
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

## First real PRs (2026-09-21, 5 Martian development cases, deepseek-v3.2)

One case per project — 005 cal.com, 016 discourse, 023 grafana, 032 keycloak, 046 sentry
— which is the three-to-five-case pilot `benchmarks/README.md` prescribes before
scheduling the suite. Golden comments come from the pinned upstream commit
`e616e849`, fetched read-only; `offline/` is not in this repository. 12 golden comments
across the five. $0.37 for all five.

- **Verdicts: merge, merge, nits, nits, merge. Six findings shipped, none matching a
  golden comment.** The five that shipped on case-032 were plausible-sounding cache and
  race concerns about the file the change touched, none of them the Critical recursion
  bug the golden comment names.
- **The emitter did find one of the twelve, and the verifier refuted it.** Case-005's
  first claim is golden comment [0] almost word for word — `retryCount: reminder.retryCount + 1`
  read concurrently and losing increments. Its check was
  `body_contains(symbol: "handler", pattern: "retryCount: reminder.retryCount + 1")`.
  `handler` is declared more times in the cal.com monorepo than the search returns, the
  search truncated, the pattern sits at `scheduleSMSReminders.ts:184` in a declaration it
  never reached, and the check returned a miss — **refuted at high confidence, with no
  limitation recorded.** `expect: 'absent'` was already guarded against an incomplete
  search; `expect: 'present'` was not, and `declaration_contains` had the same hole. Both
  now return inconclusive when the search truncated and nothing matched.
- **A symbol-scoped check cannot say which file it means.** The claim's own location named
  the right one. This is the monorepo form of the same rule below: the check could not
  express the question the proposition asked.
- **Operational limits bite on real PRs, and one of them was a bug.** Case-005 stopped on
  `Model turn limit reached` after recording the same `error_handling_gap` seven times;
  case-032 stopped on `Input token count unavailable or exceeds the configured limit`.
  The duplicates were not a missing feature: `record_claim` deduplicated on
  `JSON.stringify(draft)`, so the same assertion recorded again with different checks —
  twice with none at all — counted as a new claim each time. A claim is the assertion it
  makes; the checks are how it would be tested. The fingerprint is now type, location,
  description and suspected condition, and the first record keeps its checks. For the
  budgets, use `profiles/martian-deepseek.json` on real PRs rather than raising
  `baseline-deepseek.json`, which would silently change what every earlier demo number
  means.
- **`maxInputTokens` must stay under the model's real context window.** It is only a
  local guard — nothing sizes a request from it — so setting it above what the provider
  accepts trades a clear local error for an opaque one. `deepseek/deepseek-v3.2` is
  163840 in and up to 65536 out per `https://openrouter.ai/api/v1/models`, which is the
  place to read it rather than guess; the profile caps input at 150000. (This was fixed
  on 2026-09-21 after being blamed for a run of failures it did not cause — see below.)
- **"Investigation failed; provider or source operation unavailable" hides everything,
  so read the real error before theorising.** The outer catch in `src/investigator.ts`
  allows only a short list of message prefixes through, deliberately, because provider
  text can carry repository content. Twice on 2026-09-21 that opacity cost a full
  measurement round to a wrong guess. The cheap way to see it: copy `dist/investigator.js`
  aside, insert a `process.stderr.write` of `error.constructor.name` and `error.message`
  before the `const reason =` line, run one case, restore the copy. On 2026-09-21 that
  turned "must be my profile" into `ProviderRequestError: Provider funding unavailable`
  in one run.
- **Check the funding numbers, not just that a call works.** A tiny request can succeed
  while every real one fails: the investigation reserves
  `price(inputTokens, maxOutputTokens)` up front, so with `maxOutputTokens` at 8192 an
  almost-empty account serves an 8-token curl and 402s the reviewer. That is exactly how
  the OpenRouter account ran dry on 2026-09-21, at `total_usage 10.18` against
  `total_credits 10`; Lors topped it up the same day. `GET /api/v1/key` is not enough on
  its own — it reported no key limit while the account balance was already gone — so read
  `GET https://openrouter.ai/api/v1/credits` and compare the two numbers.
  `OPENAI_API_KEY` remains at zero, which is separate and still blocks
  `profiles/smoke-openai.json` and the grading script.
- Read the numbers as a pilot, not a score: one run per case, and precision against the
  70% floor needs the upstream semantic judge in `benchmarks/martian-grade.py`, which
  calls OpenAI and so cannot run while that key has no credit. Matching here is by hand.

## Five cases, three repeats (2026-09-21, deepseek-v3.2)

15 runs, $2.28, same frozen snapshots as the pilot. Full table in
`/mnt/project-files/martian-repeats-2026-09-21.md`.

- **6 of 12 golden comments found at least once, against 0 in the pilot**, but only one
  of the six in all three repeats. The other five each appear in a single repeat, so one
  run per case would have reported anywhere from 2 to 5 of 12 depending on luck.
  **Repeats are not optional on this benchmark.**
- **The adjudicated precision the 70% floor is defined against cannot be computed while
  `OPENAI_API_KEY` has no credit**, because `benchmarks/martian-grade.py` is the judge.
  Golden-comment match rate is not that number and must not be quoted as it: several
  non-matching findings are correct — case-046's P1 signature mismatches between
  `IssueSyncIntegration` and its implementations are real and no human commented on them.
- **The verifier is barely filtering: 105 claims emitted, 65 shipped, 10 of 12 on one
  case.** The reason is visible in the propositions rather than the verdicts. On a noisy
  claim every proposition restates the diff — "had margin-top at base", "does not at
  head" — which the checking pass confirms every time because the diff already says so,
  while the claim's actual assertion is never tested. The real findings cite something
  the change did not touch: the abstract method whose signature the call site no longer
  matches.
- **Three cheap filters were measured against the same runs and all three rejected.**
  Dropping hedged wording removes 33 of 58 findings and one real one. Merging same-type
  same-location claims is safe but removes 6 of 58. Requiring a check `path` outside the
  changed files does not see symbol-scoped evidence, so the real findings score exactly
  like the noise. None separates the two groups, which is what says the separation is not
  available at verification time. Fix it at emission.

## Trying to raise precision, and what it cost (2026-09-21)

Three sets of 15 runs on the same five frozen cases, $7.40 total. Full table in
`/mnt/project-files/precision-attempt-2026-09-21.md`.

| | baseline | emitter change | + symbol fixes |
| --- | --- | --- | --- |
| golden found at least once | 6 of 12 (7, corrected) | 5 of 12 | 2 of 12 (**4**, corrected) |
| emitted / shipped | 105 / 65 | 76 / 42 | 69 / 43 |
| stopped on the token cap | 4 | 4 | 8 |

- **The true and false positives ship for the same bad reason.** On a noisy claim every
  proposition restates the diff — "had margin-top at base", "does not at head" — which
  the checking pass confirms every time, while the claim's actual assertion goes untested.
  The `-ms-align-items` finding, a real golden comment, rests on exactly the same kind of
  proposition. **That is why no filter applied at verification time separates them**, and
  three cheap ones were measured against runs already on disk to confirm it: hedged
  wording (removes 33 of 58 and one real finding), same-type-same-location merging (6 of
  58), and requiring a check `path` outside the changed files (does not see symbol-scoped
  evidence, so the real findings score like the noise).
- **Asking the emitter to filter itself does not work either.** Telling it that a claim
  needs a proposition about something the change did not touch cut shipped findings by a
  third and cost recall, so it was reverted. It also looks like it drives the transcript
  past the token cap, though 3 repeats cannot separate that from variance.
- **Two real bugs fell out of asking why one case lost its findings entirely**, both the
  house rule again — a rung must be asked a question it can answer. `Class.method` never
  resolved, because that string does not appear in source and the bare member name
  exceeds the search cap; it is now looked up through the owner's declaration. And
  `declaration_contains` read one line, so a wrapped parameter list hid the parameter it
  was asked about and **refuted** a correct claim; the signature is now read to the end of
  its parameter list, with the line count handed to `bodyOf` so the two assertions stay
  disjoint. The case-046 repeat that shipped 0 of 7 claims before shipped 6 of 6 after.
- **The symbol fixes were checked for damage deterministically, not by another run.**
  Re-settling every recorded proposition across the 15 baseline runs against the same
  frozen snapshots costs nothing and answers the only question that matters about a change
  to rung 1, whose misses refute outright: **no proposition that was established became
  refuted, and none was lost.** 7 that settled nothing now settle, 14 that needed a Jev
  call are now free and deterministic, 1 wrong refutation became established, and 17
  refutations weakened to unsettled, which is the safe direction. (The 146 rung-3
  establishments that read as unsettled are the comparison running rung 1 alone, not a
  regression.) This is the right tool here because the change alters what rung 1 *answers*,
  not which questions rung 3 is *asked*; the replay trap below applies to the latter.

- **Both operational failures this run set exposed are now fixed.** A failed Jev call
  pushes nothing to the log, so a run that asked 0 questions where 7 claims needed them
  produced all-inconclusive claims and said nothing about why; `claim-run` now reports the
  count of claims the rung never reached, and the reason is deliberately left out because
  provider text can carry repository content. And the input token cap, which stopped
  between a third and a half of runs on the larger cases, now drops the oldest turns
  rather than the whole run: recorded claims live in `drafts` and not in the transcript,
  so trimming costs reading the model can redo and loses no finding. A turn is dropped
  whole, because a tool call separated from its result is not a conversation any provider
  accepts, and the total is reported as a limitation. The cap still stops a single turn
  that cannot fit, since there is no older turn to drop.

  Both are tested and both tests fail against the previous code. **The trimming is now
  measured: across the 15 runs of 2026-09-21 not one stopped on the token cap, against 4
  in the baseline and 8 in the set before.** Those runs stop on `Provider response
  incomplete` instead, which is a cut stream and a different problem.

- **The fix the diagnosis points at is `--question-conclusion`, off by default.** Nothing
  ever asked whether the claim its propositions were meant to establish actually holds.
  The propositions test the premises; the conclusion was never put to any rung, which is
  how "it had margin-top at base, it does not at head, therefore the layout breaks" gets
  confirmed. The flag asks rung 3 the claim's own assertion before a claim with every
  proposition established ships. **This is why it can separate what the three filters
  could not: it is a new question, not a re-reading of answers already given.**
  The gate is agreement rather than the absence of disagreement, because a hedged claim
  draws a neutral answer and neutral must not be enough for a conclusion. A rung that did
  not answer changes nothing, so an outage cannot turn every claim inconclusive.
  Costs one call per surviving claim, roughly a third of a cent across a run set.

  **Measured 2026-09-21 over 15 runs, and it stays off: it removes the good findings
  faster than the bad ones.** Isolated by re-verifying the same runs with the gate off,
  replaying the recorded answers, which is valid here because turning it off only ignores
  a question that was asked and reaches nowhere new. It withheld **5 claims of 41**, not
  the third the raw cross-set comparison suggested -- that comparison was confounded,
  because this set emitted 71 claims against the baseline's 105 for reasons upstream of
  the gate. Of the 5 it withheld, one is golden comment [1] on case-016 word for word --
  *"the align-items mixin contains a duplicate -ms-align-items property that appears to be
  a typo"* -- and two more read as genuine defects, including a P1 signature mismatch on
  case-046 in the same family as the ones it let through.
  **The reason is worth more than the flag: asking a model whether a claim holds selects
  for confident phrasing, not for correctness.** A speculative claim about the diff is a
  true description of what the code does, so it is affirmed; a precise technical claim
  that turns on outside knowledge -- is `-ms-align-items` a real CSS property -- draws a
  hedge. That is the third precision mechanism to fail, and all three failed the same
  way: **every mechanism that scores a claim after it has been made removes good findings
  faster than bad ones.** Precision has to come from claims being about something
  falsifiable, not from judging them afterwards.

  Flip rule if it is ever revisited: it earns a default only when a run set shows it
  withholding claims that are wrong, and none that match a golden comment.

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
- **A rule can be enforced at one layer and silently overruled at the next.** The
  circularity rule downgrades a miss that the change itself caused, from `refuted` to
  `unsettled`, and it worked — the proposition went to rung 3, which agreed at 0.97, and
  the record read `established`. The chain still came out `refuted` at high confidence,
  because `composeChain` reads any symbolic miss in the evidence array as a refutation
  before it looks at the proposition records at all. Two runs in ten, one of them losing
  its finding. The evidence is now dropped on downgrade rather than merely relabelled,
  and the check is reported as a limitation, which is where `inconclusive()` in
  `symbolic.ts` already puts every check that ran and settled nothing. Worth remembering
  as a shape: when a fix does not show up in the output, check whether a later layer is
  reading the raw evidence instead of the decision you made from it.
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

## What separates a real finding from noise (2026-09-21, 60 runs, no spend)

Computed from run artifacts already on disk. Full write-up in
`/mnt/project-files/what-separates-real-findings-2026-09-21.md`.

- **Two hand-matching errors in the frozen repeats report are corrected there, not in
  it.** case-005's concurrency comment *was* found and shipped (case-005-r1, describing
  the consequence backwards but naming the same race on the same line), and case-016's
  float comment was found in all three repeats, not one. Corrected: **7 of 12 golden
  comments found at least once, 13 shipped claims matching, not 9.** Those were my errors,
  not the reviewer's, and the conclusion of that report is unchanged.
- **Every structural property of a claim is flat between the 13 golden-matching findings
  and the other 52.** Which rung settled its propositions (23% all-grep against 25%), how
  many propositions it carries (3.11 against 2.86), whether its evidence reaches outside
  its own file, whether its propositions span base and head. **Two run backwards:** golden
  claims name *fewer* distinct check subjects (38% name two or more, against 60% of the
  noise) and are *more* likely to carry a mirrored check, because the two case-016 float
  findings are built exactly that way. So "a real defect is a contradiction between two
  sites" is wrong as stated, and so is every filter built on reach.
- **The only property pointing the right way is whether the claim says what the code
  should have been.** Every golden comment is "X should be Y" — `OR` should be `AND`,
  `-ms-align-items` should be `-ms-flex-align`, `"alias"` should be `"idp-alias-" + i`,
  `session.identityProviders().getById()` should be `idpDelegate.getById()`. The noise is
  "X, which may cause Y". Claims naming a specific alternative and predicting no
  consequence: **3 of 13 golden against 1 of 52 noise**. The form is rare and stably so —
  about **6% of shipped findings in every one of the four run sets**.
- **Read that as headroom, not as a filter.** As a filter the keyword test keeps 4 of 65
  claims, which is 23% recall and would be the sixth mechanism to fail the way the other
  five did. The corrective form is rare *because nothing asks for it*: a claim is a
  description, a location, a suspected condition and propositions, every one of which
  describes the code as it is. There is no field for the norm, so the emitter smuggles it
  into an adjective — "incorrect", "unintended" — where nothing can check it.
- **The change the diagnosis points at is a required, checkable replacement on the
  claim**, rejected at `record_claim` time the way `PROSE` already is: name the text,
  symbol or value the code should have carried, absent at the claim's location and, when
  it is a cross-reference, present somewhere the claim names. A real defect can always
  fill that field, because a defect is a departure from something; "removing `margin-top`
  may cause crowding" cannot, because there is no replacement text to point at. **That is
  what distinguishes it from the five failed mechanisms: it does not judge a claim, it
  makes an unfalsifiable claim inexpressible.**
- **Unmeasured, and the failure mode to watch is known.** Told to name a replacement, the
  model may invent one for speculative claims too, exactly as the previous emitter change
  invented compliance; the checkability requirement is what is meant to stop that. One
  15-run set answers it, at the $2.28 to $2.50 those sets have cost. Pass is golden recall
  holding at 7 of 12 with the shipped count roughly halved.

## What the 65 shipped findings actually are (2026-09-21, hand classified)

Every finding the 15 baseline runs shipped, read and classified; four verified against the
frozen snapshots rather than judged. Full table with each finding's text in
`/mnt/project-files/what-the-52-unmatched-findings-are-2026-09-21.md`.

| | count | of 65 |
| --- | --- | --- |
| matched a human comment | 13 | 20% |
| verified real, no human comment | 4 | 6% |
| plausible, unverified | 17 | 26% |
| restates the change, asserts no defect | 7 | 11% |
| speculation about a consequence | 21 | 32% |
| overstated — the named mechanism is not what the code does | 3 | 5% |

- **About 17 of 65 are defensible, 34 at the most generous reading, at least 31 are noise.**
- **The noise concentrates where there is least to find.** 15 of the 21 speculative
  findings are on case-016, the discourse CSS change — a stylistic diff with nothing
  falsifiable to say, so the reviewer fills the space with "removing this may cause
  crowding". case-023 shipped 4 findings, 3 of them restatements of the diff.
- **A correction to the standing example.** case-046's three P1 signature mismatches were
  cited here and elsewhere as real bugs no human commented on. Checked properly, **all
  three are overstated**: `sync_source` is optional with a default, and Jira's
  `sync_status_outbound` takes `**kwargs`, so nothing breaks at runtime. The genuinely
  real member of that family is `ExampleIntegration.sync_status_outbound`, which has no
  `**kwargs` — not the one that was being cited. Earlier sections of this file that name
  those mismatches should be read against this paragraph.
- **The split supports fixing emission, not filtering.** The four verified findings each
  name a concrete second thing the code disagrees with: a vendor prefix its siblings carry,
  a template still using a removed class, an abstract signature, a sibling's return
  annotation. The 21 speculative ones name a consequence with no replacement to point at.
  That is the same split the corrective-form measurement found, arrived at independently.

## How the benchmark scores (read from the grader, 2026-09-21)

- **50 PRs, 173 human comments.** The development split is 15 PRs carrying **41**; the 35
  reserved carry 132. The five cases run so far carry **12 of the 41**, so "15 cases" and
  the "15 runs" of a repeat set are different things and must not be conflated.
- Categories across the 15 development cases: bug 21, concurrency 5, security 5, style 3,
  speculative 2, api 2, doc_defect 2, test_gap 1. It is a record of what reviewers wrote,
  not an audit of every defect.
- **`benchmarks/martian-grade.py` extracts findings, dedups them, then judges them against
  that comment list. There is no "is this actually a bug" oracle**, so a correct finding
  no human commented on scores as a false positive. 13 of 65 is therefore close to real
  precision, about 20% against the 70% floor, not a conservative floor.
- The dedup step groups near-duplicate findings before judging, which should help, since
  these runs emit obvious near-duplicates. How much cannot be computed while
  `OPENAI_API_KEY` has no credit, and the upstream `offline/` package with
  `score_profiles.py` and the judge is not in this repository either.

## Severity of what is caught and what is missed (2026-09-21)

Against the severity labels the benchmark ships with its comments, over the 15 baseline
runs on the five cases.

| | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- |
| caught | 1 of 1 | 2 of 2 | 2 of 4 | 2 of 5 |
| missed | 0 | 0 | 2 | 3 |

- **Nothing above Medium is missed.** The five misses are the CSS `ordinal-group` values,
  a Grafana test gap, the Python mutable dataclass default, and two pure style nits — a
  typo in a test name and a method called `empty_array` that tests a dict. The headline
  "7 of 12" understates this, because the misses are the cheap end of the list.
- **So recall is not where to spend.** Noise is, and the sharp version of the criterion is
  that the tool should emit nothing that would ask for an incorrect change. **About 24 of
  the 65 shipped findings would** — the 21 speculations plus the 3 overstated case-046
  P1s. The 7 restatements are wasteful rather than harmful.
- **This reweighs the fork recorded above.** Requiring a claim to declare two concrete
  sites that disagree would cost 2 of the 7 comments found, and one of them is case-005's
  concurrent `retryCount` increment, a **High** — and it is borderline whether that defect
  can be put in that form at all. Worse trade than it first appeared.
- **Cheaper thing to measure first:** 15 of the 21 speculative findings are on case-016, a
  pure-CSS diff. A reviewer that recognises a stylistic change offers nothing falsifiable
  and stays quiet would remove roughly a quarter of all noise for 2 Low findings. That is
  a coverage decision, not a filter over emitted claims, so it does not repeat the
  mechanism that has now failed five times.

## Could the reviewer express all 12 human comments? Yes, 11 on grep alone (2026-09-22)

Each of the 12 golden comments was written out by hand as a claim in the current schema,
with real checks, and run against the frozen snapshots. The script is
`benchmarks/twelve-claims.mjs`; point `RUNS` at a directory of prepared `case-<id>-r1`
snapshots. It is not a suite test because those snapshots are not in this repository.

- **24 of 25 propositions settle on rung 1, and 11 of the 12 claims would ship on grep
  alone.** So neither the claim schema nor the four-check vocabulary is the ceiling. The
  reviewer can already state and deterministically verify almost every comment a human
  wrote on these PRs.
- **The single exception is case-005's `deleteMany`**, whose real assertion is "the
  `retryCount` branch of this `OR` carries no `method` filter". Literal grep cannot ask a
  positional question about a position inside an expression, so that proposition needs
  rung 3. Everything else — a missing vendor prefix, a template still naming a removed
  class, a wrong alias string, a signature, a `default_factory` that is absent — is a
  literal search.
- **Two of the three initial failures were the patterns, not the machinery.** `display:
  flex` does not appear in discourse's header, which uses `@include flexbox()`; a generic
  token like `filters` truncates in the Grafana tree. Both settle with a distinctive
  pattern. The lesson is the emitter's, not the verifier's: **a check is only as good as
  the distinctiveness of its pattern**, and in a large repository a common word settles
  nothing.

### The bug this turned up, now fixed

`file_contains` searched the **whole repository** and filtered by path afterwards, so a
pattern common elsewhere spent the 50-match cap before the search ever reached the file,
and the check returned inconclusive with the answer one grep away. That is exactly why
case-046's datetime round-trip comment could not settle: `isoformat` appears throughout
Sentry. `searchSource` now takes an optional pathspec and `file_contains` passes its own
path. Tested, and the test fails against the previous code. Suite is 320: 318 pass, 2 skip.

The truncation guard stays, because `within` is optional on the `Revision` interface and a
revision that ignores it must keep the old reservation. The stale assertion that expected
inconclusive for "noise elsewhere, file clean" was encoding the bug and now asserts the
settled answer.

### Where the noise actually comes from

`claimInstructions` in `src/investigator.ts` says, in as many words: *"Emit widely. A claim
that turns out to be wrong costs almost nothing, because verification kills it before any
user sees it."*

**That premise was false as measured.** 105 claims emitted, 65 shipped. Verification is not
the filter the prompt promised, so the instruction to emit speculatively was not a harmless
invitation — it was the noise generator, and it was deliberate.

**Rewritten 2026-09-22, and unmeasured until a run set says otherwise.** Three changes, all
in `claimInstructions`:

1. The false premise is gone. The prompt now says what is true — verification settles the
   propositions you write and never asks whether the claim was worth making, so an
   unsupportable claim reaches the user — and states the 105/65 number. The bar is no
   longer confidence but whether the defect can be stated as facts about text. Consequence
   language is named and refused. The recall guard stays explicit: claim everything
   statable that way, however small, because nothing above Medium is currently missed and
   that must not regress.
2. **One proposition must name what the code should have carried instead.** This is the
   corrective form the measurement found, required in the prompt rather than added as a
   schema field, which is the smaller change and testable first.
3. **Pattern distinctiveness is now stated**, because two of the three failures when
   writing the twelve claims by hand were this: the search caps at 50 matches so a common
   word settles nothing, and a stylesheet built on `@include flexbox()` does not contain
   the text `display: flex`.

**Measure before believing any of it.** The known failure mode is the one that killed the
previous emitter change: told to name a replacement, the model may fabricate one. 5 cases
x 2 repeats is about $1.52 at the measured mean of $0.152 a run, which fits what is left of
the OpenRouter credit; compare against repeats r1 and r2 of the baseline only, never
against all three, or the "found at least once" counts are not comparable.

## The emitter prompt rewrite was measured and reverted (2026-09-22)

8 runs of a planned 10 on the same five frozen cases, $1.54, stopped early because the
result was not in doubt and the OpenRouter credit was nearly gone. Full table in
`/mnt/project-files/emitter-prompt-rewrite-2026-09-22.md`.

| | baseline r1+r2 | rewritten prompt |
| --- | --- | --- |
| runs | 10 | 8 |
| emitted / shipped | 83 / 47 | 23 / 8 |
| golden comments found | **7 of 12** | **2 of 12** |
| shipped naming a replacement | 6 of 47 (13%) | **0 of 8 (0%)** |
| spend per run | $0.145 | $0.193 |

- **It cost a third more per run to find a fifth as much.** The pass criterion set before
  the runs was recall holding at 7 of 12 with the shipped count roughly halved. Noise did
  fall, but nothing separated noise from findings: the reviewer just says less. Lost
  against the baseline are case-032's Critical recursion bug and case-016's
  `-ms-align-items` comment.
- **The instruction at the centre of the change did not take at all.** Every claim was
  required to name what the code should have carried instead, and the rate went from 13%
  to 0%. So this does not measure the corrective form and find it worthless; it measures
  asking for it in a prompt, and finds the model does not produce it when asked — it
  emits less of everything instead. A required, checkable field rejected at
  `record_claim` time, the way `PROSE` already is, is a different mechanism and is still
  untested.
- **A contradiction was live during these runs and is deliberately still in place.** The
  `record_claim` tool description says *"Claims are cheap: emit a claim you are unsure of
  rather than staying silent, because a later verification pass settles it against the
  code and a wrong claim never reaches a user"* — the same false premise the rewrite
  removed from `claimInstructions`, in a second place that was not checked. It is a real
  confound. It is left alone because **the revert's purpose is to restore the exact
  configuration the 7-of-12 baseline was measured in**, and editing the tool description
  would produce a third unmeasured emitter, immediately after an unmeasured emitter
  change cost five golden comments. Fix it in the same run set that measures it.
- Half the runs were degraded (3 cut replies, 1 turn limit) against 4 of 10 in the
  baseline, so the two sets are comparable on that axis. The two runs not done are
  case-032 r2 and case-046 r2, both cases the baseline found golden comments on, so a
  full set would have flattered the rewrite less rather than more.

**The rule this adds to the five already here: a change to what the emitter is told is
not a small change, and bundling three of them makes the result unattributable.** Three
were measured as one and the loss cannot be assigned to any of them.

## Golden matching is automated now, and it corrected two more hand counts (2026-09-22)

`benchmarks/golden-matcher.mjs` matches a claim to a golden comment deterministically: in
the comment's file, with every token group present. `benchmarks/score-runs.mjs <dir>`
scores a run set with it, including **golden comments found per run with its SD**, which
is the number that sizes an experiment. Checked three ways before use: 13 of 13 against the
hand labels it was written from; every match and near-miss on the four held-out sets read
by hand, which found and fixed three false matches and three misses; and each of the 12
golden comments, used as a claim, matches exactly its own rule and no other.

The standard, stated so it can be argued with: a claim matches when it names the thing
the comment says is wrong, at the place it says, even if it predicts a different
consequence. The loosest rule is 016[0], which accepts any claim about a removed float in
`header.scss`; that is the standard the original hand labels used.

**It corrected two more hand counts, both undercounts.** The "+ symbol fixes" set
(`martian-rep5`) shipped **4 of 12**, not 2 — its `-ms-align-items` and `deleteMany`
findings are unambiguous — and the conclusion-gate set (`martian-rep6`) shipped 4, not 3.
That is three hand-matching errors in two days, in both directions. Do not hand-match
again.

**None of the set-to-set differences recorded above is statistically distinguishable.**
Per-run golden found, by set: 0.73 (SD 0.70), 0.60, 0.33, 0.36, and 0.25 for the reverted
prompt rewrite over 8 runs. At that spread a 15-run set cannot tell apart two reviewers
that differ by less than about 0.5 golden per run, so "7, then 5, then 4 of 12" is not a
trend. The rewrite's revert stands on its collapse in claim volume, 83 emitted to 23,
which is not in doubt. Size every experiment from this SD before spending; the method is
in `/mnt/project-files/method-2026-09-22.md`.

## Every claim labelled; the revert above was decided on the wrong metric (2026-09-22)

All 397 claims on disk were labelled against a written rubric, each non-obvious label
backed by a code fact read from the case's head revision. Data, rubric, code facts and a
script that reproduces every number: `/mnt/project-files/labelled-claims-2026-09-22/`.
Harmful means speculation with no named mechanism, or a named mechanism the code does not
have — acting on either changes code nothing shows is broken.

- **The verifier ships overstated claims at exactly the rate it ships real ones, 48%**, and
  restatements most of all, 74%. 55% of everything shipped is harmful. Overstated claims are
  29% of all emitted and are falsifiable in principle — one grep refutes most — but their
  propositions test the diff rather than the mechanism the claim names.
- **The prompt rewrite reverted in `94aff15` cut harmful findings from 2.9 to 0.13 per run
  (t = 4.0), while its drop in acceptable findings, 1.5 to 0.75, is inside noise (t = 1.3).**
  6 of its 8 shipped findings are acceptable, against 15 of the baseline's 47. It failed
  the pass rule written before the runs, and that rule stays as written; the rule was set
  on golden recall, which the section above shows cannot see anything smaller than a
  catastrophe on 10 runs.
- One labeller, not independently re-checked. Treat the rewrite result as strong on harm
  and silent on recall.
- **Re-applied on Lors's decision, 2026-09-22.** `claimInstructions` is the rewritten prompt
  again, exactly as measured. The `record_claim` tool description still carries "Claims are
  cheap", as it did during those runs, so what ships is the configuration the 0.13 figure
  was measured on. Changing it is a separate, one-change experiment.

## The rewrite, measured properly: quieter, not more precise (2026-09-23)

Pre-registered, 40 runs per arm differing only in `claimInstructions`, shipped findings
labelled blind to arm (second labeller on 25%: kappa 0.71). Full result, labels and a
reproducing script in `/mnt/project-files/prompt-rewrite-result-2026-09-23/`.

- **Harmful per run 2.30 to 1.40 (p = 0.034 one-sided); acceptable 1.25 to 0.65
  (p = 0.021).** Harmful is 57% of what ships in both arms. The rewrite shrinks everything
  by about the same fraction, and loses the Critical 032[0] and the High 005[0].
- **The 0.13 harmful per run above did not replicate.** It came from 8 runs labelled
  unblinded, and it is what the re-apply rested on. Size and blind before believing an
  effect, including a favourable one.
- Per the pre-registered rule this trade was Lors's call. **Lors chose to revert (2026-09-23):**
  `claimInstructions` is the old prompt again, byte-identical to `94aff15`.
