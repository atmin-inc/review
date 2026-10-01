# Homebrew formulas (source for atmin-inc/homebrew-tap)

- `atmin.rb`: the `atmin` dispatcher (`packaging/atmin-cli`, npm `@atmin.ai/cli`). Owns the `atmin` name.
- `atmin-review.rb`: this package (npm `@atmin.ai/review`). Ships `atmin-review`, `atmin-review-github`
  and `atmin-code-review-runner`, so `atmin review` and `atmin code-review-runner` work. Replaces the old
  `atmin` formula, which linked `atmin` to `atmin-review`.

Release order:
1. `npm publish` `packaging/atmin-cli` and this package (a published version can never be reused).
2. Set each formula's `sha256` from `curl -sL <url> | shasum -a 256`.
3. Copy both formulas into the tap's `Formula/`, then `brew install --build-from-source` and `brew test` each.
   Existing users: `brew uninstall atmin && brew install atmin-inc/tap/atmin-review`.
