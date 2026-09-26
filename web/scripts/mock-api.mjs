// Zero-dependency mock of the atmin review API that serves web/dist like the worker does
// (same CSP, hashed /assets/ cached immutably, index.html for any other GET path).
//   MOCK_SCENARIO=signed-out|no-installations|customer|operator|limit-reached  (default customer)
//   PORT=4173  MOCK_DELAY=120 (ms added to API responses so loading states are visible)
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const scenario = process.env.MOCK_SCENARIO ?? 'customer';
const scenarios = ['signed-out', 'no-installations', 'customer', 'operator', 'limit-reached'];
if (!scenarios.includes(scenario)) throw new Error(`MOCK_SCENARIO must be one of ${scenarios.join(', ')}`);
const port = Number(process.env.PORT ?? 4173);
const delay = Number(process.env.MOCK_DELAY ?? 120);
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

// ---- Fixtures -------------------------------------------------------------------------------
const now = Date.now();
const ago = minutes => new Date(now - minutes * 60_000).toISOString();
const month = new Date(now).toISOString().slice(0, 7);
const resetsAt = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1)).toISOString();
const sha = seed => createHash('sha1').update(seed).digest('hex');
const limited = scenario === 'limit-reached';

const installations = [
  { id: 99, account: 'acme', accountType: 'Organization', manageUrl: 'https://github.com/organizations/acme/settings/installations/99',
    plan: { freeReviews: 20, monthlyReviews: 20 },
    usage: { month, resetsAt, reviews: limited ? 20 : 12, remaining: limited ? 0 : 8, estimatedUsd: 0, unknownCostReviews: 0 } },
  { id: 120, account: 'octo', accountType: 'User', manageUrl: 'https://github.com/settings/installations/120',
    plan: { freeReviews: 20, monthlyReviews: limited ? 0 : 20 },
    usage: { month, resetsAt, reviews: 3, remaining: limited ? 0 : 17, estimatedUsd: 0, unknownCostReviews: 0 } },
];
const repositories = [
  ['acme/api', 42, true, true], ['acme/web', 43, true, true], ['acme/billing-service', 44, true, false],
  ['acme/docs', 45], ['acme/infra', 46], ['acme/mobile-app', 47], ['acme/design-system', 48], ['acme/data-pipeline', 49],
  ['acme/sdk-python', 50], ['acme/sdk-go', 51], ['acme/status-page', 52], ['acme/terraform-modules', 53],
].map(([name, id, connected = false, enabled]) => ({ id, name, installationId: 99, connected, ...(connected ? { enabled } : {}) }))
  .concat([
    { id: 130, name: 'octo/side-project', installationId: 120, connected: true, enabled: true },
    { id: 131, name: 'octo/dotfiles', installationId: 120, connected: false },
  ]);

const models = [
  { id: 'luna', label: 'Luna', provider: 'openrouter', model: 'openai/gpt-6-luna', maxUsd: 2 },
  { id: 'deepseek', label: 'DeepSeek V3.2', provider: 'openrouter', model: 'deepseek/deepseek-v3.2', maxUsd: 1 },
];
const usage = (model, knownUsd, settled = true) => ({ model: models.find(m => m.id === model).model, knownUsd, totalUsd: settled ? knownUsd : null, unsettledCalls: settled ? 0 : 1, calls: 6 });
const run = (repository, id, pr, state, minutes, extra = {}) => ({
  id, pr, state, createdAt: ago(minutes), started: !['queued', 'skipped'].includes(state), head: state === 'queued' ? null : sha(id),
  verdict: null, usage: null, url: `https://github.com/${repository}/pull/${pr}`, ...extra,
});

function finding(id, priority, category, title, path, line, trigger, consequence, suggestion, evidence) {
  return { id, priority, kind: category === 'simplicity' ? 'improvement' : 'defect', category, title, trigger, consequence,
    priorityReason: 'Mock data.', counterEvidence: 'None found.', ...(suggestion ? { suggestion } : {}),
    anchor: { path, side: 'head', line }, evidenceIds: evidence.map(e => e.id),
    url: `https://github.com/acme/api/blob/${sha('b')}/${path}#L${line}`, evidence };
}

