import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Store } from '../dist/github/store.js';
import { webhook, validSignature } from '../dist/github/webhook.js';
import { assessmentCheck } from '../dist/github/checks.js';
import { assess } from '../dist/assessment.js';
import { capture } from '../dist/snapshot.js';
import { Worker, markerFor, failureCause } from '../dist/github/worker.js';
import { AppGitHub, GitHubError, appJwt } from '../dist/github/api.js';
import { ReviewSettings } from '../dist/github/settings.js';
import { childEnvironment, childSandbox, hostedReview, expireRuns, expireIdleCopies, trimSourceCache, REPOSITORY_IDLE_MS } from '../dist/github/runner.js';
import { inlineComments } from '../dist/github/inline.js';
import { outcomeSummary } from '../dist/github/outcomes.js';
import { repository, completed, finding, current, inline } from './helpers.mjs';

const secret = 'a local test secret with more than 32 bytes';
function state(t) {
  const root = mkdtempSync(join(tmpdir(), 'atmin-github-test-'));
  const store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { repository: 'test/review-fixture', repositoryId: 42, installationId: 21, stateDirectory: root, profile: '', host: '127.0.0.1', port: 0, maxReviewsPerDay: 6, minFreeDiskMb: 0 };
  return { root, store, config };
}
async function harness(t, findings = []) {
  const s = state(t);
  const fixture = repository(t);
  let live = { ...fixture.state, draft: false, author: { id: 1, login: 'alice' } };
  let comment = null;
  let runs = 0, creates = 0, updates = 0;
  const checks = [];
  const reviews = [];
  const github = {
    files: async () => [{ filename: 'update.ts', patch: fixture.diff.toString().slice(fixture.diff.toString().indexOf('@@')) }],
    findReview: async (_pr, head, marker) => reviews.find(r => r.head === head && r.body.startsWith(`${marker}\n`))?.id ?? null,
    createReview: async (pr, head, body, comments) => { const id = reviews.length + 1; reviews.push({ id, pr, head, body, comments }); return id; },
    reviewComments: async () => reviews.flatMap(r => r.comments.map((c, i) => ({ id: r.id * 100 + i, reviewId: r.id, replyTo: null, human: false, body: c.body, up: 0, down: 0 }))),
    file: async (path, ref) => { const shown = spawnSync('git', ['-C', fixture.source, 'show', `${ref}:${path}`]); return shown.status === 0 ? shown.stdout.toString('utf8') : null; },
    validation: async () => [],
    findCheck: async (head, externalId) => checks.find(c => c.head === head && c.externalId === externalId)?.id ?? null,
    createCheck: async (head, externalId, output) => { const id = checks.length + 1; checks.push({id, head, externalId, ...output}); return id; },
    updateCheck: async (id, output) => { Object.assign(checks.find(c => c.id === id), { conclusion: undefined }, output); },
    pull: async () => ({ ...live }), canReview: async login => login === 'maintainer', readToken: async () => 'read-only-fixture',
    summary: async () => comment,
    create: async (_pr, body) => { creates++; comment = { id: 10, body, user: { login: 'atmin-test[bot]', type: 'Bot' } }; return 10; },
    update: async (_id, body) => { updates++; comment.body = body; },
  };
  const runner = async job => {
    runs++;
    const directory = join(s.root, job.id); mkdirSync(directory);
    const packet = { ...fixture.packet, headSha: live.headSha, baseSha: live.baseSha };
    writeFileSync(join(directory, 'packet.json'), JSON.stringify(packet));
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ ...completed(packet), findings }));
    return directory;
  };
  s.store.enable(true); assert.equal(s.store.acquire('owner'), true);
  const worker = new Worker(s.config, s.store, github, inline(runner), 'owner');
  return { ...s, fixture, checks, reviews, github, runner, worker, setLive: changes => { live = { ...live, ...changes }; }, get live() { return live; }, get comment() { return comment; }, get counts() { return { runs, creates, updates }; } };
}
async function http(t, h) {
  const server = webhook(h.config, secret, h.store, h.github);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return async (event, payload, delivery = 'delivery-1', valid = true) => {
    const body = JSON.stringify({ installation: { id: 21 }, repository: { id: 42, full_name: h.config.repository }, ...payload });
    return fetch(`http://127.0.0.1:${server.address().port}/webhooks/github`, { method: 'POST', body, headers: {
      'x-github-event': event, 'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', valid ? secret : 'wrong').update(body).digest('hex')}`,
    } });
  };
}

test('HMAC matches GitHub published vector and rejects changed bytes / malformed signature', () => {
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.equal(validSignature(Buffer.from('Hello, World!'), signature, "It's a Secret to Everybody"), true);
  assert.equal(validSignature(Buffer.from('Hello, World?'), signature, "It's a Secret to Everybody"), false);
  assert.equal(validSignature(Buffer.from('Hello, World!'), 'sha256=ff', secret), false);
});

test('signed webhook → durable queue → report, replay dedupe, push updates exactly one summary', async t => {
  const h = await harness(t); const post = await http(t, h);
  assert.equal((await post('pull_request', { action: 'opened', number: 1 })).status, 202);
  assert.equal((await post('pull_request', { action: 'opened', number: 1 })).status, 200);
  assert.equal(await h.worker.tick(), true);
  assert.match(h.comment.body, /No issues found/);
  assert.equal(h.checks[0].conclusion, 'success');
  assert.equal(h.checks[0].head, h.live.headSha);
  assert.match(h.comment.body, /not atomic/);
  h.setLive({ headSha: 'a'.repeat(40) });
  await post('pull_request', { action: 'synchronize', number: 1 }, 'delivery-2');
  await h.worker.tick();
  assert.match(h.comment.body, new RegExp('a'.repeat(40)));
  assert.equal(h.counts.runs, 2); assert.equal(h.counts.creates, 1);
  assert.equal(h.store.status().jobs.every(j => j.state === 'completed'), true);
});

test('invalid signatures, other repositories/installations and unauthorized reruns never queue work', async t => {
  const h = await harness(t); const post = await http(t, h);
  assert.equal((await post('pull_request', { action: 'opened', number: 1 }, 'bad', false)).status, 401);
  await post('pull_request', { action: 'opened', number: 1, installation: { id: 22 } }, 'other-installation');
  await post('pull_request', { action: 'opened', number: 1, repository: { id: 43, full_name: h.config.repository } }, 'other-repo');
  const comment = { action: 'created', issue: { number: 1, pull_request: {} }, sender: { id: 9 }, comment: { body: '/atmin review', user: { id: 9, login: 'stranger', type: 'User' } } };
  await post('issue_comment', comment, 'untrusted');
  assert.equal(h.store.status().jobs.length, 0);
  comment.comment.user.login = 'maintainer';
  await post('issue_comment', comment, 'trusted');
  assert.equal(h.store.status().jobs.length, 1);
  comment.sender.id = 8;
  await post('issue_comment', comment, 'spoofed-actor');
  assert.equal(h.store.status().jobs.length, 1);
});

test('service starts paused; disabling or installation removal cancels queued work', async t => {
  const h = await harness(t); const post = await http(t, h);
  h.store.enable(false);
  await post('pull_request', { action: 'opened', number: 1 });
  assert.equal(h.store.status().jobs.length, 0);
  h.store.enable(true);
  await post('pull_request', { action: 'opened', number: 1 }, 'enabled');
  await post('installation_repositories', { repositories_removed: [{ id: 42 }] }, 'removed');
  assert.equal(h.store.enabled(), false);
  assert.equal(h.store.status().jobs[0].state, 'cancelled');
  assert.equal(await h.worker.tick(), false);
});

test('draft / closed PRs skip inference using canonical state, not event ordering', async t => {
  const h = await harness(t); const post = await http(t, h);
  h.setLive({ draft: true });
  await post('pull_request', { action: 'opened', number: 1 });
  await h.worker.tick();
  assert.equal(h.store.status().jobs[0].state, 'skipped');
  h.setLive({ draft: false, state: 'open' });
  // An older close delivery arrives after reopening: worker consults live state.
  await post('pull_request', { action: 'closed', number: 1 }, 'older-close');
  await h.worker.tick();
  assert.equal(h.counts.runs, 1);
  h.setLive({ state: 'closed' });
  await post('pull_request', { action: 'closed', number: 1 }, 'closed');
  await h.worker.tick();
  assert.match(h.comment.body, /inactive/);
  assert.equal(h.counts.runs, 1);
});

// Lors's pricing (2026-09-24) bills each review beyond the free allowance, so the PR comment
// that delivers the review says what it cost; the price is read when the comment is written.
test('the published review says what it costs the organization', async t => {
  const h = await harness(t);
  const asked = [];
  const worker = new Worker(h.config, h.store, h.github, inline(h.runner), 'owner', undefined, undefined, undefined,
    job => { asked.push(job); return { month: '2026-09', index: 20, freeReviews: 20, free: false, usd: 0.0425 }; });
  const id = h.store.enqueue('priced', 1);
  await worker.tick();
  assert.equal(h.store.get(id).state, 'completed');
  assert.ok(h.comment.body.includes('**This review costs $0.043**. It is review 21 in September 2026, after 20 free.'), h.comment.body);
  assert.equal(asked.at(-1).id, id); assert.notEqual(asked.at(-1).started, null);
});

test('new push aborts active investigation and only replacement work can publish', async t => {
  const h = await harness(t);
  let started; const ready = new Promise(done => { started = done; });
  let aborted = false;
  const runner = async (job, signal) => {
    if (job.id !== id) return h.runner(job, signal);
    started(); await new Promise(done => signal.addEventListener('abort', () => { aborted = true; done(); }, { once: true })); throw new Error('cancelled');
  };
  const worker = new Worker(h.config, h.store, h.github, inline(runner, { background: true }), 'owner');
  const id = h.store.enqueue('first', 1);
  await worker.tick(); await ready;
  assert.equal(h.store.get(id).state, 'dispatched', 'the worker does not wait on the runner');
  h.store.enqueue('replacement', 1);
  await worker.tick();
  assert.equal(h.checks[0].conclusion, 'cancelled');
  assert.equal(aborted, true); assert.equal(h.store.get(id).state, 'cancelled');
  assert.equal(h.counts.creates, 0);
  // The same tick offered the replacement, which a later tick collects and publishes.
  await worker.tick(); assert.equal(h.counts.creates, 1);
});

test('pausing an active rerun replaces the pending summary and cancels its check', async t => {
  const h = await harness(t);
  h.store.enqueue('initial', 1); await h.worker.tick();
  let started; const ready = new Promise(done => { started = done; });
  const runner = async (_job, signal) => {
    started(); await new Promise(done => signal.addEventListener('abort', done, {once: true}));
    throw new Error('cancelled');
  };
  const worker = new Worker(h.config, h.store, h.github, inline(runner, { background: true }), 'owner');
  const id = h.store.enqueue('rerun', 1);
  await worker.tick(); await ready;
  h.store.enable(false); await worker.tick();
  assert.equal(h.store.get(id).state, 'cancelled');
  assert.equal(h.checks[1].conclusion, 'cancelled');
  assert.match(h.comment.body, /review paused/);
  assert.doesNotMatch(h.comment.body, /review pending/);
});

test('target branch changes before publication suppress the obsolete report', async t => {
  const h = await harness(t);
  const runner = async (job, signal) => { const path = await h.runner(job, signal); h.setLive({ baseSha: 'b'.repeat(40) }); return path; };
  const worker = new Worker(h.config, h.store, h.github, inline(runner), 'owner');
  const id = h.store.enqueue('first', 1); await worker.tick();
  assert.equal(h.store.get(id).state, 'cancelled'); assert.equal(h.counts.creates, 0);
});

test('push during GitHub publication replaces summary with an explicit superseded state', async t => {
  const h = await harness(t); const create = h.github.create;
  h.github.create = async (...args) => { const id = await create(...args); h.setLive({ headSha: 'c'.repeat(40) }); return id; };
  const id = h.store.enqueue('first', 1); await h.worker.tick();
  assert.equal(h.store.get(id).state, 'cancelled'); assert.match(h.comment.body, /superseded/);
});

test('unknown create outcome reconciles an accepted comment without another model call or create', async t => {
  const h = await harness(t); const create = h.github.create;
  h.github.create = async (...args) => { await create(...args); throw new Error('connection lost after acceptance'); };
  const id = h.store.enqueue('first', 1); await h.worker.tick();
  assert.equal(h.store.get(id).state, 'uncertain');
  assert.equal(h.store.retryPublication(1), true);
  await h.worker.tick();
  assert.equal(h.store.get(id).state, 'completed');
  assert.deepEqual(h.counts, { runs: 1, creates: 1, updates: 1 });
});

test('unknown create with no visible comment never blindly repeats POST, even on a new rerun', async t => {
  const h = await harness(t); let attempts = 0;
  h.github.create = async () => { attempts++; throw new Error('unknown acceptance'); };
  const id = h.store.enqueue('first', 1); await h.worker.tick();
  h.store.retryPublication(1); await h.worker.tick();
  assert.equal(h.store.get(id).state, 'uncertain'); assert.equal(attempts, 1);
  h.store.enqueue('rerun', 1); await h.worker.tick();
  assert.equal(attempts, 1);
});

test('persisted publishing state survives a worker restart without another model call', async t => {
  const h = await harness(t); const summary = h.github.summary; let scans = 0;
  h.github.summary = async (...args) => { if (++scans === 2) throw new Error('publication unavailable'); return summary(...args); };
  const id = h.store.enqueue('first', 1); await h.worker.tick();
  assert.equal(h.store.get(id).state, 'failed');
  // Simulate a crash after the report was saved and before the HTTP publication began.
  h.store.update(id, { state: 'publishing' }); h.store.release('owner');
  assert.equal(h.store.acquire('replacement'), true);
  const worker = new Worker(h.config, h.store, h.github, inline(h.runner), 'replacement');
  await worker.tick();
  assert.equal(h.counts.runs, 1); assert.equal(h.counts.creates, 1);
});

test('persistent deliveries, singleton lease and interrupted spend survive database reopen', t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-reopen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new Store(root);
  assert.equal(store.enabled(), false); store.enable(true);
  assert.equal(store.acquire('one'), true); assert.equal(store.acquire('two'), false);
  const id = store.enqueue('delivery', 1); const job = store.next('one');
  assert.equal(store.reserve(job, 'one', 6), true);
  store.close(); store = new Store(root);
  assert.equal(store.enqueue('delivery', 1), null);
  assert.equal(store.acquire('two', Date.now() + 31_000), true);
  assert.equal(store.get(id).state, 'failed'); assert.notEqual(store.get(id).started, null);
  assert.equal(store.next('two'), null); store.close();
});

test('daily starts are durably capped, including cancelled and failed investigations', async t => {
  const h = await harness(t); h.config.maxReviewsPerDay = 1;
  h.store.enqueue('one', 1); await h.worker.tick();
  h.store.enqueue('two', 1); await h.worker.tick();
  assert.equal(h.counts.runs, 1); assert.match(h.comment.body, /24-hour review limit/);
});

test('a target-branch push queues only tracked open PRs and replay does not queue again', async t => {
  const h = await harness(t); const post = await http(t, h);
  h.store.enqueue('first', 1); await h.worker.tick();
  h.setLive({ baseSha: 'd'.repeat(40) });
  await post('push', { ref: 'refs/heads/unrelated' }, 'unrelated');
  assert.equal(h.store.status().jobs.length, 1);
  await post('push', { ref: 'refs/heads/main' }, 'target');
  await post('push', { ref: 'refs/heads/main' }, 'target');
  assert.equal(h.store.status().jobs.length, 2);
  await h.worker.tick();
  assert.equal(h.counts.runs, 2); assert.match(h.comment.body, new RegExp('d'.repeat(40)));
});

test('worker crash during inference publishes saved interruption state without repeating inference', async t => {
  const h = await harness(t);
  const id = h.store.enqueue('first', 1);
  const job = h.store.next('owner'); h.store.reserve(job, 'owner', 6);
  h.store.update(id, { report: JSON.stringify({ initial: h.live, body: '# atmin review — interrupted\nNo completed review is claimed.' }) });
  h.store.release('owner'); assert.equal(h.store.acquire('new-owner'), true);
  const worker = new Worker(h.config, h.store, h.github, inline(h.runner), 'new-owner');
  await worker.tick();
  assert.equal(h.counts.runs, 0); assert.match(h.comment.body, /interrupted/);
});

test('lost worker lease fences publication even when an uncooperative runner returns', async t => {
  const h = await harness(t);
  const runner = async (job, signal) => { const directory = await h.runner(job, signal); h.store.release('owner'); h.store.acquire('replacement'); return directory; };
  const worker = new Worker(h.config, h.store, h.github, inline(runner), 'owner');
  h.store.enqueue('first', 1); await worker.tick();
  assert.equal(h.counts.creates, 0);
});

test('partial results remain visibly incomplete in the GitHub summary', async t => {
  const h = await harness(t);
  const runner = async (job, signal) => {
    const directory = await h.runner(job, signal);
    const result = completed(h.fixture.packet); result.status = 'partial';
    result.validation.forEach(check => { check.status = 'not-run'; });
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result));
    return directory;
  };
  const worker = new Worker(h.config, h.store, h.github, inline(runner), 'owner');
  h.store.enqueue('first', 1); await worker.tick();
  assert.match(h.comment.body, /Review incomplete/); assert.match(h.comment.body, /not-run/);
  assert.equal(h.checks[0].conclusion, 'failure');
});

test('engine failures publish an honest failure summary; no successful review is invented', async t => {
  const h = await harness(t);
  const worker = new Worker(h.config, h.store, h.github, inline(async () => { throw new Error('secret-provider-body'); }), 'owner');
  h.store.enqueue('one', 1); await worker.tick();
  assert.equal(h.checks[0].conclusion, 'failure');
  assert.match(h.comment.body, /review failed/); assert.doesNotMatch(h.comment.body, /secret-provider-body/);
});

test('child environments omit controller secrets and separate source/model credentials', () => {
  const captured = childEnvironment('/private/job', { GH_TOKEN: 'read-token' });
  const inference = childEnvironment('/private/job', { OPENROUTER_API_KEY: 'model-key' });
  assert.equal(captured.OPENROUTER_API_KEY, undefined);
  assert.equal(inference.GH_TOKEN, undefined);
  assert.equal(inference.GITHUB_APP_PRIVATE_KEY_PATH, undefined);
  assert.equal(inference.GITHUB_WEBHOOK_SECRET, undefined);
  assert.equal(inference.NODE_OPTIONS, undefined);
  assert.equal(inference.GH_CONFIG_DIR, '/private/job/gh');
});

// Each review fetches the repository's history into its run directory (164-175 MB for
// mason-v1, measured 2026-09-26) and nothing else ever deleted it, so a busy repository
// filled the worker's disk. The JSON records beside it are what everything later reads.
test('a run keeps its review records but not its copy of the repository, whether or not it finished', async t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = JSON.parse(readFileSync(new URL('../profiles/review-luna-openrouter.json', import.meta.url), 'utf8'));
  const run = join(root, 'runs', 'job-1');
  mkdirSync(join(run, 'source.git', 'objects'), { recursive: true });
  writeFileSync(join(run, 'source.git', 'objects', 'pack'), 'history');
  writeFileSync(join(run, 'packet.json'), '{}');
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(hostedReview({ job: 'job-1', repository: 'o/r', pr: 1, token: 'read-token', previous: null, profile }, run, join(root, 'cache.git'), stopped.signal, {}), /cancelled/);
  assert.equal(existsSync(join(run, 'source.git')), false);
  assert.equal(existsSync(join(run, 'packet.json')), true);
});

// Every runner and review runs as one user, so the sandbox is what keeps one organization's
// review from reading another's code: it mounts only the paths it is given.
test('a review child sees only its own run, its own repository and the system, not other repositories', () => {
  const args = childSandbox('/private/home', { writable: ['/runs/job-1'], readable: ['/cache/org-a__repo'] }, '/opt/app', '/opt/node/bin/node');
  const mounted = [];
  for (let i = 0; i < args.length; i++) if (['--bind', '--ro-bind', '--ro-bind-try'].includes(args[i])) { mounted.push([args[i], args[i + 1]]); i += 2; }
  const writable = mounted.filter(([kind]) => kind === '--bind').map(([, path]) => path);
  assert.deepEqual(writable, ['/private/home', '/runs/job-1']);
  assert.ok(mounted.some(([kind, path]) => kind === '--ro-bind' && path === '/cache/org-a__repo'));
  assert.ok(mounted.some(([kind, path]) => kind === '--ro-bind' && path === '/opt/app'));
  for (const [, path] of mounted) {
    assert.ok(!['/', '/etc', '/var', '/var/lib', '/home', '/cache', '/runs', '/etc/atmin-review'].includes(path), `${path} would expose more than this review`);
    assert.ok(!path.startsWith('/var/lib/atmin'), `${path} is service or runner state`);
  }
  assert.ok(args.includes('--unshare-all') && args.includes('--share-net') && args.includes('--die-with-parent'));
  // A fresh /proc fails under the runner unit's ProtectKernelTunables, and the host's would
  // show other processes' environments.
  assert.ok(!args.includes('--proc') && !mounted.some(([, path]) => path === '/proc'));
  assert.equal(args.at(-1), '--');
});

test('a sandboxed child cannot read another repository\'s copy', { skip: process.env.ATMIN_REVIEW_VERIFY_LINUX !== '1' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-sandbox-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['home', 'run', 'org-a', 'org-b']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'org-a', 'code'), 'a'); writeFileSync(join(root, 'org-b', 'code'), 'b');
  const read = path => spawnSync('bwrap', [...childSandbox(join(root, 'home'), { writable: [join(root, 'run')], readable: [join(root, 'org-a')] }), '/bin/cat', path], { encoding: 'utf8' });
  assert.equal(read(join(root, 'org-a', 'code')).stdout, 'a');
  const other = read(join(root, 'org-b', 'code'));
  assert.notEqual(other.status, 0); assert.equal(other.stdout, '');
});

// Lors, 2026-10-03: a repository's code stays on a runner only while it is being reviewed, and
// is deleted after a day with no review; the next review fetches it again.
test('a repository copy is deleted after a day without a review, and a recently used one is kept', t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-copies-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  for (const [name, age] of [['idle', REPOSITORY_IDLE_MS + 60_000], ['recent', REPOSITORY_IDLE_MS - 60_000]]) {
    mkdirSync(join(root, name, 'source.git'), { recursive: true });
    const at = new Date(now - age); utimesSync(join(root, name), at, at);
  }
  assert.equal(expireIdleCopies(root, now), 1);
  assert.equal(existsSync(join(root, 'idle')), false);
  assert.equal(existsSync(join(root, 'recent', 'source.git')), true);
  assert.equal(expireIdleCopies(join(root, 'missing'), now), 0);
});

test('App JWT verifies, installation tokens are repository scoped, forged summary marker is ignored', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const jwt = appJwt('123', key, 1_700_000_000_000);
  const [header, claims, signature] = jwt.split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iat: 1699999940, exp: 1700000540, iss: '123' });
  const requests = []; const marker = markerFor(42, 1);
  const transport = async (url, init) => {
    requests.push({ url, ...init });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'stateless-token-of-arbitrary-length', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (url.endsWith('/app')) return Response.json({ slug: 'atmin-test' });
    if (url.endsWith('/repos/test/review-fixture')) return Response.json({ id: 42, full_name: 'test/review-fixture' });
    if (url.includes('/comments?')) return Response.json([
      { id: 5, body: `${marker}\nforged`, user: { login: 'attacker', type: 'User' } },
      { id: 6, body: `${marker}\nreal`, user: { login: 'atmin-test[bot]', type: 'Bot' } },
    ]);
    if (url.endsWith('/comments')) return Response.json({ id: 7 });
    throw new Error('Unexpected request');
  };
  const api = new AppGitHub({ repository: 'test/review-fixture', repositoryId: 42, installationId: 21 }, '123', key, transport);
  assert.equal((await api.summary(1, marker)).id, 6);
  await api.create(1, 'summary');
  assert.deepEqual(await api.verifyInstallation(), { repository: 'test/review-fixture', bot: 'atmin-test[bot]' });
  const tokens = requests.filter(r => r.url.endsWith('/access_tokens')).map(r => JSON.parse(r.body));
  assert.deepEqual(tokens, [
    { repository_ids: [42], permissions: { contents: 'read', pull_requests: 'read' } },
    { repository_ids: [42], permissions: { pull_requests: 'write' } },
    { repository_ids: [42], permissions: { checks: 'write' } },
  ]);
  assert.equal(requests.every(r => r.redirect === 'error' && r.url.startsWith('https://api.github.com/')), true);
});

test('compiled pilot CLI starts paused, serves a signed ping and shuts down cleanly without GitHub access', async t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-pilot-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ repository: 'test/review-fixture', repositoryId: 42, installationId: 21,
    profile: fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url)),
    stateDirectory: join(root, 'state'), host: '127.0.0.1', port, maxReviewsPerDay: 6, minFreeDiskMb: 0 }));
  const key = join(root, 'fake.pem'); writeFileSync(key, 'offline fixture; no API calls are permitted');
  const cli = fileURLToPath(new URL('../dist/github/cli.js', import.meta.url));
  const env = childEnvironment(root, { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: key, GITHUB_WEBHOOK_SECRET: secret, ATMIN_RUNNER_POOL_TOKEN: 'p'.repeat(32) });
  const proc = spawn(process.execPath, [cli, 'serve', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); });
  const startup = await Promise.race([once(proc.stdout, 'data'), once(proc, 'exit').then(() => { throw new Error('Service exited before listening'); })]);
  assert.equal(JSON.parse(startup[0].toString()).enabled, false);
  const body = JSON.stringify({ zen: 'explicit offline ping' });
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/github`, { method: 'POST', body,
    headers: { 'x-github-event': 'ping', 'x-github-delivery': 'offline-ping', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
  assert.equal(await response.text(), 'pong\n');
  const status = spawnSync(process.execPath, [cli, 'status', config], { env, encoding: 'utf8' });
  assert.equal(status.status, 0); assert.deepEqual(JSON.parse(status.stdout), { enabled: false, jobs: [] });
  const closed = once(proc, 'exit'); proc.kill('SIGTERM');
  assert.equal((await closed)[0], 0);
});


test('check verdict requires completion, validation and current evidence; P3/P4 alone pass', t => {
  const f = repository(t);
  for (const priority of ['P0', 'P1', 'P2', 'P3', 'P4']) {
    const result = completed(f.packet); result.findings = [finding(priority)];
    const check = assessmentCheck(assess(f.packet, result, current()));
    assert.equal(check.conclusion, ['P0', 'P1', 'P2'].includes(priority) ? 'failure' : 'success');
  }
  const result = completed(f.packet);
  result.validation[0].status = 'not-run';
  // CI still outstanding on an otherwise clean review is pending, not red: the review never waits for CI.
  const pending = assessmentCheck(assess(f.packet, result, current()));
  assert.equal(pending.status, 'in_progress'); assert.equal(pending.conclusion, undefined);
  // A blocking finding stays red whatever CI is doing.
  result.findings = [finding('P2')];
  assert.equal(assessmentCheck(assess(f.packet, result, current())).conclusion, 'failure');
  assert.equal(assessmentCheck(assess(f.packet, completed(f.packet), {...current(), status: 'superseded'})).conclusion, 'failure');
});

test('a repository without a policy file requires no CI, so a clean review passes without waiting', t => {
  // Most repositories have no check named change-validation; requiring it by default left their checks pending forever.
  const f = repository(t);
  f.run('checkout', '-q', f.state.baseSha);
  f.run('rm', '-q', '.atmin/review.json');
  const baseSha = f.commit('no policy file');
  f.write('update.ts', 'export function update(owner, account) {\n  return "updated";\n}\n');
  const headSha = f.commit('remove the guard');
  const { packet } = capture(f.source, { ...f.state, baseSha, headSha });
  assert.deepEqual(packet.policy.requiredChecks, []);
  const check = assessmentCheck(assess(packet, completed(packet), current()));
  assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'success');
  const result = completed(packet); result.findings = [finding('P2')];
  assert.equal(assessmentCheck(assess(packet, result, current())).conclusion, 'failure');
});

// On 2026-09-28 a finished 5/5 review's check turned "Review failed" after its comment was
// posted, and the job said only "service-or-github-failure": nothing recorded which step or
// request broke, so the cause could not be found. The job and the log now name it.
test('a review that fails after publishing records which GitHub request failed', async t => {
  const h = await harness(t), update = h.github.updateCheck;
  h.github.updateCheck = async (id, output) => {
    if (output.conclusion === 'success') throw new GitHubError(502, 'PATCH /repos/test/review-fixture/check-runs/1');
    return update(id, output);
  };
  const logged = [];
  t.mock.method(process.stderr, 'write', line => { logged.push(String(line)); return true; });
  const id = h.store.enqueue('late', 1); await h.worker.tick();
  t.mock.restoreAll();
  assert.match(h.comment.body, /5\/5/);
  assert.equal(h.store.get(id).state, 'failed');
  assert.match(h.store.get(id).error, /\(GitHub 502 on PATCH \/repos\/test\/review-fixture\/check-runs\/1\)/);
  assert.ok(logged.some(line => line.includes(`review ${id} of PR 1 failed: GitHub 502 on PATCH /repos/test/review-fixture/check-runs/1`)));
  assert.equal(h.checks[0].output.title, 'Review failed');
});

test('a failed GitHub request names its method and path, never its response', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  let mode = 'status';
  const api = new AppGitHub({ repository: 'test/review-fixture', repositoryId: 42, installationId: 21 }, '123', key, async url => {
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (mode === 'status') return new Response('{"message":"secret response body"}', { status: 502 });
    if (mode === 'timeout') throw new DOMException('timed out', 'TimeoutError');
    return new Response('not json');
  });
  const failure = async call => { try { await call(); } catch (error) { return error; } assert.fail('the request should fail'); };
  const check = () => api.updateCheck(5, { status: 'completed' });
  const status = await failure(check);
  assert.equal(failureCause(status), 'GitHub 502 on PATCH /repos/test/review-fixture/check-runs/5');
  assert.doesNotMatch(JSON.stringify({ ...status, message: status.message }), /secret response body/);
  assert.equal(failureCause(await failure(() => api.findCheck('abc', 'job'))), 'GitHub 502 on GET /repos/test/review-fixture/commits/abc/check-runs');
  mode = 'timeout';
  assert.equal(failureCause(await failure(check)), 'GitHub no response in 8 s on PATCH /repos/test/review-fixture/check-runs/5');
  mode = 'text';
  assert.equal(failureCause(await failure(check)), 'GitHub unreadable response on PATCH /repos/test/review-fixture/check-runs/5');
});

test('lost check creation response reconciles without duplicate checks or inference', async t => {
  const h = await harness(t), create = h.github.createCheck;
  h.github.createCheck = async (...args) => { await create(...args); throw new Error('response lost'); };
  const id = h.store.enqueue('check-lost', 1); await h.worker.tick();
  assert.equal(h.checks.length, 1); assert.equal(h.counts.runs, 0);
  assert.equal(h.store.get(id).state, 'failed');
  assert.equal(h.store.retryPublication(1), true); await h.worker.tick();
  assert.equal(h.checks.length, 1); assert.equal(h.counts.runs, 0);
  assert.equal(h.checks[0].conclusion, 'failure');
});

test('an invisible uncertain check create is not repeated after reconciliation', async t => {
  const h = await harness(t); let attempts = 0;
  h.github.createCheck = async () => { attempts++; throw new Error('unknown outcome'); };
  h.store.enqueue('uncertain-check', 1); await h.worker.tick();
  h.store.retryPublication(1); await h.worker.tick();
  assert.equal(attempts, 1); assert.equal(h.counts.runs, 0);
});

test('head movement during final check write cancels its apparent success', async t => {
  const h = await harness(t), update = h.github.updateCheck;
  h.github.updateCheck = async (id, output) => { await update(id, output); if (output.conclusion === 'success') h.setLive({headSha: 'f'.repeat(40)}); };
  h.store.enqueue('check-race', 1); await h.worker.tick();
  assert.equal(h.checks[0].conclusion, 'cancelled');
});

test('completed publication can be reconciled to add a check without another review start', async t => {
  const h = await harness(t);
  h.store.enqueue('original', 1); await h.worker.tick();
  const before = h.store.status().jobs[0].started;
  assert.equal(h.store.retryPublication(1), true); await h.worker.tick();
  assert.equal(h.counts.runs, 1); assert.equal(h.checks.length, 1);
  assert.equal(h.store.status().jobs[0].started, before);
});

test('trusted CI requires exact App, check name and head; skipped, conflicting and unavailable evidence never passes', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const head = 'a'.repeat(40);
  const good = { id: 9, name: 'change-validation', app: { id: 15368 }, head_sha: head, status: 'completed', conclusion: 'success' };
  let runs = [good], unavailable = false;
  const config = { repository: 'test/review-fixture', repositoryId: 42, installationId: 21, trustedChecks: [{ name: good.name, appId: good.app.id }] };
  const api = new AppGitHub(config, '123', privateKey.export({ format: 'pem', type: 'pkcs8' }), async url => {
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'fixture', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    assert.ok(url.includes(`/commits/${head}/check-runs?`));
    assert.equal(new URL(url).searchParams.get('app_id'), '15368');
    if (unavailable) throw new Error('private transport failure');
    return Response.json({ total_count: runs.length, check_runs: runs });
  });
  for (const [patch, expected] of [[{}, 'pass'], [{ conclusion: 'failure' }, 'fail'], [{ conclusion: 'timed_out' }, 'fail'],
    [{ conclusion: 'skipped' }, 'not-run'], [{ conclusion: 'neutral' }, 'not-run'], [{ conclusion: 'cancelled' }, 'not-run'],
    [{ status: 'in_progress' }, 'not-run'], [{ head_sha: 'b'.repeat(40) }, 'not-run'], [{ app: { id: 999 } }, 'not-run'], [{ name: 'other' }, 'not-run']]) {
    runs = [{ ...good, ...patch }];
    assert.equal((await api.validation(head, [good.name]))[0].status, expected);
  }
  runs = []; assert.equal((await api.validation(head, [good.name]))[0].status, 'not-run');
  // CI on both push and pull_request leaves two runs of one check on one head (atmin-inc/review
  // PR 9): two successes pass, and a second run can never turn a failure or a pending run into a pass.
  for (const [second, expected] of [[{}, 'pass'], [{ conclusion: 'failure' }, 'fail'], [{ status: 'in_progress' }, 'not-run'],
    [{ conclusion: 'skipped' }, 'not-run'], [{ app: { id: 999 } }, 'not-run'], [{ head_sha: 'b'.repeat(40) }, 'not-run']]) {
    runs = [good, { ...good, id: 10, ...second }];
    const [check] = await api.validation(head, [good.name]);
    assert.equal(check.status, expected);
    if (expected === 'fail') assert.match(check.url, /\/runs\/10$/);
  }
  runs = [good, { ...good, id: 10 }];
  assert.match((await api.validation(head, [good.name]))[0].reason, /check 9 \(and 1 more run of it on this head\): passed/);
  unavailable = true;
  assert.match((await api.validation(head, [good.name]))[0].reason, /could not be retrieved/);
  assert.deepEqual(await api.validation(head, ['unmapped']), []);
});

