# Rung 3, answered by Jev

`src/jev.ts` answers the cross-family rung with Jev over the TypeSafe API. Two things
about it are worth knowing before it is trusted.

## Asking is its own phase

`CrossFamilyRung.settle` is synchronous and an HTTP call is not. That is not an
oversight in the interface: verification is deterministic and free, and that is
precisely what lets `claim-ablate` verify the same claims again with the rung switched
off and read the difference exactly rather than as a second noisy sample.

So the adapter asks first and the verifier replays. `questionsAsked` runs verification
once with a rung that records what it is asked and answers nothing, which yields
exactly the questions the real rung would face — including the rule that a
symbolically refuted claim is never carried to a later rung — without restating that
rule anywhere. `askJev` then makes one call per surviving claim, because Jev evaluates
many questions against one state, and returns a log `recordedRung` replays.

A claim whose call fails is skipped, not answered. A rung that cannot reach a
proposition returns nothing, which the lifecycle already reads as unsettled. A rejected
key is the exception: it throws, because a whole review with every rung-3 question
silently unanswered looks like a review where the model had nothing to add.

## The wire format is unverified

`SMOKE_TEST_JEV.md` records the endpoint (`POST https://api.typesafe.ai/v1/systemone`),
the `Authorization: Bearer` header, that `state` is a JSON object, that `questions` is a
map evaluated in parallel against that one state, and that a Noul returns the
probability of yes and carries no separate confidence. It does not record the field
names of the request body or of the response, and `.smoke/jev-schema.json` is not in
this repository.

`jevRequest` and `jevAnswers` are this adapter's assumption about those names, and
nothing else in the codebase depends on them. The assumed response is:

```json
{ "answers": { "p0": { "probability": 0.94 } } }
```

`jevAnswers` parses strictly and throws on anything else, rather than hunting for a
number somewhere in the body. A wrong probability here decides whether claims ship, so
an unrecognized shape must stop the run and not be coerced into one. The first live
call either confirms these two functions or corrects them, and it corrects nothing
else.

## What the model is told

The state carries the claim's type and location, a window of the changed file on both
sides, and the diff. It deliberately omits the claim's `description` and
`suspectedCondition`.

Those are what the investigator concluded, and rung 3 exists to settle the steps of the
argument independently of the conclusion. Sending them invites the model to agree with
the claim rather than judge the code, which is the failure `SMOKE_TEST_JEV.md` already
found in the composite questions: the factual checks were sharp and the summary
judgments sat at a coin flip. The claim's location stays because a proposition like
"no ownership comparison remains in the function body" is unanswerable without knowing
which body.

This is a judgment call, not a measured result. `settle(proposition, claim)` hands the
whole claim to the rung, so an adapter is free to send more; whether withholding the
conclusion helps or hurts is something `claim-ablate` can eventually answer.

## Running it

```
atmin-review claim-review <pr-url|directory> --profile <profile.json> --cross-family jev
atmin-review claim-ablate <directory>
```

`TYPESAFE_API_KEY` must be set. Without `--cross-family jev` the rung stays silent and
no claim reaches high confidence through agreement, which is what every run before this
one did.