const apiFindings = [
  finding('f1', 'P1', 'correctness', 'Cache lookup runs before the tenant ID is validated', 'src/cache/tenant.ts', 48,
    'A request with an empty or malformed X-Tenant-Id header reaches getTenantConfig().',
    'The lookup uses the key "tenant:" and can return configuration cached for another request.',
    'Validate the header with parseTenantId() before building the cache key, and return 400 when it is invalid.',
    [{ id: 'e1', kind: 'source-read', summary: 'getTenantConfig builds the cache key from the raw header value (lines 40–52).' },
      { id: 'e2', kind: 'source-reasoning', summary: 'parseTenantId is only called after the cache lookup in src/http/handler.ts.' }]),
  finding('f2', 'P2', 'reliability', 'Retries ignore the Retry-After header', 'src/http/client.ts', 112,
    'The upstream returns 429 with Retry-After: 30.',
    'The client retries after 200 ms three times and gives up before the upstream accepts requests again.',
    'Read Retry-After and wait at least that long, within the existing overall deadline.',
    [{ id: 'e3', kind: 'source-read', summary: 'retryDelay() returns a fixed exponential delay and never reads response headers.' }]),
  finding('f3', 'P3', 'validation', 'No test covers an empty tenant header', 'test/tenant.test.ts', 12,
    'The test suite runs.', 'A regression in tenant header validation would not fail any test.',
    'Add a case that sends an empty X-Tenant-Id header and expects 400.',
    [{ id: 'e4', kind: 'source-read', summary: 'The tenant tests only send valid tenant IDs.' }]),
  finding('f4', 'P3', 'simplicity', 'Cache keys are built in two places', 'src/cache/keys.ts', 15,
    'A new cache key format is introduced.', 'The two builders can drift and produce different keys for the same tenant.', null,
    [{ id: 'e5', kind: 'source-read', summary: 'tenantKey() in keys.ts and the inline template in tenant.ts build the same key.' }]),
];

const reports = {};
function report(runId, outcome, findings, coverage, limitations, reviewer = 'Luna') {
  const scope = coverage.every(c => c.status === 'reviewed') ? 'complete' : 'partial';
  reports[runId] = {
    summary: `${outcome}. ${findings.length} finding(s) recorded. Review scope: ${scope}. Required validation: not-applicable. Not rated. This is not merge approval.`,
    reviewer: { name: 'atmin review', model: reviewer, context: 'independent' }, head: sha('b'), base: sha('a'), baseRef: 'main',
    assessment: { outcome, findingsVerdict: outcome, scope, validation: 'not-applicable', findings, hiddenOptionalCount: 0, reasons: [] },
    coverage, validationAt: null, limitations,
  };
}
const files = (reviewed, ...unreviewed) => [...reviewed.map(path => ({ path, status: 'reviewed' })), ...unreviewed.map(path => ({ path, status: 'unreviewed' }))];
report('run-6e21b0', 'Changes needed', apiFindings,
  files(['src/cache/tenant.ts', 'src/cache/keys.ts', 'src/http/client.ts', 'src/http/handler.ts', 'src/config/defaults.ts', 'test/tenant.test.ts', 'test/client.test.ts'], 'package-lock.json'),
  ['Tests were not run; findings come from reading the source.', 'package-lock.json was not reviewed.']);
report('run-3b12f9', 'Suggestions', [apiFindings[2]], files(['src/cache/tenant.ts', 'test/tenant.test.ts']), []);
report('run-5d90aa', 'No issues found', [], files(['README.md', 'docs/api-v2.md']), []);

const reasons = {
  running: 'This review is still in progress. Refresh to check its status.',
  queued: 'This review is still in progress. Refresh to check its status.',
  failed: 'The model provider was unavailable. Check its status before requesting another review.',
  cancelled: 'This run was cancelled. A newer commit or a pause can cancel a review.',
  skipped: 'No review was started for this event. Draft and closed PRs do not trigger automatic reviews.',
  uncertain: 'GitHub publication could not be confirmed. Check the PR before requesting another review.',
};