test('CI reconciliation refreshes the same report and check without inference or trusting an old pass', async t => {
  const h = await harness(t);
  let status = 'not-run';
  h.github.validation = async (head, names) => {
    assert.equal(head, h.live.headSha); assert.deepEqual(names, ['change-validation']);
    return [{ name: 'change-validation', status, reason: 'Controller CI fixture.' }];
  };
  h.store.enqueue('ci-first', 1); await h.worker.tick();
  assert.equal(h.checks[0].status, 'in_progress'); assert.equal(h.checks[0].conclusion, undefined);
  assert.match(h.comment.body, /5\/5 — Waiting for required checks/);
  status = 'pass'; h.store.retryPublication(1); await h.worker.tick();
  assert.equal(h.checks[0].conclusion, 'success');
  status = 'fail'; h.store.retryPublication(1); await h.worker.tick();
  assert.equal(h.checks[0].conclusion, 'failure');
  assert.match(h.comment.body, /Required checks failed/);
  assert.equal(h.counts.runs, 1); assert.equal(h.counts.creates, 1); assert.equal(h.checks.length, 1);
});

test('operator CI trust configuration rejects ambiguous names and self-referential checks', async t => {
  const { readConfig } = await import('../dist/github/config.js');
  const h = state(t);
  const path = join(h.root, 'config.json');
  const base = { ...h.config, port: 8787, profile: fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url)) };
  for (const trustedChecks of [[{ name: 'change-validation', appId: 1 }], undefined]) {
    writeFileSync(path, JSON.stringify({ ...base, trustedChecks })); assert.equal(readConfig(path).port, 8787);
  }
  for (const trustedChecks of [[{ name: 'atmin review', appId: 1 }], [{ name: 'ci', appId: 0 }], [{ name: 'ci', appId: 1 }, { name: 'ci', appId: 2 }], [{ name: 'ci', appId: 1, allowSkipped: true }]]) {
    writeFileSync(path, JSON.stringify({ ...base, trustedChecks })); assert.throws(() => readConfig(path), /Trusted checks/);
  }
});

