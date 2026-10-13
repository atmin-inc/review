# Research log

The measurements behind the reviewer's current design, in the order they were made.
Each entry records what was tried, what it measured and what changed as a result, so a
later change can be argued with the evidence rather than against it. Detailed per-run
tables and labelled data sets were kept outside this repository; the numbers here are
the ones the decisions rest on.

## Terms

- **Rung.** One level of the verification ladder. Rung 1 is deterministic search over
  the frozen revision (`src/symbolic.ts`); rung 3 is a cross-family model (Jev,
  `src/jev.ts`) asked about one proposition at a time.
- **Martian cases.** The 50 PRs of the public
  [Martian code review benchmark](https://github.com/withmartian/code-review-benchmark)
  (173 human review comments), split into 15 development cases (41 comments) and 35
  reserved ones (`benchmarks/martian-development-split.json`). A case is named by its
  number, for example case-005; a human comment on it is a **golden comment**, for
  example 005[0].
- **Run set.** Repeated runs of the reviewer over frozen snapshots of some cases.
- **Labels.** Shipped findings were labelled against a written rubric: G matches a
  golden comment, R is real but no human commented on it, P is plausible, S restates
  the change, X speculates about a consequence, O is overstated (names a mechanism the
  code does not have). **Harmful** is X + O: acting on either changes code that nothing
  shows is broken. **Acceptable** is G + R + P.

## What the measurements established

These are the conclusions that shaped the code; the entries below are the evidence.

1. **A rung must be asked a question it can answer, about material it was sent, at a
   revision it was told.** Most early losses of correct findings were this rule broken.
2. **Enforce it in the structure, not in the prompt.** A state that holds one revision
   cannot be misread; a sentence asking the model to hold one in mind can.
3. **Every mechanism that scores a claim after it is made removed good findings faster
   than bad ones.** Seven were measured; precision came from the model that writes
   claims and from not showing P3, not from filtering.
4. **Refutation is the strongest verdict the verifier reaches, and the least checked.**
   A cheap deterministic rung can be wrong; when rungs disagree, read the cheap rung's
   definitions before picking a winner.
5. **A replay cannot measure a change to reach.** Replaying recorded answers is exact
   for a change in how answers are composed and blind to a change in which questions
   are asked.
6. **Size experiments from the measured spread, label blind, and change one thing at a
   time.** Several early conclusions reversed once this was done.

## 2026-09-20: first live runs on a seeded PR

The first runs used a small demo repository with one seeded `auth_bypass` (a rename
function that accepts an actor and never checks ownership), DeepSeek v3.2 as the
emitter, and a documentation-only PR as the negative control.

- A real model emits usable claims: it found the defect every run, typed and located
  it correctly, and wrote propositions rung 1 settled.
- Its dominant failure was scoping a check to a symbol that is not a declaration
  (`symbol: "test"`, or a file path), which left propositions unsettled.
  `file_contains(path, pattern)` was added for this; the model now uses it.
- **Watch the state, not just the check.** Rung 3 was sent only the file the claim was
  located in, so a proposition about a test asked the model about text it had never
  seen. It answered no, correctly, and the verifier read that as rung 3 contradicting a
  true grep result. The state now carries every file the claim's checks name, capped at
  four.
- After those fixes, 5 repeats returned `block` 5 of 5 with 0 unsettled propositions out
  of 46, and the surviving finding was the seeded defect every time. The negative
  control returned `merge` with no claims 4 of 5. **Keep a negative control in every
  run set**: without it, "blocks a real defect 5 of 5" cannot be told apart from a
  reviewer that blocks everything.
- **A soundness fix buys correctness, not recall.** Replaying a captured bad run through
  the fixed verifier moved both claims from `refuted` to `inconclusive`; the finding
  still did not ship, because `inconclusive` does not ship either.
  `test/self-refuting-regression.test.mjs` freezes both halves of that result.
- **Check whether a fix fired before crediting it.** A 10-run set after a verifier fix
  came back 10 of 10 and the new rule fired zero times. A failure that appears once in
  5 to 10 runs cannot be measured by 5 repeats; replay the captured run instead.
- **A refutation is never questioned.** `verifyClaim` stops at the first refuted
  proposition by design, so `suspectChecks`, which catches a check that does not mean
  what its proposition says, only protects established checks. In one run the
  proposition "no other function enforces ownership" was checked with
  `referenced_outside(renameAccount, expect: absent)`, which asks a different question;
  the test file calls the function, so the check refuted a correct finding.
  `--question-refutations` asks rung 3 when a single check carries the whole
  refutation. Over 30 live runs it fired twice, cost about $0.0003 a question, and
  reversed 2 of 2 wrong refutations with 0 correct refutations reversed and 0 verdicts
  changed. It stays off by default: two firings is not evidence for a default. Turn it on
  if a set of 30 or more runs produces at least 10 firings with no correct refutation
  reversed; retire it if it ever reverses a correct one.
- **A replay cannot measure a change that alters which questions are asked.** Replaying
  `--question-refutations` reported 0 reversals where a live run reversed 2 of 2: the
  recorded log holds answers only to questions the old code asked, so a newly reached
  proposition replays as neutral. The test: does the change alter the set
  `questionsAsked()` returns? If so, measure live.
- **A rule enforced at one layer can be overruled at the next.** The circularity rule
  downgrades a miss the change itself caused from `refuted` to `unsettled`, and rung 3
  then established the proposition at 0.97, yet the chain still came out `refuted`,
  because `composeChain` read any symbolic miss in the evidence array as a refutation.
  The evidence is now dropped on downgrade and the check reported as a limitation.
- **Self-refuting propositions.** The model states a proposition about data shape
  ("the account object has an ownerId property") and scopes its check to the changed
  function's body, where the defect it reports guarantees the pattern is absent. The
  grep misses and a true finding becomes a confident denial. No deterministic detector
  is known: the check is well formed and only its placement is wrong.
- **A claim's type is not verified against its subject.** The control run emitted 9
  claims about documentation typed as code defects and confirmed 6, because as
  statements about the text they were true. Claims located in prose are now rejected at
  emission (`PROSE` in `src/claim.ts`).
- **`body_contains` did not mean the body.** `bodyOf` included the declaration line, so
  "actorId is not referenced in the function body" (true, and the sharpest statement of
  the defect) was refuted by the parameter list. The invariant is now tested:
  `declaration_contains` reads the signature, `body_contains` reads everything under it,
  and the two do not overlap. A definition with nothing indented under it is its own
  body.
- **A cheaper rung can be wrong.** Rung 1 refuted and rung 3 answered 0.92 that the
  proposition held, and rung 3 was right. Determinism means the same answer every time,
  not the right one. Across 31 runs, all 20 correct claims that did not ship were
  settleable by an existing rung; ten now ship from the state and `bodyOf` fixes.
- In the one ablation measured, rung 3 changed no claim's selection; it raised the
  surviving finding to high confidence. Treat it as escalation, not filtering.

### Asking a rung the question it can answer

Three findings were the same rule broken three ways, each costing the correct finding:

- *Material it was sent:* the rung-3 state carried only the claim's own file.
- *A question it can answer:* `body_contains` searched the declaration line.
- *A revision it was told:* a proposition naming no side is true at head and false at
  base. Rung 1 ran at head; rung 3, handed both sides, answered for base. Neither rung
  was wrong; they answered different questions.

The revision is now a field on the proposition, resolved once by `propositionSide` in
`src/claim.ts` and used by every rung. The first attempt named the revision in the
question ("judge this at the head revision") and made things worse: contradicted checks
went from 1 in 52 propositions to 8 in 94, and three wordings suppressed the finding
identically. Sending only the revision the question is about scored 6 of 7, against 4
for both sides and 3 for both sides with a qualifier. A claim with propositions on both
sides now takes two rung-3 calls, each carrying half the source.

## 2026-09-21: the first Martian cases

Five development cases, one per project (005 cal.com, 016 discourse, 023 grafana, 032
keycloak, 046 sentry), 12 golden comments, DeepSeek v3.2, one run each, $0.37 in total.

- Six findings shipped, none matching a golden comment.
- **The emitter found one golden comment and the verifier refuted it.** The check
  searched a symbol declared more times in the monorepo than the search returns; the
  search truncated before reaching the right declaration and reported a miss. A
  truncated search with no match now returns inconclusive for `expect: 'present'` and
  `declaration_contains`, as it already did for `expect: 'absent'`.
- **Duplicates were a bug.** `record_claim` deduplicated on the whole draft, so the same
  assertion with different checks counted as a new claim, and one case hit the turn
  limit after recording one claim seven times. A claim's fingerprint is now its type,
  location, description and suspected condition; the first record keeps its checks.
- Larger cases need larger budgets; `profiles/martian-deepseek.json` exists for them so
  that `baseline-deepseek.json`, which earlier demo numbers were measured with, stays
  fixed.

### Five cases, three repeats

15 runs, $2.28. **7 of 12 golden comments were found at least once** (after the hand
counts were corrected, below), but most appeared in a single repeat, so one run per case
would have reported anywhere from 2 to 5 of 12. **Repeats are not optional on this
benchmark.**

**The verifier barely filtered: 105 claims emitted, 65 shipped.** On a noisy claim every
proposition restates the diff ("had margin-top at base", "does not at head"), which the
checking pass confirms because the diff says so, while the claim's actual assertion is
never tested. Three cheap filters were measured on the recorded runs and rejected:
dropping hedged wording removed 33 of 58 findings including a real one; merging
same-type same-location claims removed 6 of 58; requiring a check outside the changed
files missed symbol-scoped evidence and scored real findings like noise.

### Raising precision, and what it cost

Three sets of 15 runs on the same frozen cases, $7.40 in total.

| | baseline | emitter change | + symbol fixes |
| --- | --- | --- | --- |
| golden found at least once | 7 of 12 | 5 of 12 | 4 of 12 |
| emitted / shipped | 105 / 65 | 76 / 42 | 69 / 43 |
| stopped on the token cap | 4 | 4 | 8 |

- **True and false positives ship for the same reason**: their propositions test the
  diff. That is why no verification-time filter separates them.
- **Asking the emitter to filter itself** (a claim needs a proposition about something
  the change did not touch) cut shipped findings by a third and cost recall; reverted.
- **Two rung-1 bugs.** `Class.method` never resolved, because that string is not in the
  source; it is now looked up through the owner's declaration. `declaration_contains`
  read one line, so a wrapped parameter list hid the parameter and refuted a correct
  claim; the signature is now read to the end of its parameter list. One repeat went
  from 0 of 7 claims shipped to 6 of 6.
- **The rung-1 fixes were checked deterministically.** Re-settling every recorded
  proposition of the 15 baseline runs against the same snapshots: no established
  proposition became refuted, 7 unsettled ones settled, 14 that needed a rung-3 call
  became free, 1 wrong refutation became established, and 17 refutations weakened to
  unsettled, the safe direction.
- **Two operational fixes.** A run whose rung-3 calls all failed produced inconclusive
  claims silently; `claim-run` now reports how many claims the rung never reached. And
  the input token cap, which stopped a third to a half of runs on larger cases, now drops
  the oldest whole turns instead of ending the run: recorded claims live outside the
  transcript, so trimming costs only reading. In the next 15 runs none stopped on the cap.
- **`--question-conclusion` asks rung 3 whether the claim itself holds** before a claim
  with every proposition established ships. Isolated by replaying the same runs with the
  gate off, it withheld 5 of 41 claims, and one of the five was a golden comment word for
  word (a duplicated `-ms-align-items` property), with two more genuine defects. **Asking
  a model whether a claim holds selects for confident phrasing, not correctness**: a
  speculative claim is a true description of the diff and is affirmed, while a precise
  claim that turns on outside knowledge draws a hedge. It stays off. It earns a default
  only when a run set shows it withholding wrong claims and no golden ones.

### What separates a real finding from noise

Computed from 60 recorded runs, no spend.

- Every structural property is flat between the 13 golden-matching findings and the
  other 52: which rung settled them (23% against 25% all-grep), proposition count (3.11
  against 2.86), whether evidence leaves the claim's file, whether propositions span
  base and head. Two run backwards: golden claims name fewer distinct check subjects
  and more often carry a mirrored check. Filters built on reach do not work.
- The one property pointing the right way is the **corrective form**: every golden
  comment says "X should be Y", the noise says "X, which may cause Y". Claims naming a
  specific alternative: 3 of 13 golden against 1 of 52 noise, about 6% of shipped
  findings in every run set. As a filter it would keep 4 of 65 claims (23% recall), so it
  was treated as headroom, and a later entry tests it as a required field.

### What the 65 shipped findings are

Every finding the 15 baseline runs shipped, read and classified, four verified against
the frozen snapshots.

| | count | of 65 |
| --- | --- | --- |
| matched a human comment | 13 | 20% |
| verified real, no human comment | 4 | 6% |
| plausible, unverified | 17 | 26% |
| restates the change | 7 | 11% |
| speculation about a consequence | 21 | 32% |
| overstated | 3 | 5% |

- Noise concentrates where there is least to find: 15 of the 21 speculative findings are
  on case-016, a stylistic CSS change with nothing falsifiable to say.
- Three P1 signature mismatches on case-046, first cited as real bugs no human
  commented on, are all overstated on inspection: the parameter has a default, or the
  implementation takes `**kwargs`.
- The verified findings each name a concrete second thing the code disagrees with; the
  speculative ones name a consequence with nothing to point at.

### How the benchmark scores, and severity

- The grader (`benchmarks/martian-grade.py`) extracts findings, deduplicates them and
  judges them against the human comments. **There is no "is this actually a bug"
  oracle**, so a correct finding no human commented on scores as a false positive. 13 of
  65 is close to the real precision, about 20% against the 70% ship bar.
- Against the benchmark's own severity labels, nothing above Medium was missed:

  | | Critical | High | Medium | Low |
  | --- | --- | --- | --- | --- |
  | caught | 1 of 1 | 2 of 2 | 2 of 4 | 2 of 5 |
  | missed | 0 | 0 | 2 | 3 |

- So the criterion to optimize is noise, sharply stated: **emit nothing that would ask for
  an incorrect change.** About 24 of the 65 shipped findings would.

## 2026-09-22: could the reviewer express the human comments?

Each of the 12 golden comments was written by hand as a claim in the current schema with
real checks (`benchmarks/twelve-claims.mjs`) and run against the frozen snapshots.

- **24 of 25 propositions settle on rung 1, and 11 of 12 claims would ship on grep
  alone.** Neither the schema nor the check vocabulary is the ceiling. The exception is
  positional ("this branch of the `OR` carries no `method` filter"), which literal search
  cannot ask and rung 3 must.
- **A check is only as good as the distinctiveness of its pattern.** Two of the three
  initial failures were patterns: a stylesheet built on `@include flexbox()` does not
  contain `display: flex`, and a common word truncates the search in a large tree.
- **Bug fixed:** `file_contains` searched the whole repository and filtered by path
  afterwards, so a pattern common elsewhere spent the 50-match cap before reaching the
  file. `searchSource` now takes a pathspec.

### The emitter prompt: rewritten, reverted, re-applied, measured, reverted

`claimInstructions` told the model to "emit widely" because "verification kills a wrong
claim before any user sees it". Measured, that premise was false (105 emitted, 65
shipped). A rewrite stated what verification does and does not do, refused consequence
language, required one proposition naming what the code should have carried, and asked
for distinctive patterns.

