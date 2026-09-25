import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Repositories } from '../dist/github/repositories.js';
import { Store } from '../dist/github/store.js';
import { ReviewSettings, readDashboardConfig } from '../dist/github/settings.js';
import { readProfile } from '../dist/run.js';
import { dashboard, history } from '../dist/github/dashboard.js';
const origin = 'https://review.example.test';
const profile = resolve('profiles/smoke-openrouter-free.json');
const models = [{ id: 'free', label: 'Free', profile: readProfile(profile) }, { id: 'deepseek', label: 'DeepSeek', profile: readProfile(resolve('profiles/baseline-deepseek.json')) }];
async function setup(t, hosted = false, operators = []) {
  const root = mkdtempSync(join(tmpdir(), 'review-dashboard-'));
  const config = { repository: 'owner/repo', repositoryId: 42, installationId: 99, profile, stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay: 12 };
  const store = new Store(root), settings = new ReviewSettings(config, store, models);
  const state = { admin: true, installed: true, revoked: false, exchange: null, exchanges: 0, calls: 0 };
  const fetcher = async (url, init) => {
    state.calls++; (state.urls ??= []).push(url); assert.equal(init.redirect, url.startsWith('https://api.github.com') ? 'manual' : 'error'); assert.ok(init.signal);
    if (url === 'https://github.com/login/oauth/access_token') {
      state.exchanges++; state.exchange = init.body;
      assert.equal(init.method, 'POST'); assert.equal(init.body.get('client_secret'), 'private-secret');
      assert.equal(init.body.get('redirect_uri'), `${origin}/auth/github/callback`); assert.equal(init.body.get('repository_id'), hosted ? null : '42');
      return Response.json({ access_token: 'ghu_faketoken0123456789', token_type: 'bearer', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer ghu_faketoken0123456789');
    if (state.revoked) return Response.json({}, { status: 401 });
    if (url.includes('/pulls?')) return Response.json([]);
    if (url.endsWith('/user')) return Response.json({ id: state.userId ?? 7, login: 'owner', email: 'private@example.test' });
    if (url.includes('/user/installations?')) return Response.json({ installations: (state.installations ?? [99]).map(id => ({ id })) });
    if (url.includes('/user/installations/77/repositories')) return Response.json({ repositories: [{ id: 55, full_name: 'other/app', owner: { type: 'Organization' } }] });
    if (url.endsWith('/repos/other/app')) return Response.json({ id: 55, full_name: 'other/app', permissions: { admin: true } });
    if (url.endsWith('/repos/owner/repo') && state.redirectTo) return new Response(null, { status: 301, headers: { Location: state.redirectTo } });
    if (url.endsWith('/repositories/42')) return Response.json({ id: 42, full_name: 'owner/repo', permissions: { admin: state.admin } });
    if (url.endsWith('/repos/owner/repo')) return Response.json({ id: 42, full_name: 'owner/repo', permissions: { admin: state.admin } });
    if (url.endsWith('/repos/owner/second')) return Response.json({ id: 43, full_name: 'owner/second', permissions: { admin: state.secondAdmin !== false } });
    if (url.includes('/user/installations/99/repositories')) return Response.json({ repositories: state.installed ? [{ id: 42, full_name: 'owner/repo', owner: { type: 'Organization' } }, ...(state.second ? [{ id: 43, full_name: 'owner/second' }] : [])] : [] });
    throw new Error('Unexpected GitHub endpoint');
  };
  store.acquire('test-owner');
  const repositories = hosted ? new Repositories(config, store, models, 'test-owner') : undefined;
  const handler = dashboard(config, { origin, clientId: 'client-id', clientSecret: 'private-secret', models, operators, appSlug: 'atmin-review' }, store, settings, fetcher, repositories);
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); repositories?.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const begin = async (query = '') => {
    const response = await get('/auth/github' + query), url = new URL(response.headers.get('location'));
    assert.equal(url.origin, 'https://github.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const cookie = response.headers.getSetCookie()[0];
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(attribute));
    return { url, cookie: cookie.split(';')[0], path: `/auth/github/callback?code=code123&state=${url.searchParams.get('state')}` };
  };
  const finish = async flow => {
    const response = await get(flow.path, flow.cookie);
    return { response, cookie: response.headers.getSetCookie().find(c => c.startsWith('__Host-atmin-review='))?.split(';')[0] };
  };
  const login = async () => { const { response, cookie } = await finish(await begin()); assert.equal(response.headers.get('location'), '/'); return cookie; };
  const post = (path, body, cookie, extra = {}) => fetch(base + '/api/review/v1/' + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { root, config, store, settings, state, get, post, begin, finish, login, repositories };
}

test('OAuth binds browser/state/PKCE/repository; tokens stay server-side; codes cannot replay', async t => {
  const f = await setup(t);
  assert.deepEqual(await (await f.get('/api/review/v1/session')).json(), { version: 'atmin.review.v1', user: null });
  assert.equal((await f.get('/api/review/v1/dashboard')).status, 401);
  const flow = await f.begin();
  assert.equal((await f.get(flow.path, 'unrelated=cookie')).headers.get('location'), '/?signin=expired'); assert.equal(f.state.exchanges, 0);
  const { response, cookie } = await f.finish(flow); assert.equal(response.headers.get('location'), '/');
  assert.equal(createHash('sha256').update(f.state.exchange.get('code_verifier')).digest('base64url'), flow.url.searchParams.get('code_challenge'));
  const snapshot = await f.get('/api/review/v1/dashboard', cookie), text = await snapshot.text();
  assert.equal(snapshot.status, 200); assert.equal(snapshot.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(text).user, { id: 7, login: 'owner' });
  for (const secret of ['ghu_', 'private-secret', 'private@example.test', f.root]) assert.ok(!text.includes(secret));
  assert.equal((await f.get(flow.path, flow.cookie)).headers.get('location'), '/?signin=expired'); assert.equal(f.state.exchanges, 1);
});

test('repository admin and actual installation access are required and revalidated', async t => {
  const f = await setup(t); f.state.admin = false;
  const flow = await f.begin();
  assert.equal((await f.get(flow.path + '&installation_id=99', flow.cookie)).headers.get('location'), '/?signin=denied');
  f.state.admin = true; f.state.installed = false;
  assert.equal((await f.finish(await f.begin())).response.headers.get('location'), '/?signin=denied');
  f.state.installed = true;
  const session = await f.login(); f.state.admin = false;
  assert.equal((await f.post('enabled', { enabled: true }, session)).status, 403); assert.equal(f.store.enabled(), false);
  assert.equal((await f.get('/api/review/v1/dashboard', session)).status, 401);
  f.state.admin = true;
  const next = await f.login(); f.state.revoked = true;
  assert.equal((await f.get('/api/review/v1/dashboard', next)).status, 403);
  const calls = f.state.calls; assert.equal((await f.get('/api/review/v1/dashboard', next)).status, 401); assert.equal(f.state.calls, calls);
});

test('writes reject CSRF and invalid budgets; choices persist without mutating snapshots; pause cancels work', async t => {
  const f = await setup(t), session = await f.login();
  assert.equal((await f.post('enabled', { enabled: true }, session, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.post('enabled', { enabled: true }, session, { 'Content-Type': 'text/plain' })).status, 403); assert.equal(f.store.enabled(), false);
  for (const value of [null, [], { model: 'free', maxUsd: 1, maxReviewsPerDay: 1 }, { model: 'foreign', maxUsd: 1, maxReviewsPerDay: 1 },
    { model: 'deepseek', maxUsd: 2.01, maxReviewsPerDay: 1 }, { model: 'deepseek', maxUsd: 0, maxReviewsPerDay: 1 },
    { model: 'deepseek', maxUsd: 1, maxReviewsPerDay: 13 }, { model: 'free', maxUsd: 0, maxReviewsPerDay: 1, repository: 'other/repo' }]) {
    assert.equal((await f.post('settings', value, session)).status, 400);
  }
  assert.equal((await f.post('settings', 'x'.repeat(4097), session)).status, 413);
  const captured = f.settings.profile();
  assert.equal((await f.post('settings', { model: 'deepseek', maxUsd: .25, maxReviewsPerDay: 3 }, session)).status, 200);
  assert.equal(f.settings.profile().maxUsd, .25); assert.equal(captured.model, models[0].profile.model); assert.equal(captured.maxUsd, 0);
  assert.equal(new ReviewSettings(f.config, f.store, models).current().maxReviewsPerDay, 3);
  assert.equal((await f.post('enabled', { enabled: true }, session)).status, 200);
  const id = f.store.enqueue('delivery', 1);
  assert.equal((await f.post('enabled', { enabled: false }, session)).status, 200); assert.equal(f.store.get(id).state, 'cancelled');
  assert.equal((await f.post('logout', {}, session)).status, 200); assert.equal((await f.get('/api/review/v1/dashboard', session)).status, 401);
});

test('expiry invalidates flows and sessions without another GitHub call', async t => {
  const f = await setup(t), flow = await f.begin(), now = Date.now();
  t.mock.method(Date, 'now', () => now + 601_000);
  assert.equal((await f.get(flow.path, flow.cookie)).headers.get('location'), '/?signin=expired'); t.mock.restoreAll();
  const session = await f.login(), calls = f.state.calls;
  t.mock.method(Date, 'now', () => Date.parse('2100-01-01'));
  assert.equal((await f.get('/api/review/v1/dashboard', session)).status, 401); assert.equal(f.state.calls, calls);
});

test('history separates job state from verdict, unknown cost from zero, and excludes private state', async t => {
  const f = await setup(t); f.store.enable(true);
  const id = f.store.enqueue('one', 1);
  f.store.update(id, { state: 'completed', artifact: f.root, report: JSON.stringify({ initial: { headSha: 'a'.repeat(40) }, check: { output: { title: 'No issues found' } }, body: 'private source' }), error: 'secret detail' });
  let run = history(f.config, f.store)[0]; assert.equal(run.verdict, 'No issues found'); assert.equal(run.usage, null);
  writeFileSync(join(f.root, 'receipt.json'), JSON.stringify({ profile: models[0].profile, finishedAt: 'now', calls: [{ meteredUsd: 0 }] }));
  assert.equal(history(f.config, f.store)[0].usage.totalUsd, 0);
  writeFileSync(join(f.root, 'receipt.json'), JSON.stringify({ profile: models[1].profile, finishedAt: 'now', calls: [{ meteredUsd: .02 }, { meteredUsd: null }] }));
  run = history(f.config, f.store)[0]; assert.equal(run.usage.totalUsd, null); assert.equal(run.usage.knownUsd, .02);
  f.store.update(id, { state: 'cancelled' }); assert.equal(history(f.config, f.store)[0].verdict, null);
  for (const privateValue of ['private source', 'secret detail', f.root]) assert.ok(!JSON.stringify(run).includes(privateValue));
  for (let i = 0; i < 40; i++) f.store.enqueue(`more-${i}`, 2);
  assert.equal(history(f.config, f.store).length, 30);
});

test('operator config rejects unsafe origins and unavailable credentials', async t => {
  const f = await setup(t), path = join(f.root, 'dashboard.json');
  for (const unsafe of ['http://example.test', 'https://example.test/path', 'https://user:pass@example.test', 'https://example.test/']) {
    writeFileSync(path, JSON.stringify({ origin: unsafe, clientId: 'client-id', models: [{ id: 'free', label: 'Free', profile }] })); assert.throws(() => readDashboardConfig(path, 'secret'));
  }
  const old = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  t.after(() => { if (old === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = old; });
  writeFileSync(path, JSON.stringify({ origin, clientId: 'client-id', models: [{ id: 'free', label: 'Free', profile }] })); assert.throws(() => readDashboardConfig(path, 'secret'));
  process.env.OPENROUTER_API_KEY = 'test-key'; assert.equal(readDashboardConfig(path, 'secret').models.length, 1);
  assert.deepEqual(readDashboardConfig(path, 'secret').operators, []);
  // Operators are GitHub user IDs: a login can be renamed and re-registered by someone else.
  for (const operators of [['lorsk'], [0], [8, 8]]) {
    writeFileSync(path, JSON.stringify({ origin, clientId: 'client-id', models: [{ id: 'free', label: 'Free', profile }], operators })); assert.throws(() => readDashboardConfig(path, 'secret'));
  }
  writeFileSync(path, JSON.stringify({ origin, clientId: 'client-id', models: [{ id: 'free', label: 'Free', profile }], operators: [8], appSlug: 'atmin-review' }));
  assert.deepEqual(readDashboardConfig(path, 'secret').operators, [8]); assert.equal(readDashboardConfig(path, 'secret').appSlug, 'atmin-review');
});


test('review details require current admin access and a stored job ID; arbitrary artifact paths are never accepted', async t => {
  const f = await setup(t);
  assert.equal((await f.get('/api/review/v1/reviews/unknown')).status, 401);
  const session = await f.login();
  assert.equal((await f.get('/api/review/v1/reviews/unknown', session)).status, 404);
  f.store.enable(true);
  const id = f.store.enqueue('detail-read', 1);
  f.store.update(id, { state: 'failed', error: 'provider-secret' });
  const response = await f.get(`/api/review/v1/reviews/${id}`, session);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.run.id, id); assert.equal(detail.report, null);
  assert.ok(!JSON.stringify(detail).includes('provider-secret'));
  assert.equal((await f.get('/api/review/v1/reviews/%2Fetc%2Fpasswd', session)).status, 404);
  f.state.admin = false;
  assert.equal((await f.get(`/api/review/v1/reviews/${id}`, session)).status, 403);
});


test('GitHub rename redirects follow only the configured numeric repository on the trusted API origin', async t => {
  const f = await setup(t);
  f.state.redirectTo = 'https://api.github.com/repositories/42';
  const session = await f.login();
  assert.equal((await f.get('/api/review/v1/dashboard', session)).status, 200);
  assert.ok(f.state.urls.includes('https://api.github.com/repositories/42'));
  for (const target of ['https://attacker.invalid/repositories/42', 'https://api.github.com/repositories/999']) {
    f.state.redirectTo = target;
    assert.equal((await f.finish(await f.begin())).response.headers.get('location'), '/?signin=unavailable');
    assert.ok(!f.state.urls.includes(target));
  }
});


test('hosted connection uses GitHub identity, explicit repository scope, and independent settings/history', async t => {
  const f = await setup(t, true); f.state.second = true;
  const cookie = await f.login();
  const session = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.equal(session.connections.manageUrl, 'https://github.com/organizations/owner/settings/installations/99');
  assert.deepEqual(session.connections.repositories, [{ id: 42, name: 'owner/repo', installationId: 99, connected: true }, { id: 43, name: 'owner/second', installationId: 99, connected: false }]);
  assert.equal(session.connections.installUrl, 'https://github.com/apps/atmin-review/installations/new');
  assert.equal((await f.post('enabled', { enabled: true }, cookie)).status, 400);
  assert.equal((await f.post('connect?repository=43', { repository: 'attacker/repo', installation: 999 }, cookie)).status, 200);
  const second = f.repositories.entries.get(43);
  assert.equal(second.config.repository, 'owner/second'); assert.equal(second.config.installationId, 99);
  assert.equal(second.store.enabled(), false); assert.deepEqual(second.config.trustedChecks, []);
  assert.equal((await f.post('enabled?repository=43', { enabled: true }, cookie)).status, 200);
  assert.equal(f.store.enabled(), false);
  assert.equal((await f.post('settings?repository=43', { model: 'deepseek', maxUsd: .25, maxReviewsPerDay: 2 }, cookie)).status, 200);
  assert.equal(second.settings.current().maxUsd, .25); assert.equal(f.settings.current().maxUsd, 0);
  const id = second.store.enqueue('same-delivery', 1);
  second.store.update(id, { state: 'failed', error: 'private failure' });
  assert.equal((await f.get(`/api/review/v1/reviews/${id}?repository=42`, cookie)).status, 404);
  const result = await (await f.get(`/api/review/v1/reviews/${id}?repository=43`, cookie)).json();
  assert.equal(result.run.id, id); assert.ok(!JSON.stringify(result).includes('private failure'));
  assert.equal((await f.get(`/api/review/v1/reviews/${id}`, cookie)).status, 400);
  assert.equal((await f.get('/api/review/v1/session?repository=43&repository=42', cookie)).status, 400);
  f.state.second = false;
  assert.equal((await f.post('enabled?repository=43', { enabled: false }, cookie)).status, 404);
  assert.equal((await f.get(`/api/review/v1/reviews/${id}?repository=43`, cookie)).status, 404);
});

test('an installation member can onboard without admin access to the bootstrap repository; foreign IDs and non-admin connections are denied', async t => {
  const f = await setup(t, true); f.state.admin = false; f.state.second = true;
  let cookie = await f.login();
  const initial = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.equal(initial.user.login, 'owner'); assert.equal(initial.repository, null);
  f.state.secondAdmin = false;
  assert.equal((await f.post('connect?repository=43', {}, cookie)).status, 403);
  assert.equal(f.repositories.entries.size, 1);
  f.state.secondAdmin = true; cookie = await f.login();
  assert.equal((await f.post('connect?repository=43', {}, cookie)).status, 200);
  const session = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.equal(session.repository.id, 43);
  assert.equal((await f.post('connect?repository=999', { installationId: 99 }, cookie)).status, 403);
  assert.equal(f.repositories.entries.size, 2);
});


test('sign-in returns to the exact review without allowing redirects or changing authorization', async t => {
  const f = await setup(t);
  const { response } = await f.finish(await f.begin('?repository=42&review=abc-123'));
  assert.equal(response.headers.get('location'), '/?repository=42#review/abc-123');
  for (const query of ['?repository=42&review=https://evil.test', '?repository=42&review=abc&review=def', '?repository=42%0D%0A&review=abc', '?returnTo=https://evil.test']) {
    assert.equal((await f.finish(await f.begin(query))).response.headers.get('location'), '/');
  }
  const { cookie } = await f.finish(await f.begin('?repository=999&review=abc'));
  assert.equal((await f.get('/api/review/v1/reviews/abc?repository=999', cookie)).status, 404);
});

test('a new installation stays invisible until an operator connects one of its repositories', async t => {
  // The App installs on any account, and each connected repository spends model budget, so an
  // installation is approved only when an operator (by GitHub user ID) connects its first repository.
  const f = await setup(t, true, [8]); f.state.installations = [99, 77];
  let cookie = await f.login();
  let session = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.deepEqual(session.connections.repositories.map(r => r.id), [42]);
  assert.equal((await f.post('connect?repository=55', {}, cookie)).status, 403);
  assert.equal(f.repositories.entries.has(55), false);
  f.state.installations = [77];
  assert.equal((await f.finish(await f.begin())).response.headers.get('location'), '/?signin=denied');
  f.state.userId = 8; cookie = await f.login();
  session = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.deepEqual(session.connections.repositories.map(r => [r.id, r.installationId, r.connected]), [[55, 77, false]]);
  assert.equal((await f.post('connect?repository=55', {}, cookie)).status, 200);
  const entry = f.repositories.entries.get(55);
  assert.equal(entry.config.installationId, 77); assert.equal(entry.config.repository, 'other/app');
  assert.equal(entry.config.stateDirectory, join(f.root, 'repositories', '77', '55')); assert.equal(entry.store.enabled(), false);
  f.state.userId = 7; cookie = await f.login();
  session = await (await f.get('/api/review/v1/session?repository=55', cookie)).json();
  assert.equal(session.repository.id, 55); assert.equal(session.repository.installationId, 77);
  f.repositories.close();
  const reopened = new Repositories(f.config, f.store, models, 'test-owner');
  assert.equal(reopened.entries.get(55).config.installationId, 77); reopened.close();
});
