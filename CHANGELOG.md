# Changelog

## Unreleased

- Engine r02-28: optional `repository-state.json` context with exact-commit
  freshness, path-based section selection and verified evidence references;
  `atmin-review build-state` builds it with receipts; `withdraw_finding` retracts
  a disproved candidate and retains the reason. Benchmark scripts and a
  predeclared protocol for the paired repository-state comparison; not yet run.

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