| | baseline r1+r2 | rewritten prompt |
| --- | --- | --- |
| runs | 10 | 8 |
| emitted / shipped | 83 / 47 | 23 / 8 |
| golden comments found | 7 of 12 | 2 of 12 |
| shipped naming a replacement | 13% | 0% |

It failed its pre-registered pass rule (golden recall holding at 7 of 12) and was
reverted. The central instruction did not take at all: asked to name a replacement, the
model emitted less of everything instead. **Three changes measured as one cannot be
attributed**; a change to what the emitter is told is never a small change.

**Golden matching was then automated** (`benchmarks/golden-matcher.mjs`,
`benchmarks/score-runs.mjs`): a claim matches when it is in the comment's file and names
what the comment says is wrong, even if it predicts a different consequence. It agreed
with 13 of 13 hand labels and corrected three hand counts in two days, in both
directions. **Per-run golden found had an SD of 0.70 around a mean of 0.73**, so a 15-run
set cannot separate reviewers that differ by less than about 0.5 golden per run. None of
the set-to-set differences above is statistically distinguishable; experiments are sized
from this spread.

**All 397 claims on disk were then labelled.** The verifier shipped overstated claims at
the same rate as real ones (48%) and restatements most of all (74%); 55% of everything
shipped was harmful. On those labels the rewrite looked like it cut harmful findings
from 2.9 to 0.13 per run, so the maintainers re-applied it.