test('trusted check events refresh saved evidence, ignore payload verdicts and never reserve another run', async t => {
  const h = await harness(t), post = await http(t, h);
  h.config.trustedChecks = [{ name: 'change-validation', appId: 15368 }];
  let status = 'not-run';
  h.github.validation = async () => [{ name: 'change-validation', status, reason: 'Canonical API fixture.' }];
  const id = h.store.enqueue('source', 1); await h.worker.tick();
  const started = h.store.get(id).started;
  const event = { action: 'completed', check_run: { name: 'change-validation', app: { id: 15368 }, head_sha: h.live.headSha, conclusion: 'success', pull_requests: [] } };
  await post('check_run', event, 'ci-1'); await h.worker.tick();
  assert.equal(h.checks[0].status, 'in_progress'); // The webhook cannot attest a pass.
  status = 'pass';
  await post('check_run', event, 'ci-2'); await h.worker.tick();
  assert.equal(h.checks[0].conclusion, 'success');
  assert.equal((await post('check_run', event, 'ci-2')).status, 200);
  assert.equal(await h.worker.tick(), false);
  status = 'not-run';
  await post('check_run', { ...event, action: 'created' }, 'ci-rerun'); await h.worker.tick();
  assert.equal(h.checks[0].status, 'in_progress'); assert.equal(h.checks[0].conclusion, undefined); // An old pass is not trusted.
  assert.equal(h.store.get(id).started, started);
  assert.equal(h.counts.runs, 1); assert.equal(h.counts.creates, 1); assert.equal(h.checks.length, 1);
});