function dashboardData(repository) {
  const name = repository.name;
  const runs = repository.id === 42 ? [
    run(name, 'run-7f3a2c', 128, 'running', 2, { usage: usage('luna', 0.12, false) }),
    run(name, 'run-0f55b1', 122, 'queued', 1),
    run(name, 'run-6e21b0', 127, 'completed', 38, { verdict: 'Changes needed', usage: usage('luna', 0.31) }),
    run(name, 'run-5d90aa', 126, 'completed', 95, { verdict: 'No issues found', usage: usage('luna', 0.18) }),
    run(name, 'run-4c77e1', 125, 'failed', 140, { usage: usage('deepseek', 0.0412) }),
    run(name, 'run-3b12f9', 127, 'completed', 260, { verdict: 'Suggestions', usage: usage('luna', 0.27) }),
    run(name, 'run-2a08d4', 124, 'skipped', 300),
    run(name, 'run-19c4e2', 123, 'cancelled', 420, { usage: usage('luna', 0.02) }),
    run(name, 'run-1b0d7e', 121, 'uncertain', 1500, { verdict: null, usage: usage('luna', 0.22) }),
  ] : [
    run(name, `run-${repository.id}a`, 18, 'completed', 50, { verdict: 'No issues found', usage: usage('luna', 0.09) }),
    run(name, `run-${repository.id}b`, 17, 'completed', 700, { verdict: 'Suggestions', usage: usage('deepseek', 0.06) }),
  ];
  const byId = Object.fromEntries(runs.map(r => [r.id, r]));
  const pull = (pr, title, author, state, runId, counts, coverage) => ({
    pr, title, author, state, url: `https://github.com/${name}/pull/${pr}`,
    run: runId ? byId[runId] : null, counts, coverage,
  });
  const zero = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
  const pulls = repository.id === 42 ? [
    pull(128, 'Retry webhook deliveries with exponential backoff', 'mona', 'open', 'run-7f3a2c', null, null),
    pull(127, 'Validate the tenant ID before the cache lookup', 'hubot', 'open', 'run-6e21b0', { P0: 0, P1: 1, P2: 1, P3: 2, P4: 0 }, { reviewed: 7, total: 8 }),
    pull(126, 'Document the v2 API in the README', 'octo', 'merged', 'run-5d90aa', zero, { reviewed: 2, total: 2 }),
    pull(125, 'Move the session store to Redis', 'mona', 'open', 'run-4c77e1', null, null),
    pull(124, 'WIP: token bucket rate limiter', 'hubot', 'draft', 'run-2a08d4', null, null),
    pull(123, 'Bump the dependencies group with 14 updates', 'dependabot[bot]', 'closed', 'run-19c4e2', null, null),
    pull(122, 'Add request tracing to outbound calls', 'octo', 'open', 'run-0f55b1', null, null),
    pull(121, 'Fix cursor encoding in paginated list endpoints', 'mona', 'merged', 'run-1b0d7e', null, null),
    pull(120, 'Refactor error handling in the billing client', 'hubot', 'closed', null, null, null),
  ] : [
    pull(18, 'Tighten the content security policy', 'mona', 'open', `run-${repository.id}a`, zero, { reviewed: 3, total: 3 }),
    pull(17, 'Use the shared button in the settings page', 'octo', 'merged', `run-${repository.id}b`, { ...zero, P3: 1 }, { reviewed: 4, total: 4 }),
  ];
  for (const p of pulls) if (p.run) p.run = { ...p.run, verdict: p.run.state === 'completed' ? p.run.verdict : null };
  return {
    repository: { id: repository.id, name, installationId: repository.installationId, enabled: repository.enabled },
    settings: settings.get(repository.id) ?? { model: 'luna', maxUsd: 1, maxReviewsPerDay: 20 },
    models, limits: { maxReviewsPerDay: 20 }, runs, pulls, pullLimit: 100, checkedAt: new Date().toISOString(),
  };
}
const settings = new Map();

