# RepositoryState v1

**Status:** Implemented as a local experiment in engine r02-28, September 17,
2026. Not yet measured; see the
[predeclared protocol](../benchmarks/repository-state-protocol.md).

This is the smallest slice of the
[repository-state direction](./repository-state-direction.md): a versioned,
evidence-referenced description of one target branch at one exact commit, a
model-driven builder that produces it with the review engine's own source
tools and receipts, controller-side selection of the sections relevant to a
pull request, and an explicit withdrawal operation for disproved candidates.

## Artifact

`repository-state.json` is a closed JSON object validated by
`src/repository-state.ts`:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`. |
| `repository`, `branch`, `commit` | The exact tracked branch commit the state describes. |
| `generator` | Name and version of what produced it (`atmin review state builder`, `r02-28`). |
| `createdAt` | Build start time. |
| `complete`, `limitations` | The builder's own honesty flags: `false` plus reasons when exploration was cut short. |
| `sections[]` | At most 60 sections, unique IDs. |

Each section records `kind`, `title`, a `summary` of at most 2,000 characters,
`paths` (directory or file prefixes it applies to; empty means repository-wide),
one to ten `evidence` references (`path` plus `line` or `null` for the whole
file) and `basis`: `observed` when the source or its documentation states the
fact, `inferred` when the generator concluded it from code.

Section kinds follow the handoff list: `purpose`, `subsystem`, `flow`,
`contract`, `convention`, `commands`, `deployment`, `baseline-risk` and
`fragile-area`.

[`repository-state-example.json`](./repository-state-example.json) is a
hand-authored prototype for this repository at the handoff commit
(`generator: manual`, `complete: false`), used as a worked example and a test
fixture. It is not builder output.

## Rules the controller enforces

- **State is context, not evidence.** The controller supplies selected sections
  inside the frozen review context with a fixed guidance sentence. Findings
  still require controller-captured `read_file` evidence at the reviewed
  revisions; citing a section ID is rejected exactly like any other unknown
  evidence reference.
- **Freshness is the exact target commit.** State whose `repository` or
  `commit` differs from the packet's `baseSha` is withheld: the context carries
  only `status: stale` and a reason, and the review records the same reason as
  a limitation. A newer branch summary is never substituted.
- **Selection is by changed path.** A section applies when it is
  repository-wide or one of its `paths` prefixes a changed file. Hunk
  clustering and relevance judgments are not part of this slice; a
  deterministic prefix rule keeps selection auditable.
- **Evidence must resolve.** Before the first model request, every evidence
  reference of a current state is checked against Git at the state commit. A
  missing path or out-of-range line fails the review closed before any
  spending, and the reason is retained in the receipt.
- **Absent state changes nothing.** Without `repository-state.json` the frozen
  context is byte-identical to a review without this feature, so one engine
  build serves both experiment arms and `contextHash` records which arm ran.
- **Size bounds.** The selected context is limited to 96 KB; the existing 1 MB
  conversation limit still applies.

The receipt records `repositoryState: { status, commit, sections }` or `null`.

## Building state

```
atmin-review build-state <snapshot-directory> --profile <profile.json> --out <new-directory>
```

The builder (`src/state-builder.ts`) explores the snapshot's target commit with
`list_files`, `read_file`, `search` and `search_repository`, records sections
with `record_section` and ends with `finish_state`. It shares the review
engine's discipline:

- A section's evidence must lie within ranges the build itself read; the
  controller rejects anything else.
- Every request is counted, reserved against the profile's budget and settled
  from provider usage. `repository-state.receipt.json` retains calls, tokens,
  tool calls, rejections and the stop reason, and a trace is written beside it.
- A build cut short by turns, tool calls, deadline or provider failure still
  yields an artifact with `complete: false` and the stop reason as its
  limitation, so a partial state is never mistaken for a full one.

Copy `repository-state.json` beside `packet.json` before `investigate` to
supply it. The build writes into a new directory so its trace and receipt never
collide with a later review of the same snapshot.

## Withdrawal

`withdraw_finding { id, reason }` removes a recorded finding during discovery
or assessment. The controller keeps `{ id, priority, reason, at }` in the
receipt's `withdrawals` for audit, and the tool is unavailable once reporting
starts so a final response cannot silently drop findings. The investigation
instructions ask the reviewer to withdraw a candidate when counterevidence
disproves it or shows it already exists at the merge base.

## Not in this slice

- Incremental update from one merge diff. The update path is a full rebuild
  with `build-state`; drift detection and section-level updates remain future
  work once a rebuild has a measured baseline cost.
- The structured disposition ledger and learned-rule promotion.
- Hosted GitHub App integration: the worker does not yet build, store or
  supply state.
- Hunk clustering, relevance judgments beyond path prefixes, and specialist
  agents.
- Syntax, type or base/head execution checks; these remain a separate factor.