test('untrusted, stale, malformed and paused CI events cannot refresh or start work', async t => {
  const h = await harness(t), post = await http(t, h);
  h.config.trustedChecks = [{ name: 'change-validation', appId: 15368 }];
  h.store.enqueue('source', 1); await h.worker.tick();
  const check = { name: 'change-validation', app: { id: 15368 }, head_sha: h.live.headSha };
  for (const [i, patch] of [{ app: { id: 99 } }, { name: 'atmin review' }, { head_sha: 'f'.repeat(40) }, { head_sha: [] }].entries()) {
    await post('check_run', { action: 'completed', check_run: { ...check, ...patch } }, `ignored-${i}`);
    assert.equal(await h.worker.tick(), false);
  }
  h.store.enable(false);
  await post('check_run', { action: 'completed', check_run: check }, 'paused-ci');
  h.store.enable(true); assert.equal(await h.worker.tick(), false);
  assert.equal(h.counts.runs, 1);
});

test('CI arriving during publication survives until a second pass, including a worker restart', async t => {
  const h = await harness(t);
  let reads = 0;
  h.github.validation = async () => {
    if (++reads === 1) h.store.refreshValidation('ci-during-write', h.live.headSha);
    return [{ name: 'change-validation', status: reads === 1 ? 'not-run' : 'pass', reason: 'Concurrent CI fixture.' }];
  };
  h.store.enqueue('source', 1); await h.worker.tick();
  assert.equal(h.checks[0].status, 'in_progress');
  h.store.release('owner'); assert.equal(h.store.acquire('replacement'), true);
  const worker = new Worker(h.config, h.store, h.github, inline(h.runner), 'replacement');
  assert.equal(await worker.tick(), true);
  assert.equal(h.checks[0].conclusion, 'success'); assert.equal(h.counts.runs, 1);
  assert.equal(await worker.tick(), false);
});

