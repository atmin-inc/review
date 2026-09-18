# Human knowledge: <repository>

**Applies to:** `<branch>`
**Maintainer:** <name or team>
**Last reviewed:** <YYYY-MM-DD>

Fill in only what an agent cannot derive from reading the code.

This file is the thin replacement for the deferred RepositoryState v1 artifact.
See [claim-lifecycle-design-2026-09-17.md](./claim-lifecycle-design-2026-09-17.md),
section 1. It is advisory context. It never by itself supports a finding: a
finding must still cite exact reviewed source.

Keep it short. An entry that goes stale without anyone noticing is worse than no
entry. Delete rather than update in place when something stops being true.

## Invariants

Properties that must hold, which the code does not state. One line each, with a
source reference where one exists.

- <invariant> (`path/to/file.ts:LL`)

## Fragile areas

Places that have broken before, and what broke. History an agent cannot see.

- <area> — <what went wrong, and roughly when>

## Gotchas

Behavior that looks wrong and is deliberate, or looks fine and is not.

- <gotcha> — <why it is this way>

## Organization rules

Conventions a maintainer has stated. These apply immediately and skip the
candidate stage described in section 8 of the design doc. Record who set each one.

- <rule> — set by <who>, <YYYY-MM-DD>

## Accepted baseline risks

Known problems the team has decided not to fix yet. A claim that rediscovers one
of these should be dispositioned `pre-existing`, not reported as new.

- <risk> — accepted by <who>, <YYYY-MM-DD>
