import { Brand } from './components.jsx';
import { LegalLinks } from './legal.jsx';

// Public documentation at /docs/<page>. Each page restates what the code does; when a limit,
// command or setting changes (README.md, deploy/, src/github/config.ts, src/code-review-runner.ts),
// change it here too.
const Code = ({ children }) => <pre className="docs-code"><code>{children.trim()}</code></pre>;
const C = ({ children }) => <code className="docs-inline">{children}</code>;

export const docsPages = [
  ['getting-started', 'Getting started', [
    ['Install and connect', <>
      <ol>
        <li>Install the atmin review GitHub App on your organization and choose the repositories it may read.</li>
        <li><a className="link" href="/">Sign in</a> with GitHub. A repository administrator connects up to 10 repositories for each organization.</li>
        <li>Open or push to a pull request. atmin reviews it and posts one comment, inline findings and an <C>atmin review</C> check.</li>
      </ol>
    </>],
    ['What gets reviewed', <>
      <ul>
        <li>The first review of a pull request reads the whole change. Each later push is reviewed incrementally: only the new commits are read for new findings, and earlier findings are re-checked against the new head. A force-push or a merge from the target branch gets a full review.</li>
        <li>Automatic reviews pause after five reviewed heads of one pull request. Comment exactly <C>/atmin review</C> or <C>@atmin review</C> on the pull request for a full review; that also restarts the count.</li>
        <li>A repository administrator can turn off Automatic reviews in the repository's settings. Then opening, pushing to or readying a pull request starts nothing, and a review starts only when a maintainer comments <C>/atmin review</C> or <C>@atmin review</C>.</li>
        <li>A deleted file counts only as its deletion, and lock files not at all. A diff over 512 KB is reviewed in parts of 256 KB, side by side, so every file is still reviewed. The parts share the review's spending limit, which covers 13 parts at the default $2. Past that, deleted files are read first, then source files before tests and docs, smallest first, and the rest are listed as not reviewed. Binary and lock files are listed but not reviewed and do not affect the rating.</li>
        <li>atmin never runs your repository's code during a review.</li>
      </ul>
    </>],
    ['Free reviews and credit', <>
      <p>Each organization gets 20 free reviews per UTC calendar month. After that, each review is paid from prepaid credit bought on the Billing page; the pull request comment shows the price and what credit is left. A review counts once the model starts, including one that fails. See <a className="link" href="/docs/limits">Limits and data</a>.</p>
    </>],
  ]],
  ['reading-a-review', 'Reading a review', [
    ['Priorities', <>
      <table className="docs-table">
        <thead><tr><th>Priority</th><th>Meaning</th><th>Check</th></tr></thead>
        <tbody>
          <tr><td>P0</td><td>Critical, immediate intervention</td><td>Changes needed</td></tr>
          <tr><td>P1</td><td>High-impact defect needing a prompt fix</td><td>Changes needed</td></tr>
          <tr><td>P2</td><td>Material defect that should be fixed</td><td>Changes needed</td></tr>
          <tr><td>P3</td><td>Minor defect with limited impact</td><td>Non-blocking; listed by location</td></tr>
          <tr><td>P4</td><td>Optional improvement</td><td>Hidden by default</td></tr>
        </tbody>
      </table>
      <p>A priority depends on a concrete trigger, its impact and whether it can be reached. Every finding cites the exact commit and lines it is about.</p>
    </>],
    ['The score', <>
      <p>A complete review with no findings scores 5/5. A P2 caps the score at 3, a P0 or P1 at 1. An incomplete or stale review is not rated. "No issues found" means the review found nothing; it does not mean tests passed.</p>
    </>],
    ['Feedback', <>
      <p>React with thumbs up or down on an inline finding, or reply to it. When the pull request closes, atmin records whether each finding's lines were changed and what reactions it got.</p>
    </>],
  ]],
  ['configuration', 'Repository configuration', [
    ['.atmin/review.json', <>
      <p>Put this file on the target branch. A pull request cannot weaken its own policy: the file is read from the branch it merges into. Without it, no CI check is required and the <C>atmin review</C> check reflects the review alone.</p>
      <Code>{`
{
  "schemaVersion": 1,
  "rubricVersion": "1",
  "includeOptional": false,
  "requiredChecks": ["change-validation"],
  "rating": { "preset": "balanced" }
}`}</Code>
      <ul>
        <li><C>includeOptional</C>: show P4 suggestions.</li>
        <li><C>requiredChecks</C>: CI checks that must pass on the reviewed head. While only these are outstanding, the atmin check stays pending instead of failing. A self-hosted server must also list each one under <C>trustedChecks</C>.</li>
        <li><C>rating.preset</C>: <C>balanced</C> (default), <C>correctness-first</C> or <C>strict-conventions</C>. <C>rating.perfectRequires</C> takes booleans: <C>codebaseFit</C>, <C>simplicity</C>, <C>verification</C>, <C>documentedConventions</C>, <C>passingChecks</C>, <C>noP3</C>.</li>
      </ul>
    </>],
    ['Repository settings', <>
      <p>On each repository's page in atmin, an administrator can pause reviews and set the model, the maximum spend per review, reviews per day, reviews per pull request author each month, and whether members' own runners may review.</p>
    </>],
  ]],
  ['own-runner', 'Your own runner', [
    ['What it is', <>
      <p>A member can review their own pull requests on their own machine with their own Claude Code subscription. Those reviews are free and use none of the organization's reviews or credit. Code and the Claude login stay on that machine; atmin sends a one-hour read-only token per review and posts the result. When the runner is offline, atmin reviews the pull request itself.</p>
      <p>A repository administrator must first turn on "Members' own runners" on the repository's page.</p>
    </>],
    ['Set it up', <>
      <p>Needs Node 24, git, the GitHub CLI and the <C>claude</C> CLI signed in.</p>
      <Code>{`
brew install atmin-inc/tap/atmin-review
atmin code-review-runner login
atmin code-review-runner setup
atmin code-review-runner start`}</Code>
      <p>Keep <C>start</C> running (tmux, launchd or systemd). A first Ctrl-C finishes the review in progress; a second stops at once.</p>
    </>],
  ]],
  ['cli', 'Command line', [
    ['Install', <>
      <Code>{`
brew install atmin-inc/tap/atmin-review
# or, with Node 24 or newer:
npm install @atmin.ai/review`}</Code>
      <p>Requires git and an authenticated GitHub CLI (<C>gh auth login</C>). If Homebrew refuses an untrusted tap, run <C>brew trust atmin-inc/tap</C> and install again.</p>
    </>],
    ['Review a pull request', <>
      <p>Copy a profile from the package's <C>profiles/</C> directory. <C>review-luna-openrouter.json</C> is the one atmin runs in production, capped at $2 a run; <C>smoke-openrouter-free.json</C> uses free models only.</p>
      <Code>{`
export OPENROUTER_API_KEY=<key>
atmin review https://github.com/OWNER/REPO/pull/123 \\
  --profile ./review-profile.json --out ./private-review`}</Code>
      <p>Set <C>TYPESAFE_API_KEY</C> too to turn on the symbolic check of findings. The output directory contains repository source: keep it private. Interrupted or partial reviews exit with status 2, errors with 1.</p>
    </>],
  ]],
  ['self-host', 'Self-host the server', [
    ['What you run', <>
      <p>The same service that runs review.atmin.ai: one Ubuntu 24.04 host with the service (webhooks, this site, and a router), its runners that take the reviews, and Caddy for TLS. Reviews use your own model key. It is open source under Apache-2.0: <a className="link" href="https://github.com/atmin-inc/review">github.com/atmin-inc/review</a>.</p>
      <p>You need a domain pointed at the host, an OpenRouter key (optionally a TypeSafe key), and a GitHub organization to register the App in.</p>
    </>],
    ['1. Register a GitHub App', <>
      <ul>
        <li>Permissions: Contents read, Issues read, Pull requests write, Checks write.</li>
        <li>Events: Pull request, Push, Issue comment, Check run.</li>
        <li>Webhook URL: <C>https://YOUR-DOMAIN/webhooks/github</C>, with a secret of at least 32 bytes.</li>
        <li>Callback URL: <C>https://YOUR-DOMAIN/auth/github/callback</C>. Setup URL: <C>https://YOUR-DOMAIN</C>.</li>
        <li>Generate a private key and a client secret. Install the App on the repository you will configure first.</li>
      </ul>
    </>],
    ['2. Prepare the host', <>
      <Code>{`
git clone https://github.com/atmin-inc/review && cd review
sudo deploy/install.sh /var/lib/atmin-review`}</Code>
      <p>This installs Node 24, git, gh, Caddy and Bubblewrap, creates the <C>atmin-review</C> user and the systemd services, and a <C>deploy</C> user that may run only the release script. The argument is the state directory. Edit <C>/etc/caddy/Caddyfile</C> to use your domain instead of review.atmin.ai.</p>
    </>],
    ['3. Configure', <>
      <p>Put these in <C>/etc/atmin-review</C>, group <C>atmin-review</C>, mode 0640, with the App's private key and a copy of <C>profiles/review-luna-openrouter.json</C>. <C>pilot.json</C> names the first repository; others are connected from the site.</p>
      <Code>{`
{
  "repository": "OWNER/REPO",
  "repositoryId": 123,
  "installationId": 456,
  "profile": "/etc/atmin-review/review-luna-openrouter.json",
  "stateDirectory": "/var/lib/atmin-review",
  "host": "127.0.0.1",
  "port": 8787,
  "maxReviewsPerDay": 50
}`}</Code>
      <p><C>dashboard.json</C> turns on this site and sign-in. <C>operators</C> are GitHub user IDs (not logins) who get <C>/admin</C>; <C>appSlug</C> adds an install button.</p>
      <Code>{`
{
  "origin": "https://YOUR-DOMAIN",
  "clientId": "YOUR-APP-CLIENT-ID",
  "models": [{ "id": "luna", "label": "GPT-6 Luna", "profile": "review-luna-openrouter.json" }],
  "operators": [12345678],
  "appSlug": "your-app-slug"
}`}</Code>
      <p><C>service.env</C>, mode 0640:</p>
      <Code>{`
ATMIN_REVIEW_CONFIG=/etc/atmin-review/pilot.json
REVIEW_DASHBOARD_CONFIG=/etc/atmin-review/dashboard.json
GITHUB_APP_ID=<App ID>
GITHUB_APP_PRIVATE_KEY_PATH=/etc/atmin-review/app.pem
GITHUB_WEBHOOK_SECRET=<webhook secret>
GITHUB_OAUTH_CLIENT_SECRET=<App client secret>
OPENROUTER_API_KEY=<key>
TYPESAFE_API_KEY=<key, optional>
ATMIN_RUNNER_POOL_TOKEN=<openssl rand -hex 32>
ATMIN_REVIEW_RUNNERS=2
# STRIPE_SECRET_KEY=<key>   only to sell credit to others`}</Code>
      <p>Tell Caddy the port: <C>systemctl edit caddy</C>, add <C>[Service]</C> <C>Environment=ATMIN_REVIEW_PORT=8787</C>, then <C>systemctl restart caddy</C>.</p>
    </>],
    ['4. Deploy', <>
      <Code>{`
sudo /opt/atmin-review/release.sh <40-character commit on main>
sudo systemd-run --wait --pipe -p User=atmin-review -p EnvironmentFile=/etc/atmin-review/service.env \\
  /usr/bin/node /opt/atmin-review/current/dist/github/cli.js enable /etc/atmin-review/pilot.json`}</Code>
      <p>The release script builds the commit beside the running one, refuses to switch if the review sandbox cannot start or less than 3 GB is free, and switches back by itself if <C>/healthz</C> does not answer within 30 seconds. It keeps the five newest releases. A new server starts paused; <C>enable</C> starts reviews.</p>
      <p>Change <C>ATMIN_REVIEW_RUNNERS</C> later with <C>sudo /opt/atmin-review/release.sh runners</C>; each runner finishes its current review first.</p>
    </>],
    ['Deploy from GitHub Actions (optional)', <>
      <p>In a fork, the included <C>deploy.yml</C> deploys each commit on <C>main</C> that passes CI. Add an environment named <C>production</C> with <C>DEPLOY_HOST</C>, <C>DEPLOY_SSH_KEY</C> (its public half in <C>/home/deploy/.ssh/authorized_keys</C>) and <C>DEPLOY_KNOWN_HOSTS</C> (from <C>ssh-keyscan</C>). Change the repository <C>release.sh</C> clones to your fork.</p>
    </>],
    ['Operating it', <>
      <ul>
        <li>Plans: each organization gets 20 reviews a month by default. Operators change free reviews, the monthly limit, the price multiplier and minimum at <C>/admin</C>.</li>
        <li><C>maxReviewsPerDay</C> caps all organizations together.</li>
        <li>Disk: no review starts below <C>minFreeDiskMb</C> free (default 2048), and each organization is held to <C>maxInstallationDiskMb</C> (default 5120).</li>
        <li>Back up the state directory and <C>/etc/atmin-review</C> with the service stopped. Logs: <C>journalctl -u atmin-review</C> and <C>journalctl -u 'atmin-review-runner@*'</C>.</li>
      </ul>
    </>],
  ]],
  ['limits', 'Limits and data', [
    ['Limits', <>
      <ul>
        <li>Up to 10 connected repositories per organization; a repository over 2 GB does not connect.</li>
        <li>A diff up to 512 KB is read in one go; a bigger one in parts of 256 KB, as many as its spending limit covers (13 at the default $2), source files first; deleted files' old content and lock files do not count.</li>
        <li>Automatic reviews pause after five reviewed heads of a pull request until someone comments <C>/atmin review</C>.</li>
        <li>Credit is bought in $10, $25, $50 or $100 and does not expire. Auto top-up charges the saved card when credit falls below $5.</li>
      </ul>
    </>],
    ['Your code', <>
      <p>Each hosted review runs in its own sandbox that can reach only that review and that repository's copy. Copies are deleted after 24 hours with no review. The model is called only through zero-data-retention routes. Full details are in the <a className="link" href="/privacy">Privacy Policy</a>.</p>
    </>],
  ]],
];

export function DocsPage({ slug }) {
  const page = docsPages.find(([id]) => id === slug) ?? docsPages[0];
  const [id, title, sections] = page;
  return <div className="landing">
    <header className="landing-header"><a href="/" aria-label="atmin review home"><Brand/></a></header>
    <div className="docs">
      <nav aria-label="Documentation" className="docs-nav">
        {docsPages.map(([pageId, pageTitle]) => <a key={pageId} href={`/docs/${pageId}`} aria-current={pageId === id ? 'page' : undefined}>{pageTitle}</a>)}
      </nav>
      <main className="docs-main legal">
        <h1>{title}</h1>
        {sections.map(([heading, body]) => <section key={heading} className="grid gap-3">
          <h2>{heading}</h2>
          {body}
        </section>)}
      </main>
    </div>
    <LegalLinks/>
  </div>;
}