test('inline findings map exact diff lines and renames while keeping unavailable anchors in the summary', t => {
  const f = repository(t);
  const make = (side, line, path = 'old.ts') => ({ ...finding(), anchor: { path, side, line } });
  const files = [{ filename: 'new.ts', previous_filename: 'old.ts', patch: '@@ -1,3 +1,3 @@\n same\n-old\n+new\n last\n@@ -20,1 +20,1 @@\n-before\n+after\n\\ No newline at end of file' }];
  const comments = inlineComments(f.packet, [make('base', 2), make('head', 2, 'new.ts'), make('head', 3, 'new.ts'), make('head', 20, 'new.ts'), make('base', 1), make('head', 99, 'new.ts')], files);
  assert.deepEqual(comments.map(({path, side, line}) => ({path, side, line})), [
    {path: 'new.ts', side: 'LEFT', line: 2}, {path: 'new.ts', side: 'RIGHT', line: 2},
    {path: 'new.ts', side: 'RIGHT', line: 3}, {path: 'new.ts', side: 'RIGHT', line: 20},
  ]);
  assert.equal(inlineComments(f.packet, [make('base', 2)], [{filename: 'old.ts', patch: '@@ -1,2 +0,0 @@\n-one\n-two'}])[0].side, 'LEFT');
  assert.equal(inlineComments(f.packet, [make('head', 2, 'new.ts')], [{filename: 'new.ts'}]).length, 0);
  const large = { ...make('head', 2, 'new.ts'), title: '@everyone <script>'.repeat(1000) };
  const bounded = inlineComments(f.packet, Array(30).fill(large), files);
  assert.equal(bounded.length, 20); assert.ok(bounded.every(c => c.body.length < 8000));
  assert.doesNotMatch(bounded[0].body, /@everyone|<script>/);
});