**Measured properly, it did not hold.** Pre-registered, 40 runs per arm differing only in
`claimInstructions`, labelled blind (second labeller on 25%, kappa 0.71): harmful per run
2.30 to 1.40 (p = 0.034), acceptable 1.25 to 0.65 (p = 0.021), harmful 57% of what ships
in both arms. The rewrite shrank everything by the same fraction and lost the one
Critical and one High comment. The 0.13 figure came from 8 unblinded runs. The
maintainers reverted to the original prompt. **Size and blind before believing an
effect, including a favourable one.**

## 2026-09-23: benches, P3, and the "should be" field

**Test small first.** Every idea now goes through a bench before it earns a sized, blind
end-to-end run.

- **Verifier bench** (`benchmarks/verifier-bench.mjs`): 657 labelled claims with the five
  case snapshots, re-verified with the current build and rung 3 replayed, in about 90
  seconds at no cost. It reproduces all 260 recorded verdicts of the blind runs. It
  showed the verifier shipping G 78%, R 74%, S 85%, X 75%, O 73%: it was not selecting.
- **Emission bench** (`benchmarks/emission-bench.mjs`): freezes one run's reading and
  re-asks only the claim writing, about $0.05 a sample against $0.17 a run. Its level
  matches full runs, but golden found per sample has SD 0.55 against 0.58: most of the
  spread is in the writing, not the reading. Temperature 0 does not steady it.
