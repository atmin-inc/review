# What CodeRabbit's docs teach us (2026-09-24)

23 pages of https://docs.coderabbit.ai read. Page summaries came through a fetch tool, so
quotes are close but not guaranteed verbatim. [inferred] marks what the docs do not say.

## Ranked by what it would change for us

1. **Incremental review on new pushes, and auto-pause.** CodeRabbit reviews a PR in full once,
   then reviews only the newly added changes on each push. It pauses automatic reviews after
   5 reviewed commits. `@coderabbitai full review` forces a full pass.
   (https://docs.coderabbit.ai/configuration/auto-review.md)
   *Us:* we re-review the whole PR on every push. mason-v1 PRs average up to 6 commits, so
   this is the biggest cost lever we have. It is also a noise lever, because a full re-review
   re-emits findings the author has already seen.
2. **Skip rules.** Drafts are skipped by default. Reviews can also be skipped by base-branch
   regex, labels, title keywords and bot usernames (`ignore_usernames`), or paused with a
   pause/resume command. (same page; https://docs.coderabbit.ai/reference/review-commands.md)
   *Us:* we skip drafts only. About a fifth of mason's last 100 PRs come from bots or agents
   (mason-engineer-dev, masonsuper, claude[bot], devin).
3. **Per-repository config file** (`.coderabbit.yaml`, read from the PR branch).
   - `path_filters` are globs; exclusions win.
   - `path_instructions` add review guidance per glob.
   - `profile` is quiet, chill or assertive. Quiet posts only critical and major
     high-impact comments.
   - Source: https://docs.coderabbit.ai/configuration/path-instructions.md
   *Us:* withholding P3 is our version of chill. There is nothing per-repository yet.
4. **Default path filters.** Lockfiles, dist, node_modules, generated code, minified files,
   maps, binaries and media are skipped by default.
   *Us, measured on mason:* lockfiles and generated files are only 3% of the bytes in its
   large diffs. Docs are 32% and data JSON 16%. So default filters would barely move mason's
   size problem. Skipping docs would, and our verifier already rejects claims located in prose.
5. **Learnings.** A reply to a review comment can become a stored rule. Rules are scoped to
   the PR until it merges, then to the repository or organisation. The relevant ones load
   before each comment. (https://docs.coderabbit.ai/knowledge-base/learnings.md)
   *Us:* this is the human-disposition ledger, step M5 of our plan, not yet built.
6. **Reads the repository's own agent instructions**: AGENTS.md, CLAUDE.md, .cursorrules and
   similar, up to 50 files. (https://docs.coderabbit.ai/knowledge-base/code-guidelines.md)
   *Us:* cheap context for real repos. It must be off for benchmark repos, because our own
   AGENTS.md holds the benchmark answers.
7. **Limits are soft on merge.** A rate-limited review posts a passing "Review rate limited"
   check, so it never blocks a merge. The size cap is 150 or 300 files by plan. Above it the
   automatic review is skipped, with a paid on-demand option.
   (https://docs.coderabbit.ai/management/plans.md,
   https://docs.coderabbit.ai/management/rate-limits.md)
   *Us:* a PR over our diff limit gets "review failed". A clear "too large, not reviewed"
   neutral check would be more honest.

## Worth knowing, lower priority

- Pre-merge checks are natural-language rules at off, warning or error; the docs advise
  starting at warning.
- More than 50 linters and SAST tools run in a sandbox, using the repository's own configs.
- The walkthrough comment includes a 1-5 review-effort score and sequence diagrams.
  Slop detection flags low-quality AI PRs.
- The architecture page lists a separate verification agent but gives no mechanism
  [inferred: the closest thing to our verifier].

## Where we are ahead [inferred from what their docs do not say]

The docs describe no measured precision, no stated falsifiability of findings, and no
verifier mechanism. Our shipped findings are checked against the frozen revision and the
precision is measured blind.