test('inline publication is commit-bound, hides optional findings and survives CI without duplicates', async t => {
  const optional = { ...finding('P4'), id: 'optional' };
  const h = await harness(t, [finding(), optional]);
  h.store.enqueue('source', 1); await h.worker.tick();
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].comments.length, 1);
  assert.equal(h.reviews[0].head, h.live.headSha);
  assert.match(h.reviews[0].comments[0].body, /Account owner guard removed/);
  h.store.refreshValidation('ci-finished', h.live.headSha); await h.worker.tick();
  assert.equal(h.reviews.length, 1); assert.equal(h.counts.runs, 1);
});
test('native fixes use exact head ranges, preserve code and suppress unsafe or conflicting suggestions', t => {
  const f = repository(t);
  const fix = { startLine: 2, endLine: 3, original: 'new\nlast', replacement: 'guard();\nnew\nlast' };
  const make = changes => ({ ...finding('P0'), anchor: { path: 'new.ts', side: 'head', line: 2 }, fix, ...changes });
  const files = [{ filename: 'new.ts', previous_filename: 'old.ts', patch: '@@ -1,3 +1,3 @@\n same\n-old\n+new\n last' }];
  const [comment] = inlineComments(f.packet, [make({})], files);
  assert.equal(comment.start_line, 2); assert.equal(comment.start_side, 'RIGHT'); assert.equal(comment.line, 3);
  assert.match(comment.body, /P0/); assert.ok(comment.body.includes('```suggestion\nguard();\nnew\nlast\n```'));
  const rejected = [
    make({ fix: { ...fix, original: 'forged\nlast' } }),
    make({ fix: { ...fix, endLine: 4, original: 'new\nlast\nmissing' } }),
    make({ fix: { ...fix, replacement: '```\n@everyone <script>' } }),
    make({ fix: { ...fix, replacement: 'unchanged\r\nline' } }),
    make({ title: 'oversized'.repeat(1000) }),
    make({ anchor: { path: 'old.ts', side: 'base', line: 2 } }),
  ];
  for (const item of rejected) {
    const [plain] = inlineComments(f.packet, [item], files);
    assert.ok(plain); assert.doesNotMatch(plain.body, /```suggestion/); assert.equal(plain.start_line, undefined);
  }
  const overlap = inlineComments(f.packet, [make({}), make({ id: 'second-cause' })], files);
  assert.equal(overlap.filter(c => c.body.includes('```suggestion')).length, 1); assert.equal(overlap.length, 2);
  const splitHunks = [{ ...files[0], patch: '@@ -2 +2 @@\n-old\n+new\n@@ -3 +3 @@\n last' }];
  assert.doesNotMatch(inlineComments(f.packet, [make({})], splitHunks)[0].body, /```suggestion/);
  const noNewline = [{ ...files[0], patch: files[0].patch + '\n\\ No newline at end of file' }];
  assert.doesNotMatch(inlineComments(f.packet, [make({})], noNewline)[0].body, /```suggestion/);
  const [deletion] = inlineComments(f.packet, [make({ fix: { ...fix, replacement: '' } })], files);
  assert.ok(deletion.body.includes('```suggestion\n\n```'));
});

// Precision on real PRs (2026-09-30): what people did with each finding is read when its PR
// closes, so an edited flagged line, a thumbs-down or a reply lands in the operator's numbers.
test('a closed PR records whether the lines of each published finding changed, and the thumbs and replies on its inline comments', async t => {
  const h = await harness(t, [finding()]);
  h.store.enqueue('source', 1); await h.worker.tick();
  const [inline] = h.reviews[0].comments;
  assert.match(inline.body, /^<!-- atmin-finding:[a-f0-9]{16} -->\n/);
  // The author puts the guard back on the flagged line, then the PR merges.
  h.fixture.write('update.ts', 'export function update(owner, account) {\n  if (owner !== account) throw new Error("forbidden");\n  return "updated";\n}\n');
  h.setLive({ headSha: h.fixture.commit('restore the guard'), state: 'closed', merged: true });
  h.github.reviewComments = async () => [
    { id: 500, reviewId: h.reviews[0].id, replyTo: null, human: false, body: inline.body, up: 2, down: 1 },
    { id: 501, reviewId: 77, replyTo: 500, human: true, body: 'Fixed, thanks.', up: 0, down: 0 },
    { id: 502, reviewId: 77, replyTo: 500, human: false, body: 'A bot replying does not count.', up: 0, down: 0 },
    // The same marker in a review that is not one of ours is not counted.
    { id: 503, reviewId: 99, replyTo: null, human: false, body: inline.body, up: 5, down: 5 },
  ];
  const closed = h.store.enqueue('closed', 1); await h.worker.tick();
  assert.equal(h.store.get(closed).state, 'skipped'); assert.match(h.comment.body, /inactive/);
  const [row] = h.store.db.prepare('SELECT * FROM outcomes').all();
  assert.deepEqual({ code: row.code, merged: row.merged, up: row.up, down: row.down, replies: row.replies, head: row.head, final: row.final, note: row.note },
    { code: 'changed', merged: 1, up: 2, down: 1, replies: 1, head: h.fixture.state.headSha, final: h.live.headSha, note: null });
  assert.deepEqual(outcomeSummary(h.store).merged, { pulls: 1, findings: 1, changed: 1, unchanged: 0, unknown: 0, up: 2, down: 1, replies: 1 });
  assert.equal(h.counts.runs, 1);
});

test('flagged lines that only moved or were reindented count as unchanged, and a read GitHub refuses is unknown with its cause', async t => {
  const h = await harness(t, [finding()]);
  h.store.enqueue('source', 1); await h.worker.tick();
  // Lines added above and a new indent leave the flagged code as it was.
  h.fixture.write('update.ts', '// header\n// more\nexport function update(owner, account) {\n    return "updated";\n}\n');
  h.setLive({ headSha: h.fixture.commit('unrelated edit'), state: 'closed', merged: false });
  h.store.enqueue('closed', 1); await h.worker.tick();
  assert.deepEqual(outcomeSummary(h.store), { merged: { pulls: 0, findings: 0, changed: 0, unchanged: 0, unknown: 0, up: 0, down: 0, replies: 0 },
    unmerged: { pulls: 1, findings: 1, changed: 0, unchanged: 1, unknown: 0, up: 0, down: 0, replies: 0 } });
  // Reopened and closed again: the last close replaces the first, and failures are kept as causes.
  h.github.file = async () => { throw new GitHubError(502, 'GET /repos/test/review-fixture/contents/update.ts'); };
  h.github.reviewComments = async () => { throw new GitHubError(0, 'GET /repos/test/review-fixture/pulls/1/comments', 'no response in 8 s'); };
  h.store.enqueue('closed-again', 1); await h.worker.tick();
  const rows = h.store.db.prepare('SELECT * FROM outcomes').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ code: rows[0].code, note: rows[0].note, up: rows[0].up }, { code: 'unknown', note: 'GitHub 502 on GET /repos/test/review-fixture/contents/update.ts', up: null });
});

test('GitHub API reads a file at a commit, review comment reactions and whether a PR merged', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {modulusLength: 2048});
  const head = 'a'.repeat(40), requested = [];
  const api = new AppGitHub({repository: 'test/review-fixture', repositoryId: 42, installationId: 21}, '123', privateKey.export({format: 'pem', type: 'pkcs8'}), async url => {
    requested.push(url);
    if (url.endsWith('/access_tokens')) return Response.json({token: 'fixture', expires_at: new Date(Date.now() + 3600_000).toISOString()});
    if (url.endsWith('/pulls/1')) return Response.json({ number: 1, state: 'closed', draft: false, merged: true, user: { id: 7, login: 'alice' }, head: { sha: head },
      base: { ref: 'main', repo: { id: 42, full_name: 'test/review-fixture' } } });
    if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'b'.repeat(40) } });
    if (url.includes('/contents/src/a%20b.ts?')) return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from('one\ntwo\n').toString('base64') });
    if (url.includes('/contents/big.bin?')) return Response.json({ type: 'file', encoding: 'none', content: '', size: 2_000_000 });
    if (url.includes('/contents/src?')) return Response.json([]);
    if (url.includes('/contents/')) return new Response('{}', { status: 404 });
    if (url.includes('/pulls/1/comments?')) return Response.json([
      { id: 5, pull_request_review_id: 3, body: 'finding', user: { login: 'atmin-test[bot]', type: 'Bot' }, reactions: { '+1': 2, '-1': 0, heart: 4 } },
      { id: 6, pull_request_review_id: 8, in_reply_to_id: 5, body: 'reply', user: { login: 'alice', type: 'User' } },
    ]);
    throw new Error('Unexpected API request');
  });
  assert.equal((await api.pull(1)).merged, true);
  assert.equal(await api.file('src/a b.ts', head), 'one\ntwo\n');
  assert.ok(requested.at(-1).endsWith(`/contents/src/a%20b.ts?ref=${head}`));
  assert.equal(await api.file('src', head), null);
  assert.equal(await api.file('gone.ts', head), null);
  await assert.rejects(api.file('big.bin', head), /not readable through the contents API \(2000000 bytes\)/);
  for (const [path, ref] of [['../secrets', head], ['a//b', head], ['a.ts', 'main']]) await assert.rejects(api.file(path, ref), /Invalid file request/);
  assert.deepEqual(await api.reviewComments(1), [
    { id: 5, reviewId: 3, replyTo: null, human: false, body: 'finding', up: 2, down: 0 },
    { id: 6, reviewId: 8, replyTo: 5, human: true, body: 'reply', up: 0, down: 0 },
  ]);
});

test('lost inline POST response reconciles by bot identity without another POST or inference', async t => {
  const h = await harness(t, [finding()]), create = h.github.createReview;
  h.github.createReview = async (...args) => { await create(...args); throw new Error('response lost'); };
  const id = h.store.enqueue('source', 1); await h.worker.tick();
  assert.equal(h.store.get(id).state, 'failed');
  h.store.retryPublication(1); await h.worker.tick();
  assert.equal(h.store.get(id).state, 'completed');
  assert.equal(h.reviews.length, 1); assert.equal(h.counts.runs, 1);
});

test('unknown invisible inline creation is never blindly retried', async t => {
  const h = await harness(t, [finding()]); let attempts = 0;
  h.github.createReview = async () => { attempts++; throw new Error('unknown acceptance'); };
  h.store.enqueue('source', 1); await h.worker.tick();
  h.store.retryPublication(1); await h.worker.tick();
  assert.equal(attempts, 1); assert.equal(h.counts.runs, 1);
});

test('head movement or lease loss while reading diff suppresses inline publication', async t => {
  for (const change of ['head', 'lease']) {
    const h = await harness(t, [finding()]), files = h.github.files;
    h.github.files = async () => {
      if (change === 'head') h.setLive({headSha: 'f'.repeat(40)});
      else { h.store.release('owner'); h.store.acquire('new-owner'); }
      return files();
    };
    h.store.enqueue(`source-${change}`, 1); await h.worker.tick();
    assert.equal(h.reviews.length, 0);
    if (change === 'head') assert.match(h.comment.body, /superseded/);
  }
});

