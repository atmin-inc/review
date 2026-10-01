class Atmin < Formula
  desc "One command for every atmin tool"
  homepage "https://github.com/atmin-inc/review/tree/main/packaging/atmin-cli"
  url "https://registry.npmjs.org/@atmin.ai/cli/-/cli-0.1.0.tgz"
  sha256 "SET_AT_RELEASE"
  license "Apache-2.0"

  depends_on "node@24"

  def install
    system formula_opt_bin("node@24")/"npm", "install", *std_npm_args
    (bin/"atmin").write_env_script libexec/"bin/atmin", PATH: "#{formula_opt_bin("node@24")}:$PATH"
  end

  test do
    (testpath/"atmin-demo").write "#!/bin/sh\necho demo:$1\n"
    chmod 0755, testpath/"atmin-demo"
    with_env(PATH: "#{testpath}:#{ENV["PATH"]}") do
      assert_match "demo:ok", shell_output("#{bin}/atmin demo ok")
      assert_match "demo", shell_output("#{bin}/atmin --help")
    end
  end
end