const adminDefaults = { freeReviews: 20, monthlyReviews: 20, multiplier: 2, minimumUsd: 0.05 };
const admin = {
  limits: { maxReviewsPerDay: 100, reviewsToday: 7 },
  installations: [
    { id: 99, account: 'acme', accountType: 'Organization', createdAt: '2026-08-02T15:20:00.000Z', suspended: false, removed: false,
      plan: { ...adminDefaults, custom: false, updatedAt: null, updatedBy: null },
      usage: { month, resetsAt, reviews: 12, remaining: 8, knownUsd: 0.41, estimatedUsd: 0, unknownCostReviews: 0 },
      repositories: [{ id: 42, name: 'acme/api', enabled: true, reviews: 9 }, { id: 43, name: 'acme/web', enabled: true, reviews: 3 }, { id: 44, name: 'acme/billing-service', enabled: false, reviews: 0 }] },
    { id: 310, account: 'globex', accountType: 'Organization', createdAt: '2026-08-19T09:05:00.000Z', suspended: false, removed: false,
      plan: { freeReviews: 20, monthlyReviews: 500, multiplier: 1.1, minimumUsd: 0, custom: true, updatedAt: '2026-09-12T10:31:00.000Z', updatedBy: 'lorsk' },
      usage: { month, resetsAt, reviews: 146, remaining: 354, knownUsd: 23.18, estimatedUsd: 21.64, unknownCostReviews: 2 },
      repositories: [
        { id: 601, name: 'globex/platform', enabled: true, reviews: 71 }, { id: 602, name: 'globex/checkout', enabled: true, reviews: 44 },
        { id: 603, name: 'globex/search', enabled: true, reviews: 22 }, { id: 604, name: 'globex/mobile', enabled: true, reviews: 9 },
        { id: 605, name: 'globex/archive', enabled: false, reviews: 0 }] },
    { id: 275, account: 'initech', accountType: 'Organization', createdAt: '2026-07-28T12:00:00.000Z', suspended: false, removed: true,
      plan: { ...adminDefaults, custom: false, updatedAt: null, updatedBy: null },
      usage: { month, resetsAt, reviews: 0, remaining: 20, knownUsd: 0, estimatedUsd: 0, unknownCostReviews: 0 },
      repositories: [{ id: 501, name: 'initech/legacy-portal', enabled: false, reviews: 0 }] },
  ],
};

// ---- Handlers -------------------------------------------------------------------------------
let signedOut = scenario === 'signed-out';
const user = { id: 583231, login: 'octo' };
const operator = scenario === 'operator';
const version = 'atmin.review.v1';
const installUrl = 'https://github.com/apps/atmin-review/installations/new';

function connections() {
  const empty = scenario === 'no-installations';
  return { installUrl, maxRepositories: 10, installations: empty ? [] : installations, repositories: empty ? [] : repositories };
}
function sessionBody(selected) {
  if (signedOut) return [200, { version, user: null, installUrl }];
  const base = { version, user, operator, connections: connections() };
  const list = base.connections.repositories;
  const repository = selected === null ? list.find(r => r.connected) : list.find(r => r.id === Number(selected) && r.connected);
  if (selected !== null && !repository) return [404, { error: 'Repository not available.' }];
  if (!repository) return [200, { ...base, repository: null }];
  return [200, { ...base, ...dashboardData(repository) }];
}

async function body(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 4096) return { tooLarge: true }; chunks.push(chunk); }
  try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { invalid: true }; }
}