- **Other models.** A `claude-local` provider runs Claude through the Claude Code CLI for
  benchmarking (`src/models/claude-cli.ts`). The child CLI must see nothing but the
  prompt: started from the repository it received about 8.6k tokens of hidden context,
  including this repository's notes, which hold benchmark answers. It now runs in an
  empty directory with settings sources off. Model comparisons otherwise run through
  OpenRouter.

**Withholding P3.** Agreement across repeats does not separate real from noise (harmful
share flat at 57 to 67% whether a claim recurs in 1 run or 4), and no claim type is pure
noise. **Not showing P3 does separate:** over 80 blind runs, harmful per run 1.85 to
0.96, acceptable 0.95 to 0.79, distinct golden comments unchanged at 8. It uses the
model's own severity, so it is a display rule rather than an after-the-fact judgement.
Shipped: a confirmed claim at a withheld severity gets verdict `withheld`
(`DEFAULT_WITHHOLD = ['P3']` in `src/lifecycle.ts`), is listed by location, and
`--show-minor` restores it. The verifier bench passes `withhold: []` so it still measures
verification alone.

**The checked "should be" field stays off.** Pre-registered, 40 emission samples per arm,
blind labels (kappa 0.53): a required `shouldBe` replacement on each claim
(`requireCorrection`) moved harmful per sample from 1.20 to 1.15 (p = 0.43). The model
filled the field with code 59 times out of 64, and those claims were harmful at the same
rate as others. The corrective form was a correlate, not a cause: a model names a
replacement line for a speculative claim as easily as it names the claim. Seven
emission-side and verification-side mechanisms have now been measured; only withholding
P3 moved harm.