test('the live PR carries its author, which a per-author limit counts by ID', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {modulusLength: 2048});
  let user = { id: 7, login: 'dependabot[bot]' };
  const api = new AppGitHub({repository: 'test/review-fixture', repositoryId: 42, installationId: 21}, '123', privateKey.export({format: 'pem', type: 'pkcs8'}), async url => {
    if (url.endsWith('/access_tokens')) return Response.json({token: 'fixture', expires_at: new Date(Date.now() + 3600_000).toISOString()});
    if (url.endsWith('/pulls/1')) return Response.json({ number: 1, state: 'open', draft: false, user, head: { sha: 'a'.repeat(40) },
      base: { ref: 'main', repo: { id: 42, full_name: 'test/review-fixture' } } });
    if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'b'.repeat(40) } });
    throw new Error('Unexpected API request');
  });
  assert.deepEqual((await api.pull(1)).author, { id: 7, login: 'dependabot[bot]' });
  for (const bad of [undefined, { id: 0, login: 'x' }, { id: 7, login: '@x' }]) { user = bad; await assert.rejects(api.pull(1), /Invalid live PR state/); }
});

test('GitHub inline API ignores forged reviews and submits one COMMENT batch on the supplied commit', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {modulusLength: 2048});
  const head = 'a'.repeat(40), marker = '<!-- atmin-review-inline:fixture -->', requests = [];
  const api = new AppGitHub({repository: 'test/review-fixture', repositoryId: 42, installationId: 21}, '123', privateKey.export({format: 'pem', type: 'pkcs8'}), async (url, init) => {
    requests.push({url, ...init});
    if (url.endsWith('/access_tokens')) return Response.json({token: 'fixture', expires_at: new Date(Date.now() + 3600_000).toISOString()});
    if (url.endsWith('/app')) return Response.json({slug: 'atmin-test'});
    if (url.includes('/files?')) return Response.json([{filename: 'update.ts', patch: '@@ -1 +1 @@\n-old\n+new'}]);
    if (url.includes('/reviews?')) return Response.json([
      {id: 1, commit_id: head, state: 'COMMENTED', body: `${marker}\nforged`, user: {login: 'attacker', type: 'User'}},
      {id: 2, commit_id: 'b'.repeat(40), state: 'COMMENTED', body: `${marker}\nold`, user: {login: 'atmin-test[bot]', type: 'Bot'}},
      {id: 3, commit_id: head, state: 'COMMENTED', body: `${marker}\nreal`, user: {login: 'atmin-test[bot]', type: 'Bot'}},
    ]);
    if (url.endsWith('/reviews') && init.method === 'POST') return Response.json({id: 4});
    throw new Error('Unexpected API request');
  });
  assert.equal(await api.findReview(1, head, marker), 3);
  assert.equal((await api.files(1))[0].filename, 'update.ts');
  const comments = [{path: 'update.ts', side: 'RIGHT', line: 1, body: 'Explicit test finding.'}];
  assert.equal(await api.createReview(1, head, `${marker}\nbody`, comments), 4);
  assert.deepEqual(JSON.parse(requests.at(-1).body), {commit_id: head, event: 'COMMENT', body: `${marker}\nbody`, comments});
});


test('worker enforces the dashboard daily ceiling before another model run', async t => {
  const h = await harness(t);
  h.config.profile = fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url));
  const settings = new ReviewSettings(h.config, h.store);
  settings.save({ model: 'default', maxUsd: 0, maxReviewsPerDay: 1, maxReviewsPerAuthor: null, selfRun: false });
  const worker = new Worker(h.config, h.store, h.github, inline(h.runner), 'owner', settings);
  h.store.enqueue('first-dashboard-run', 1); await worker.tick();
  h.store.enqueue('second-dashboard-run', 1); await worker.tick();
  assert.equal(h.counts.runs, 1);
  assert.match(h.comment.body, /24-hour review limit/);
  assert.equal(h.checks.at(-1).conclusion, 'failure');
});


// Lors (2026-09-24): customers can cap spend per person. Past the repository's per-author
// limit for the month, that author's PRs get the reason instead of a model run; other
// authors are unaffected, and the refusal names the author without an @-mention.
test('a PR author past the per-author monthly limit gets the reason on the PR and no model run', async t => {
  const h = await harness(t);
  h.config.profile = fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url));
  const settings = new ReviewSettings(h.config, h.store);
  settings.save({ model: 'default', maxUsd: 0, maxReviewsPerDay: 6, maxReviewsPerAuthor: 1, selfRun: false });
  const worker = new Worker(h.config, h.store, h.github, inline(h.runner), 'owner', settings);
  const first = h.store.enqueue('alice-1', 1); await worker.tick();
  assert.equal(h.counts.runs, 1); assert.equal(h.store.get(first).author, 1);
  h.store.enqueue('alice-2', 1); await worker.tick();
  assert.equal(h.counts.runs, 1);
  assert.match(h.comment.body, /PRs by `alice` reached this repository's limit of 1 review per author for \w+ \d{4}\. Reviews resume on \d{4}-\d\d-01/);
  assert.ok(!h.comment.body.includes('@alice'));
  assert.equal(h.checks.at(-1).conclusion, 'failure');
  h.setLive({ author: { id: 2, login: 'bob' } });
  h.store.enqueue('bob-1', 1); await worker.tick();
  assert.equal(h.counts.runs, 2);
  // Settings saved before the limit existed read as no limit.
  h.store.db.prepare('UPDATE review_settings SET value=?').run(JSON.stringify({ model: 'default', maxUsd: 0, maxReviewsPerDay: 6 }));
  assert.equal(settings.current().maxReviewsPerAuthor, null);
  h.setLive({ author: { id: 1, login: 'alice' } });
  h.store.enqueue('alice-3', 1); await worker.tick();
  assert.equal(h.counts.runs, 3);
  for (const bad of [0, 1.5, 100_001, '2']) assert.throws(() => settings.validate({ model: 'default', maxUsd: 0, maxReviewsPerDay: 1, maxReviewsPerAuthor: bad, selfRun: false }));
});

// Strangers' repositories share one disk. Below the configured free space no review starts,
// the PR says why, and nothing counts against the plan.
test('a review does not start when the state disk is low on space', async t => {
  const h = await harness(t); h.config.minFreeDiskMb = 1_000_000;
  const id = h.store.enqueue('low-disk', 1); await h.worker.tick();
  assert.equal(h.counts.runs, 0);
  assert.match(h.comment.body, /low on disk space, so this review did not start/);
  assert.equal(h.checks.at(-1).conclusion, 'failure');
  assert.equal(h.store.get(id).started, null);
});

// Run records are deleted after RUN_RETENTION_DAYS, except each PR's latest completed review,
// which the next push review builds on; unfinished jobs and paths outside runs/ are untouched.
test('old run records are deleted except the latest completed review of each PR', async t => {
  const h = await harness(t);
  const day = 86_400_000, now = Date.now(), runs = join(h.root, 'runs');
  const job = (pr, state, age, directory = join(runs, `${pr}-${state}-${age}`)) => {
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'receipt.json'), '{}');
    const id = h.store.enqueue(`${pr}-${state}-${age}`, pr);
    h.store.db.prepare('UPDATE jobs SET state=?, created=?, artifact=? WHERE id=?').run(state, now - age * day, directory, id);
    return { id, directory };
  };
  const oldest = job(1, 'completed', 200), older = job(1, 'failed', 150), latest = job(1, 'completed', 120);
  const recent = job(2, 'completed', 10), stale = job(2, 'completed', 95), queued = job(3, 'queued', 100);
  const outside = job(4, 'failed', 300, join(h.root, 'elsewhere')), kept = job(4, 'completed', 5);
  assert.equal(expireRuns(h.config, h.store, now), 4);
  for (const gone of [oldest, older, stale]) { assert.equal(existsSync(gone.directory), false); assert.equal(h.store.get(gone.id).artifact, null); }
  for (const stays of [latest, recent, queued, kept]) { assert.equal(existsSync(stays.directory), true); assert.equal(h.store.get(stays.id).artifact, stays.directory); }
  assert.equal(existsSync(outside.directory), true); assert.equal(h.store.get(outside.id).artifact, null);
  assert.equal(expireRuns(h.config, h.store, now), 0);
});

test('a shared repository copy over its size limit is wiped before the next capture', t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-cache-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, 'source-cache.git');
  mkdirSync(join(cache, 'objects', 'pack'), { recursive: true });
  writeFileSync(join(cache, 'objects', 'pack', 'a.pack'), Buffer.alloc(600)); writeFileSync(join(cache, 'config'), Buffer.alloc(100));
  assert.equal(trimSourceCache(cache, 700), false); assert.equal(existsSync(cache), true);
  assert.equal(trimSourceCache(cache, 699), true); assert.equal(existsSync(cache), false);
  assert.equal(trimSourceCache(cache, 0), false);
});

test('an organization past its monthly plan gets the reason on its PR and no model run', async t => {
  const { Repositories } = await import('../dist/github/repositories.js');
  const { readProfile } = await import('../dist/run.js');
  const h = await harness(t);
  h.config.profile = fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url));
  const repositories = new Repositories(h.config, h.store, [{ id: 'default', label: 'Free', profile: readProfile(h.config.profile) }], 'owner');
  t.after(() => repositories.close());
  repositories.setPlan(21, { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: .05 }, 8);
  const entry = repositories.entries.get(42);
  const worker = new Worker(h.config, h.store, h.github, inline(h.runner), 'owner', entry.settings, (job, limit) => repositories.reserve(entry, job, 'owner', limit));
  h.store.enqueue('within-plan', 1); await worker.tick();
  h.store.enqueue('past-plan', 1); await worker.tick();
  assert.equal(h.counts.runs, 1);
  assert.match(h.comment.body, /review not run\n\nThis organization reached its limit of 1 reviews for/);
  assert.equal(h.checks.at(-1).conclusion, 'failure');
});

