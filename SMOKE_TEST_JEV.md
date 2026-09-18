# Jev smoke test: plumbing check

**Date:** September 17, 2026
**Model:** `jev-latest`, answered by `jev-1.13.0`
**Purpose:** Verify that the TypeSafe API, the typed schema and the cost model work
on our data. This is not the paired benchmark. Nothing is scored here.

## Scope and guardrails

This run did not score anything. It did not read any `goldenFile`. It did not
touch the 35 reserved Martian cases. It used 3 of the 15 development cases, and
spent no statistical power, because no result was compared to ground truth.

`TYPESAFE_API_KEY` loaded from env. Nothing was pushed. No branch was created.

## PRs selected, and why

All three come from the `development` split in
[`benchmarks/martian-development-split.json`](benchmarks/martian-development-split.json).
That file holds 50 cases: exactly 35 `reserved` and 15 `development`. Each PR was
picked as a calibration probe, not at random.

| Case | Pull request | Shape | Why this one |
| --- | --- | --- | --- |
| case-028 | [grafana/grafana#90939](https://github.com/grafana/grafana/pull/90939) | Go, +13/-3, 1 file | Smallest case. Negative control. Almost every check should stay low. |
| case-023 | [grafana/grafana#107534](https://github.com/grafana/grafana/pull/107534) | TypeScript, +48/-15, 4 files | Contains a `.test.ts` file. Positive control for `adds_tests`. |
| case-040 | [keycloak/keycloak#40940](https://github.com/keycloak/keycloak/pull/40940) | Java, +51/-11, 4 files | An identity product, but the changed lines are group caching. Tests whether `touches_auth` reads the diff or the repository's reputation. |

Three languages, three sizes, three different checks under test.

## API and schema

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
```

One request per PR. The `state` is a JSON object with a `pull_request` field
(title, description, file and line counts) and a `diff` field holding the raw
unified diff. The `questions` map holds 15 entries, evaluated in parallel against
that one state.

The schema is [`.smoke/jev-schema.json`](.smoke/jev-schema.json): 14 checks plus a
top-level verdict.

- **13 Noul checks.** `hardcoded_secret`, `sql_injection`, `touches_auth`,
  `weakens_tests`, `adds_tests`, `breaks_api`, `data_migration`,
  `description_matches`, `debug_leftovers`, `docs_only`, `merge_ready`, plus
  `error_handling_gap` and `dependency_change`, which this run added.
- **1 Score check.** `change_risk`, over 4 ordered levels from "no runtime risk"
  to "high risk".
- **1 Choice.** `verdict`, over `block`, `security_review`, `nits` and `merge`.

One deviation from the brief. The brief asked for Choice and Score types. The
docs make **Noul** the correct primitive for a yes/no check, so 13 of the 14
checks are Nouls. A Noul returns the probability of yes and carries no separate
confidence. Choice is for picking one option from a set, which fits `verdict`
alone.

## Results per PR

### case-028, grafana/grafana#90939

Verdict **merge**, confidence 0.35 (merge 0.52, nits 0.45, block 0.03).
`change_risk` 2.00 of 3, confidence 0.99. Latency 521 ms. Cost $0.000093.

Top three: `description_matches` 0.86, `debug_leftovers` 0.65, `merge_ready` 0.49.

`debug_leftovers` at 0.65 is correct. The diff adds the literal comment
`// TODO: get rid of global state`, and the criteria name TODO placeholders. The
hedge to 0.65 rather than 0.95 is arguably right too, because the TODO annotates
pre-existing global state rather than leftover instrumentation from this change.

### case-023, grafana/grafana#107534

Verdict **merge**, confidence 0.29 (merge 0.47, nits 0.43, block 0.10).
`change_risk` 1.85 of 3, confidence 0.84. Latency 476 ms. Cost $0.000158.

Top three: `adds_tests` 0.97, `description_matches` 0.87, `merge_ready` 0.41.

The positive control fired as intended.

### case-040, keycloak/keycloak#40940

Verdict **nits**, confidence 0.41 (nits 0.56, merge 0.25, block 0.19).
`change_risk` 2.00 of 3, confidence 1.00. Latency 456 ms. Cost $0.000136.

Top three: `adds_tests` 0.95, `description_matches` 0.64, `error_handling_gap` 0.46.

`adds_tests` is correct: the diff adds an `@Test` method to `GroupTest.java`.
`touches_auth` returned **0.08**. The probe passed. Jev judged the changed lines,
which are group caching, and did not inflate the answer because the repository is
an identity product.

## Aggregate

| Measure | Value |
| --- | ---: |
| Runs | 3 |
| Mean latency | 484 ms |
| Latency range | 456 to 521 ms |
| Mean input tokens | 3,068 |
| Mean cost per call | $0.000129 |
| Mean cost per PR | $0.000129 |
| Total spend | $0.000387 |

One call answers all 15 questions, so cost per call and cost per PR are the same
number. Output tokens were about 300 per call and are billed at zero. Only input
tokens are charged, at $42 per billion.

## Cost against Paolo's claim

**The claim does not hold on our data. Measured cost is 1.84x the claim.**

Paolo claims $0.00007 per PR. We measured $0.000129.

The gap is structural, not a rounding difference. At $42 per Btok, $0.00007 buys
1,667 input tokens for the whole PR. A direct measurement, sending the full
question set against a one-character state, puts the fixed cost of this schema at
**1,501 input tokens, or $0.000063 per call**. The schema alone consumes 90% of
the claimed per-PR budget and leaves 166 tokens for the diff, which is roughly ten
lines of code.

| Case | Total tokens | Schema | Diff | Schema share |
| --- | ---: | ---: | ---: | ---: |
| case-028 | 2,215 | 1,501 | 714 | 68% |
| case-023 | 3,752 | 1,501 | 2,251 | 40% |
| case-040 | 3,237 | 1,501 | 1,736 | 46% |

Two honest caveats. These are three of the smallest development cases, so 1.84x is
a floor, not a ceiling. And the claim may well be reachable with a leaner schema,
fewer checks or terser criteria. The claim is not reachable with *this* schema on a
real PR. Cost here is driven by prompt design, not by the model's price.

## Calibration sanity

Calibration looks sound. Two results that appeared to be false positives were
checked against the diffs and both were correct.

- **No spurious security firing.** `hardcoded_secret` sat at 0.02 to 0.03 and
  `sql_injection` at 0.02 to 0.03 across all three. `docs_only` held at 0.01
  everywhere, correctly, since none of the three is a documentation change.
  `data_migration` stayed at 0.03 to 0.05 and `dependency_change` at 0.05 to 0.07.
- **Positive controls fired.** `adds_tests` returned 0.97 and 0.95 where tests were
  added, and 0.04 on case-028, which adds none.
- **The auth probe passed.** See case-040 above.
- **Nothing was missed on the buggy side.** None of the three PRs carries an
  obvious defect of the kind the checks target, so this run cannot demonstrate
  recall. That is a limit of the sample, not a negative finding.

One genuine weakness, and it is ours rather than the model's:

**`merge_ready` carries almost no information.** It returned 0.49, 0.41 and 0.27,
clustered around 0.5. A Noul near 0.5 means the model finds yes and no about
equally likely. `verdict` confidence was correspondingly low at 0.29 to 0.41, and
in every case the mass split between `nits` and `merge` rather than landing
anywhere. The nits/merge boundary is genuinely fuzzy, and our criteria do not
separate it. `merge_ready` also duplicates `verdict`, which was retained
deliberately as a consistency probe. Both need rework before any threshold is
tuned on them. The concrete factual checks are sharp; the summary judgments are not.

## Failures and gotchas

1. **Auth returns 403, not the documented 401.** An unauthenticated POST returns
   `403`. The docs error table lists `401 Unauthorized` for a missing or invalid
   key. Any error handling written against the documented table will miss this.
2. **The skill names no environment variable.** `SKILL.md` is a pointer to the live
   docs rather than a self-contained spec. The variable name `TYPESAFE_API_KEY`
   comes from the Python SDK constants page, not from the skill.
3. **The brief's primitive choice was wrong.** Corrected to Noul, as described above.
4. **The plugin marketplace path was not exercised.** This run read the raw
   `SKILL.md` and the live docs directly. `claude plugin marketplace add` remains
   untested.
5. **No rate limiting and no retries.** All three calls succeeded on the first
   attempt. Published limits are 1,200 requests per minute and 250,000 tokens per
   second, which are far above anything this workload needs.
6. **Context budget is a risk for the full set.** The cap is 64k tokens per request
   and 32k for the state plus the longest question. These three diffs are small.
   case-050 is +1,276 lines and case-015 is +653 over 28 files. Both need a token
   estimate before they are sent, and the harness needs a truncation or chunking
   policy.

## Recommendation

**The plumbing is ready for the full paired benchmark. Fix two things first.**

What is proven: authentication works, the request and response contracts match the
docs, all 15 questions return typed answers in a single call, latency is about
half a second, usage accounting is present, and the factual checks are well
calibrated on three languages.

Two changes before the benchmark runs:

1. **Rework `merge_ready` and `verdict`, or drop `merge_ready`.** Both produce
   near-coin-flip output today. Do not tune a threshold on them in their current
   form. The factual checks need no change.
2. **Add a token pre-check and a truncation policy.** Needed before case-050 and
   case-015 are sent, so a context overflow fails loudly rather than silently
   truncating a diff.

One optional change. If cost parity with Paolo's number matters to the comparison,
tighten the criteria prose first. The schema, not the model, is 40% to 68% of the
bill. If it does not matter, note that the absolute cost is negligible: the full
15-case development split costs roughly $0.002 per pass at this schema size.

Finally, treat the cost claim as **not reproduced** in any writeup. Report the
measured $0.000129 with the schema size that produced it.

## Artifacts

Raw request, raw response and a per-run record with latency, usage and computed
cost are saved under `.smoke/jev/<case>/`. Aggregates are in
`.smoke/jev/summary.json`. The runner is `.smoke/run-jev-smoke.py`. `.smoke/`
ignores itself, so none of it is tracked.