## 2026-09-24: changing the model that writes claims

**Emission bench.** Pre-registered, 40 samples per arm over the same 10 frozen DeepSeek
readings, `profiles/martian-luna-openrouter.json` (GPT-6 Luna) against
`martian-deepseek.json`, same prompt, tools and verifier, blind labels (kappa 0.88):
harmful per sample 1.13 to 0.07 (p < 0.001), golden 0.28 to 0.38 (not significant),
acceptable 0.85 to 0.42, the drop entirely in R findings. Of what Luna shipped, 75%
matched a human comment and 85% was acceptable. The maintainers adopted Luna as the
default emitter for benchmark runs.

**Full runs.** Pre-registered, 40 Luna runs against the 40 DeepSeek runs, blind labels
(kappa 0.71): harmful per run 1.15 to 0.03 (p < 0.001), golden 0.35 to 0.30 (p = 0.73),
acceptable 0.90 to 0.47 (p = 0.051), again entirely R. Luna shipped 20 findings in 40
runs, 95% acceptable; DeepSeek shipped 94, 49% harmful. Luna found fewer distinct golden
comments at least once (3 against 6); this is inside per-run noise and stays reported.
Luna read slightly more and recorded a quarter as much, and every run finished.

**All 15 development cases.** Golden-matching rules for the 29 new comments were written
before any output was read (`benchmarks/golden-rules-check.mjs` checks that each comment
matches its own rule). Over 15 cases and 8 runs each: harmful 0.07 per run, 185 shipped,
89% acceptable, 5% harmful, 39% golden, 14 of 41 golden comments found at least once.
By the benchmark's golden-only scoring that is 39% against the 70% bar; the gap is 92
real findings no human wrote down. One "Critical recursion" comment (032[0]) is not a
recursion on inspection, and declining to report it is correct. Schema rejections of
`record_claim` were the model omitting `severity`; rejected tool calls now record the
failing schema paths (`toolErrors[].detail`) without changing what the model sees.

