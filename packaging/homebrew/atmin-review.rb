class AtminReview < Formula
  desc "Evidence-based code review and a runner for your own CLI subscription"
  homepage "https://github.com/atmin-inc/review"
  url "https://registry.npmjs.org/@atmin.ai/review/-/review-0.1.0-alpha.3.tgz"
  sha256 "SET_AT_RELEASE"
  license "Apache-2.0"

  depends_on "atmin-inc/tap/atmin"
  depends_on "gh"
  depends_on "git"
  depends_on "node@24"

  def install
    system formula_opt_bin("node@24")/"npm", "install", *std_npm_args
    %w[atmin-review atmin-review-github atmin-code-review-runner].each do |command|
      (bin/command).write_env_script libexec/"bin"/command, PATH: "#{formula_opt_bin("node@24")}:$PATH"
    end
    pkgshare.install libexec/"lib/node_modules/@atmin.ai/review/profiles"
  end

  def caveats
    <<~EOS
      Review a PR yourself: run `gh auth login`, set OPENROUTER_API_KEY, then
        atmin review <PR URL> --profile #{pkgshare}/profiles/smoke-openrouter-free.json
      Review your own PRs on your Claude Code subscription (needs `claude` signed in):
        atmin code-review-runner login && atmin code-review-runner setup && atmin code-review-runner
    EOS
  end

  test do
    assert_match "atmin-review", shell_output("#{bin}/atmin-review --help")
    assert_match "Starts paused", shell_output("#{bin}/atmin-review-github --help")
    assert_match "code-review-runner", shell_output("#{bin}/atmin-code-review-runner --help")
    assert_match "review", shell_output("#{formula_opt_bin("atmin-inc/tap/atmin")}/atmin --help")
    profile = pkgshare/"profiles/smoke-openrouter-free.json"
    url = "https://example.com/owner/repo/pull/1"
    output = shell_output("#{bin}/atmin-review review #{url} --profile #{profile} 2>&1", 1)
    assert_match "Use an HTTPS github.com pull request URL", output
  end
end