test('local execution is scoped by repository and cannot replace trusted CI names', async t => {
  const { readConfig } = await import('../dist/github/config.js');
  const h = state(t), path = join(h.root, 'config.json');
  const config = { ...h.config, port: 8787, profile: fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url)),
    localChecks: [{ repositoryId: 42, name: 'ownership', argv: ['node', '--test', 'test/ownership.mjs'] }] };
  writeFileSync(path, JSON.stringify(config)); assert.equal(readConfig(path).localChecks[0].repositoryId, 42);
  for (const localChecks of [[{ ...config.localChecks[0], repositoryId: 0 }], [{ ...config.localChecks[0], argv: [] }],
    [{ ...config.localChecks[0], argv: ['node', 'bad\u0000arg'] }], [config.localChecks[0], config.localChecks[0]]]) {
    writeFileSync(path, JSON.stringify({ ...config, localChecks })); assert.throws(() => readConfig(path), /Local checks/);
  }
  writeFileSync(path, JSON.stringify({ ...config, trustedChecks: [{ name: 'ownership', appId: 15368 }] }));
  assert.throws(() => readConfig(path), /Local checks/);
});

test('a failed isolated fix check withholds the apply button while retaining the finding', t => {
  const f = repository(t), item = { ...finding(), fix: { startLine: 2, endLine: 2,
    original: '  return "updated";', replacement: '  throw new Error("broken");' } };
  const files = [{ filename: 'update.ts', patch: f.diff.toString() }];
  for (const status of ['fail', 'pass', 'not-run']) {
    const verification = { fixes: [{ findingId: item.id, checks: [{ name: 'ownership', status }] }] };
    const [comment] = inlineComments(f.packet, [item], files, verification);
    assert.match(comment.body, /Account owner guard removed/);
    assert.equal(comment.body.includes('```suggestion'), status !== 'fail');
    if (status === 'fail') assert.match(comment.body, /Proposed fix withheld/);
  }
});

// A push builds on the last completed review; a maintainer's command asks for a full one.
test('a push hands the runner the last completed review and a /atmin review command does not', async t => {
  const h = await harness(t);
  const seen = [];
  const worker = new Worker(h.config, h.store, h.github, inline(async (job, signal, previous) => { seen.push(previous ?? null); return h.runner(job, signal); }), 'owner');
  const first = h.store.enqueue('opened', 1); await worker.tick();
  h.store.enqueue('push', 1); await worker.tick();
  h.store.enqueue('comment', 1, 'command'); await worker.tick();
  assert.deepEqual(seen, [null, h.store.get(first).artifact, null]);
});

// Cost and noise both grow with every push. After five reviewed heads the worker stops
// reviewing automatically, keeps the last summary under a banner naming the head it
// describes, spends nothing, and a command starts the count again.
test('automatic reviews pause after five reviewed heads and a command resumes them', async t => {
  const h = await harness(t); h.config.maxReviewsPerDay = 20;
  for (let i = 0; i < 5; i++) {
    h.setLive({ headSha: String(i + 1).repeat(40) });
    h.store.enqueue(`push-${i}`, 1); await h.worker.tick();
  }
  assert.equal(h.counts.runs, 5);
  // The same head again, as after a target-branch push, is not a new review toward the cap.
  h.store.enqueue('base-moved', 1); await h.worker.tick();
  assert.equal(h.counts.runs, 6);
  h.setLive({ headSha: '6'.repeat(40) });
  const paused = h.store.enqueue('push-6', 1); await h.worker.tick();
  assert.equal(h.counts.runs, 6);
  assert.equal(h.store.get(paused).state, 'skipped');
  assert.equal(h.store.get(paused).error, 'auto-paused');
  assert.match(h.comment.body, /Automatic reviews paused/);
  assert.match(h.comment.body, /atmin review/);
  // A second paused push does not stack banners.
  h.setLive({ headSha: '7'.repeat(40) });
  h.store.enqueue('push-7', 1); await h.worker.tick();
  assert.equal(h.comment.body.match(/Automatic reviews paused/g).length, 1);
  h.store.enqueue('rerun', 1, 'command'); await h.worker.tick();
  assert.equal(h.counts.runs, 7);
  assert.doesNotMatch(h.comment.body, /Automatic reviews paused/);
});

test('a database from before incremental review gains the trigger column; old jobs read as events', t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-github-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = new Store(root);
  legacy.db.exec('DROP TABLE jobs; CREATE TABLE jobs (id TEXT PRIMARY KEY, pr INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER, artifact TEXT, report TEXT, error TEXT, createStarted INTEGER NOT NULL DEFAULT 0)');
  legacy.db.exec("INSERT INTO jobs(id,pr,state,created) VALUES('old',1,'completed',1)");
  legacy.close();
  const store = new Store(root);
  t.after(() => store.close());
  assert.equal(store.get('old').trigger, 'event');
});

// Self-run (Lors, 2026-10-01): a PR whose author has a runner online is reviewed there and
// published by this service, marked as such, and counted toward no plan, credit or author limit,
// because atmin paid for no inference. A runner that does not deliver means a hosted review.
const alice = { id: 'r1', user: 1, login: 'alice', cli: 'claude', model: 'claude-sonnet-5' };
function selfRunFake(h, delivers) {
  const calls = [];
  const dispatcher = inline(async (job, signal, previous, to) => {
    if (to === 'pool') return h.runner(job, signal);
    calls.push(job.id);
    if (!delivers) throw new Error('runner went quiet');
    return h.runner(job, signal);
  }, { own: author => author === 1 ? alice : null });
  return { calls, dispatcher };
}
test('a review delivered by the author\'s runner is published, marked, and never counts against limits', async t => {
  const h = await harness(t);
  h.config.profile = fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url));
  const settings = new ReviewSettings(h.config, h.store);
  settings.save({ model: 'default', maxUsd: 0, maxReviewsPerDay: 6, maxReviewsPerAuthor: 1, selfRun: true });
  const reserved = [];
  const self = selfRunFake(h, true);
  let hosted = 0; const run = h.runner;
  h.runner = async (...args) => { hosted++; return run(...args); };
  const worker = new Worker(h.config, h.store, h.github, self.dispatcher, 'owner', settings, job => { reserved.push(job.id); return true; });
  for (const delivery of ['a', 'b']) {
    const id = h.store.enqueue(delivery, 1); await worker.tick();
    assert.equal(h.store.get(id).state, 'completed');
    assert.equal(h.store.get(id).runner, "@alice's runner (Claude Code / claude-sonnet-5)");
  }
  assert.equal(self.calls.length, 2);
  assert.deepEqual(self.dispatcher.offered.map(offer => offer.to), [alice, alice], 'nothing was offered to the hosted runners');
  assert.deepEqual(reserved, [], 'no plan or credit reservation');
  assert.equal(h.store.authorReviews(1, 0), 0, 'the per-author limit of 1 was not used up');
  assert.match(h.comment.body, /Ran on @alice's runner \(Claude Code \/ claude-sonnet-5\), with the author's own subscription\. atmin charged nothing/);
});
test('a runner that does not deliver leaves an ordinary hosted review', async t => {
  const h = await harness(t);
  h.config.profile = fileURLToPath(new URL('../profiles/smoke-openrouter-free.json', import.meta.url));
  const settings = new ReviewSettings(h.config, h.store);
  settings.save({ model: 'default', maxUsd: 0, maxReviewsPerDay: 6, maxReviewsPerAuthor: null, selfRun: true });
  const reserved = [];
  const self = selfRunFake(h, false);
  const worker = new Worker(h.config, h.store, h.github, self.dispatcher, 'owner', settings, job => { reserved.push(job.id); return h.store.reserve(job, 'owner', 6); });
  const id = h.store.enqueue('a', 1); await worker.tick();
  assert.equal(h.store.get(id).state, 'dispatched', 'offered to the hosted runners');
  await worker.tick();
  assert.equal(self.calls.length, 1);
  assert.deepEqual(self.dispatcher.offered.map(offer => offer.to), [alice, 'pool']);
  assert.deepEqual(reserved, [id], 'the hosted review reserves as any other');
  assert.equal(h.store.get(id).runner, null);
  assert.equal(h.store.get(id).state, 'completed');
  assert.ok(!h.comment.body.includes('Ran on'));
  // The fallback is subject to the same refusals as any hosted review.
  const quiet = selfRunFake(h, false);
  const refusing = new Worker(h.config, h.store, h.github, quiet.dispatcher, 'owner', settings, () => 'Credit used up.');
  const second = h.store.enqueue('b', 1, 'command'); await refusing.tick();
  assert.deepEqual(quiet.dispatcher.offered.map(offer => offer.to), [alice], 'never offered to the hosted runners');
  assert.match(h.comment.body, /review not run[\s\S]*Credit used up\./);
  assert.equal(h.store.get(second).started, null, 'a refused review never counts as started');
});
