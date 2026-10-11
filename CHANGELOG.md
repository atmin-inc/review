# Changelog

## Unreleased

- Changes on `main` since 0.1.0-alpha.4 ship with the next version bump; see the git log.

## 0.1.0-alpha.4 — 2026-10-03

- When two passes confirm the same defect on one line, show it once, at the higher priority.
- The claim writer is given the P0–P4 priority rubric.
- Releases are published from CI: npm with trusted publishing, plus the Homebrew tap.

## 0.1.0-alpha.3 — 2026-10-02

- `review` runs the claim pipeline the GitHub worker publishes (GPT-6 Luna profiles).
- `atmin-code-review-runner`: review PRs on your own machine and model account.
- The `atmin` dispatcher package (`@atmin.ai/cli`): `atmin <tool>` runs `atmin-<tool>`.
- The GitHub worker gains a dashboard, per-installation plans and optional Stripe billing.

## 0.1.0-alpha.2 — 2026-09-10

- Publish under the domain-matching npm scope `@atmin.ai/review`.
- Update installation instructions and verify the renamed package archive.
- Review behavior is unchanged from alpha.1.

## 0.1.0-alpha.1 — 2026-09-10

- Immutable PR capture and bounded source investigation.
- Clear source verdict, severity counts and expandable evidence.
- Optional trusted GitHub check evidence on the exact reviewed commit.
- Durable GitHub App jobs, cancellation, reruns and reconciliation.
- One-command review CLI and standalone installation verification.

Experimental source-only release. No repository execution or paid hosted service.