async function handleApi(request, url) {
  const path = url.pathname.slice('/api/review/v1'.length);
  const selected = url.searchParams.get('repository');
  if (request.method === 'GET' && path === '/session') return sessionBody(selected);
  if (signedOut) return [401, { error: 'Sign in with GitHub to continue.' }];
  let input = {};
  if (request.method === 'POST') {
    if (request.headers['content-type'] !== 'application/json') return [403, { error: 'Reload this page before trying again.' }];
    const parsed = await body(request);
    if (parsed.tooLarge) return [413, { error: 'Request too large.' }];
    if (parsed.invalid) return [400, { error: 'Invalid request.' }];
    input = parsed.value;
    if (path === '/logout') { signedOut = true; return [200, { ok: true }]; }
  }
  if (path.startsWith('/admin')) {
    if (!operator) return [403, { error: 'Operator access is required.' }];
    if (request.method === 'GET' && path === '/admin') return [200, { version, ...admin, defaults: adminDefaults, checkedAt: new Date().toISOString() }];
    if (request.method === 'POST' && path === '/admin/plan') {
      const target = admin.installations.find(i => i.id === Number(url.searchParams.get('installation')));
      if (!target) return [404, { error: 'Installation not found.' }];
      const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 100000, factor = v => Number.isFinite(v) && v >= 0 && v <= 10;
      if (!count(input.freeReviews) || !count(input.monthlyReviews) || !factor(input.multiplier) || !factor(input.minimumUsd) || Object.keys(input).length !== 4) {
        return [400, { error: 'Enter whole review counts up to 100,000 and a multiplier and minimum from 0 to 10.' }];
      }
      target.plan = { ...input, custom: true, updatedAt: new Date().toISOString(), updatedBy: user.login };
      const u = target.usage, average = u.reviews ? u.knownUsd / u.reviews : 0, billable = Math.max(0, u.reviews - input.freeReviews);
      u.remaining = Math.max(0, input.monthlyReviews - u.reviews);
      u.estimatedUsd = Math.round(billable * Math.max(average * input.multiplier, input.minimumUsd) * 100) / 100;
      return [200, { plan: target.plan, usage: u }];
    }
    return [404, { error: 'Not found.' }];
  }
  if (selected !== null && !/^[1-9][0-9]{0,15}$/.test(selected)) return [400, { error: 'Choose a repository.' }];
  const visible = connections().repositories;
  const repository = visible.find(r => r.id === Number(selected));
  if (request.method === 'POST' && path === '/connect') {
    if (!repository) return [403, { error: 'Repository administrator access is required. Sign in again if your access changed.' }];
    const owner = installations.find(i => i.id === repository.installationId);
    if (!repository.connected && visible.filter(r => r.installationId === owner.id && r.connected).length >= 10) {
      return [409, { error: `${owner.account} already has 10 connected repositories.` }];
    }
    Object.assign(repository, { connected: true, enabled: repository.enabled ?? false });
    return [200, { repository: { id: repository.id, name: repository.name, enabled: repository.enabled } }];
  }
  if (selected === null) return [400, { error: 'Choose a repository.' }];
  if (!repository?.connected) return [404, { error: 'Repository not available.' }];
  if (request.method === 'GET' && path === '/dashboard') return [200, { version, user, operator, connections: connections(), ...dashboardData(repository) }];
  if (request.method === 'GET' && path.startsWith('/reviews/')) {
    const id = decodeURIComponent(path.slice('/reviews/'.length));
    const data = dashboardData(repository);
    const found = data.runs.find(r => r.id === id);
    if (!found) return [404, { error: 'Review not found.' }];
    const livePull = data.pulls.find(p => p.pr === found.pr);
    const report = reports[id] ?? null;
    return [200, { version, run: found, pull: livePull ? { title: livePull.title, author: livePull.author, state: livePull.state } : null,
      report, reason: report && found.state === 'completed' ? null : reasons[found.state] ?? 'Complete review evidence is unavailable.',
      runs: data.runs.filter(r => r.pr === found.pr) }];
  }
  if (request.method === 'POST' && path === '/enabled') {
    if (typeof input.enabled !== 'boolean') return [400, { error: 'Invalid repository selection.' }];
    repository.enabled = input.enabled;
    return [200, { enabled: repository.enabled }];
  }
  if (request.method === 'POST' && path === '/settings') {
    const model = models.find(m => m.id === input.model);
    if (!model || !(input.maxUsd >= 0 && input.maxUsd <= model.maxUsd) || !Number.isSafeInteger(input.maxReviewsPerDay)
      || input.maxReviewsPerDay < 1 || input.maxReviewsPerDay > 20) {
      return [400, { error: 'Choose an available model and stay within the displayed limits.' }];
    }
    const saved = { model: input.model, maxUsd: input.maxUsd, maxReviewsPerDay: input.maxReviewsPerDay };
    settings.set(repository.id, saved);
    return [200, { settings: saved }];
  }
  return [404, { error: 'Not found.' }];
}

function serveStatic(request, response, url) {
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(root, relative);
  const served = file.startsWith(root) && relative && existsSync(file) && statSync(file).isFile() && types[extname(file)];
  const target = served ? file : join(root, 'index.html');
  if (!existsSync(target)) {
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end('Run `npm run build` in web/ first.');
    return;
  }
  response.writeHead(200, {
    'Content-Type': types[extname(target)], 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': served && url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : readFileSync(target));
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/auth/github') {
    // Mock sign-in without GitHub: the signed-out scenario shows a sign-in error; the others
    // sign back in and return to the deep link the way the worker does.
    const repository = url.searchParams.get('repository'), review = url.searchParams.get('review');
    let location = /^[1-9][0-9]{0,15}$/.test(repository ?? '') && /^[a-zA-Z0-9-]{1,100}$/.test(review ?? '') ? `/?repository=${repository}#review/${review}` : '/';
    if (scenario === 'signed-out') location = '/?signin=denied';
    else signedOut = false;
    response.writeHead(303, { Location: location });
    response.end();
    return;
  }
  if (url.pathname.startsWith('/api/review/')) {
    const [status, payload] = await handleApi(request, url);
    // Like the worker, a 403 outside /admin ends the session (the cookie is cleared).
    if (status === 403 && !url.pathname.startsWith('/api/review/v1/admin')) signedOut = true;
    await new Promise(done => setTimeout(done, delay));
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
  serveStatic(request, response, url);
}).listen(port, () => console.log(`atmin review mock (${scenario}) on http://localhost:${port}`));
