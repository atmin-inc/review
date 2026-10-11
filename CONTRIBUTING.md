# Contributing

Use Node 24+, run `npm ci` and `npm test`, and include a focused regression for
behavior changes. Keep source review separate from repository execution and
preserve bounded spending, credential separation and honest incomplete verdicts.

Open pull requests against `main`. Merges to `main` deploy the maintainers' hosted
service, so a maintainer reviews every change before it lands. `AGENTS.md` holds the
measurements and design decisions behind the current behavior; read the section for
the area you are changing first.

Report security problems privately as described in [SECURITY.md](SECURITY.md), not
in an issue. Never paste credentials or private source code into issues or PRs.

By contributing you agree that your contribution is licensed under the Apache
License 2.0 (see [LICENSE](LICENSE)), and to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