## 2026-09-24: the worker runs the claim pipeline

Until then the GitHub worker and the `review` command ran the older single-pass engine,
so no benchmark number described what users received. They now call
`runClaimReviewAsResult` (`src/claim-result.ts`), which writes `result.json` and
`receipt.json` in the shapes publication already reads.

- A confirmed claim becomes a finding wherever its line exists at head, including an
  unchanged caller the change broke; evidence validation requires only a head-side
  anchor. Withheld P3 claims become a limitation listing their locations.
- Coverage is `reviewed` for every changed text file only when the run finished; a run
  that stopped claims none. Receipt spend is metered only on a finished run.
- Rung 3 runs when `TYPESAFE_API_KEY` is set; otherwise the result says the rung was off.
- **Titles** come from one model call after verification (`src/titles.ts`). Only
  confirmed claims are sent, so titles cannot change what is found or rated, and they
  are carried to the next incremental review so a push with nothing new calls no model.
- **The diff limit is 512 KB** (`MAX_DIFF_BYTES` in `src/claim-run.ts`). 128 KB refused
  29% of merged PRs in a large production monorepo; 512 KB refuses 7%. The OpenRouter
  adapter counts serialized bytes, and a diff costs about 1.2 times its size, so the
  production profile `profiles/review-luna-openrouter.json` raises `maxInputTokens` to
  1,000,000, under the model's 1.05M-token window; the benchmark profile keeps the cap it
  was measured with. Larger diffs are now reviewed in parts that share one budget.

## 2026-09-24: incremental review and auto-pause

