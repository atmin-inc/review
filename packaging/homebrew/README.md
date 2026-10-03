# Homebrew formulas (source for atmin-inc/homebrew-tap)

- `atmin.rb`: the `atmin` dispatcher (`packaging/atmin-cli`, npm `@atmin.ai/cli`). Owns the `atmin` name.
- `atmin-review.rb`: this package (npm `@atmin.ai/review`). Ships `atmin-review`, `atmin-review-github`
  and `atmin-code-review-runner`, so `atmin review` and `atmin code-review-runner` work. Replaces the old
  `atmin` formula, which linked `atmin` to `atmin-review`.

Releasing this package: bump `version` in package.json, merge to main, then push the tag
`v<version>`. `.github/workflows/release.yml` tests and publishes it to npm, waits for the archive,
writes `atmin-review.rb` with its URL and checksum into the tap, installs, tests and audits it, and
pushes the tap. It needs the `release` environment: npm trusted publishing for this workflow, and
`TAP_TOKEN`, a token that may push to atmin-inc/homebrew-tap.

The dispatcher (`packaging/atmin-cli`, `atmin.rb`) changes rarely and is released by hand: `npm publish`
it (a published version can never be reused), set `sha256` from `curl -sL <url> | shasum -a 256`, copy
it into the tap's `Formula/`, then `brew install --build-from-source` and `brew test` it.
Existing users of the old formula: `brew uninstall atmin && brew install atmin-inc/tap/atmin-review`.
