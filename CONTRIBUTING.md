# Contributing

Use Node 24+, run `npm ci` and `npm test`, and include a focused regression for
behavior changes. Keep source review separate from repository execution and
preserve bounded spending, credential separation and honest incomplete verdicts.

Open pull requests against `main`. Merges to `main` deploy the maintainers' hosted
service, so a maintainer reviews every change before it lands. [AGENTS.md](AGENTS.md)
explains how to build, test and run the project and how it is laid out.
[docs/research-log.md](docs/research-log.md) holds the measurements and design decisions
behind the current behavior; read the section for the area you are changing first.

## Code comments

- A comment says what the code does and why, in present tense, and stays true as long
  as the code does. History belongs in commit messages, not comments.
- No dates, people's names, one-off run results, internal paths, or references to
  private repositories or customers. When a measurement is the real reason for a
  constant or a design, state the reason in timeless form: "512 KB admits about 93% of
  pull requests in a large production monorepo", not "measured on 2026-09-24".
- Keep comments that carry reasoning a maintainer needs: invariants, security
  boundaries, why a simpler approach fails. Keep them short. Delete comments that only
  restate the code.
- Exported functions, classes and types get a short JSDoc (`/** ... */`) when their
  contract is not obvious from the name and types. No boilerplate docs.
- No commented-out code. No TODO without a concrete description of what is missing.
- Test names describe the behavior; test comments explain why the behavior matters.

## Security and licensing

Report security problems privately as described in [SECURITY.md](SECURITY.md), not
in an issue. Never paste credentials or private source code into issues or PRs.

By contributing you agree that your contribution is licensed under the Apache
License 2.0 (see [LICENSE](LICENSE)), and to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