Re-reviewing the whole PR on every push was the largest cost and noise lever identified
in a study of another review product's documentation
([coderabbit-lessons-2026-09-24.md](coderabbit-lessons-2026-09-24.md)).

- **A push gets an incremental review.** The last completed review's confirmed and
  withheld claims are kept; when the merge base is unchanged and the earlier head is an
  ancestor of the new one, the model is sent the diff between the two heads plus a scope
  note, and verification still runs head against merge base. Carried claims are
  re-verified with the new ones.
- **A carried claim does not survive a change to its own files.** On a real fix push the
  fix put a read-then-delete under a lock; every recorded proposition stayed true, so
  re-verifying confirmed the fixed race again. A carried claim whose file, or a file its
  checks name, the push changed is now handed back to the model as an earlier finding and
  survives only if recorded again (`touchedBy` in `src/claim-run.ts`). A fix in a file the
  claim never names still escapes this.
- **Auto-pause.** After `AUTO_PAUSE_AFTER` (5) distinct reviewed heads since the last
  `/atmin review`, automatic reviews stop and the summary keeps the last review.
- **Cost.** On a benchmark case split into two pushes, the incremental review found the
  same golden comment as a full review of the same head and correctly refuted 5 of 7
  carried claims the second push had fixed; on a 20 KB diff it was not cheaper, because
  most spend is reading files. On five larger private PRs a push review cost $0.011 on
  average against $0.108 for a full review of the same head.
- **Pushes to the target branch start nothing** (since 2026-10-07). Re-reviewing every
  open PR whenever the target branch moved billed unchanged PRs several times a day on a
  busy repository. Reviews compare only head, target branch name, state and draft
  (`same` in `src/github/worker.ts`, `compareCurrent` in `src/snapshot.ts`); merging the
  target branch into a PR is a PR push and is reviewed.

## 2026-09-24 to 2026-09-25: private repositories, guidance and failure paths

- **First private-repository pilot.** The 10 most recent merged PRs of a private
  repository (8 to 444 KB of diff), Luna with rung 3: all finished; 4 findings shipped
  across 3 PRs, each checked against the code: 1 real and worth fixing, 2 real but rated
  too high, 1 overstated. The run exposed that body checks could not read TypeScript with
  wrapped signatures, which was fixed.
- **Repository guidance.** The claim pass now receives the target repository's
  `AGENTS.md` files, read from the target branch and never from the change, capped at
  32 KB shallowest first. On one PR, three runs each way: guided runs shipped a finding 3
  of 3 times against 1 of 3, and cost about 30% more. That is n = 3, not a result.
- **Failure paths.** A defect class the main pass missed: new code that is right locally
  but wrong once it reaches unchanged code downstream (plain errors reaching a catch-all
  mapper that reports a vendor outage). Putting the bodies of called, unchanged functions
  in context (`src/callees.ts`) did not find it in 3 runs. A second pass that looks only
  at failure paths found it in both runs that finished; on the five labelled cases it
  added 4 claims, shipped 2 and no harmful one. It is shown only the diff within 20 lines
  of error handling (`src/failure-excerpt.ts`) and does not run when a change has none,
  which on that PR cut its cost by about a quarter; the provider cached none of the
  repeated input.
- **What rung 3 is shown.** The finding still did not ship: rung 3 saw a 200-line window
  around the claim and the mapper was 700 lines further down, so it contradicted a fact
  grep had established. Rung 3 now also gets a window at each declaration a check reads in
  the claim's own file, and at another file's declaration when it is the symbol's only
  one. Windows at declarations in any file failed their pre-registered rule (3 of 40
  sampled real claims stopped shipping) and were not adopted.

## 2026-10-08: inline findings are posted once per PR

Before posting, the worker lists the PR's review comments and skips any finding whose
`atmin-finding` marker a bot comment already carries (same path and title, any head);
the summary still lists it. Over two days on a busy repository, 27 of 99 inline comments
had been repeats, one finding posted five times on one commit. A reworded title on a
later head is not caught.
