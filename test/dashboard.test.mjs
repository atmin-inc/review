import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { Repositories } from '../dist/github/repositories.js';
import { Store } from '../dist/github/store.js';
import { ReviewSettings, readDashboardConfig } from '../dist/github/settings.js';
import { readProfile } from '../dist/run.js';
import { dashboard, history } from '../dist/github/dashboard.js';
const origin = 'https://review.example.test';
const profile = resolve('profiles/smoke-openrouter-free.json');
const models = [{ id: 'free', label: 'Free', profile: readProfile(profile) }, { id: 'deepseek', label: 'DeepSeek', profile: readProfile(resolve('profiles/baseline-deepseek.json')) }];
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const accounts = { 99: 'owner', 77: 'other', 300: 'gone' };
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
    if (url.startsWith('https://api.github.com/app/installations?')) {
      // Only a JWT signed with the App's key lists installations.
      const [header, payload, signature] = init.headers.Authorization.slice(7).split('.');
      assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), appKey.publicKey, Buffer.from(signature, 'base64url')));
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '5076861');
      return Response.json(state.appInstallations ?? []);
    }
    assert.equal(init.headers.Authorization, 'Bearer ghu_faketoken0123456789');
    if (state.revoked) return Response.json({}, { status: 401 });
    if (url.includes('/pulls?')) return Response.json([]);
    if (url.endsWith('/user')) return Response.json({ id: state.userId ?? 7, login: 'owner', email: 'private@example.test' });
    if (url.includes('/user/installations?')) return Response.json({ installations: (state.installations ?? [99]).map(id => ({ id, account: { login: accounts[id], type: id === 77 ? 'User' : 'Organization' } })) });
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
  const handler = dashboard(config, { origin, clientId: 'client-id', clientSecret: 'private-secret', models, operators, appSlug: 'atmin-review' }, store, settings, fetcher, repositories,
    { id: '5076861', key: appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
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
  assert.deepEqual(await (await f.get('/api/review/v1/session')).json(), { version: 'atmin.review.v1', user: null, installUrl: 'https://github.com/apps/atmin-review/installations/new' });
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
  // Anyone may sign in, so one GitHub user holds at most five sessions and cannot fill the table.
  const later = []; for (let i = 0; i < 5; i++) later.push(await f.login());
  assert.equal((await f.get('/api/review/v1/dashboard', cookie)).status, 401);
  for (const kept of later) assert.equal((await f.get('/api/review/v1/dashboard', kept)).status, 200);
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
  assert.equal(session.connections.installations[0].manageUrl, 'https://github.com/organizations/owner/settings/installations/99');
  assert.deepEqual(session.connections.repositories, [{ id: 42, name: 'owner/repo', installationId: 99, connected: true, enabled: false }, { id: 43, name: 'owner/second', installationId: 99, connected: false }]);
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
  assert.equal((await f.finish(await f.begin('?repository=42'))).response.headers.get('location'), '/?repository=42');
  for (const query of ['?repository=42&review=https://evil.test', '?repository=42&review=abc&review=def', '?repository=42%0D%0A&review=abc', '?returnTo=https://evil.test', '?repository=42&repository=43', '?repository=0']) {
    assert.equal((await f.finish(await f.begin(query))).response.headers.get('location'), '/');
  }
  const { cookie } = await f.finish(await f.begin('?repository=999&review=abc'));
  assert.equal((await f.get('/api/review/v1/reviews/abc?repository=999', cookie)).status, 404);
});

test('any installation connects its own repositories, up to ten, without an operator', async t => {
  // Self-serve onboarding: the monthly plan, not an approval, bounds what a new installation spends.
  const f = await setup(t, true, [8]); f.state.installations = [99, 77];
  let cookie = await f.login();
  let session = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.equal(session.operator, false);
  assert.deepEqual(session.connections.installations.map(i => [i.id, i.account, i.manageUrl]), [
    [99, 'owner', 'https://github.com/organizations/owner/settings/installations/99'], [77, 'other', 'https://github.com/settings/installations/77']]);
  assert.deepEqual(session.connections.installations[1].plan, { freeReviews: 20, monthlyReviews: 20 });
  assert.equal(session.connections.installations[1].usage.remaining, 20);
  assert.deepEqual(session.connections.repositories.map(r => [r.id, r.installationId, r.connected]), [[42, 99, true], [55, 77, false]]);
  assert.equal((await f.post('connect?repository=55', {}, cookie)).status, 200);
  const entry = f.repositories.entries.get(55);
  assert.equal(entry.config.installationId, 77); assert.equal(entry.config.repository, 'other/app');
  assert.equal(entry.config.stateDirectory, join(f.root, 'repositories', '77', '55')); assert.equal(entry.store.enabled(), false);
  session = await (await f.get('/api/review/v1/session?repository=55', cookie)).json();
  assert.equal(session.repository.id, 55); assert.equal(session.repository.installationId, 77);
  // A user whose only installation is new signs in; one with none signs in to find the install link.
  f.state.installations = [77]; cookie = await f.login();
  assert.deepEqual((await (await f.get('/api/review/v1/session', cookie)).json()).connections.repositories.map(r => r.id), [55]);
  f.state.installations = []; cookie = await f.login();
  session = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.equal(session.repository, null); assert.deepEqual(session.connections.installations, []); assert.deepEqual(session.connections.repositories, []);
  assert.equal(session.connections.installUrl, 'https://github.com/apps/atmin-review/installations/new');
  // Operators see only their own installations here; every customer is on the admin panel.
  f.state.userId = 8; cookie = await f.login();
  session = await (await f.get('/api/review/v1/session', cookie)).json();
  assert.equal(session.operator, true); assert.deepEqual(session.connections.repositories, []);
  f.state.userId = 7; f.state.installations = [99, 77];
  f.repositories.entries.delete(55); f.repositories.root.db.prepare('DELETE FROM repositories WHERE id=55').run(); entry.store.close();
  for (let id = 1; id <= 10; id++) f.repositories.connect(1000 + id, `other/r${id}`, 77);
  cookie = await f.login();
  const refused = await f.post('connect?repository=55', {}, cookie);
  assert.equal(refused.status, 409); assert.match((await refused.json()).error, /up to 10 repositories/);
  f.repositories.close();
  const reopened = new Repositories(f.config, f.store, models, 'test-owner');
  assert.equal(reopened.entries.get(1001).config.installationId, 77); reopened.close();
});

test('the admin panel is operator-only, lists every installation, and plan changes are validated', async t => {
  const f = await setup(t, true, [8]);
  f.state.appInstallations = [{ id: 99, account: { login: 'owner', type: 'Organization' }, created_at: '2026-09-25T17:40:00Z', suspended_at: null },
    { id: 77, account: { login: 'other', type: 'User' }, created_at: '2026-09-26T01:00:00Z', suspended_at: '2026-09-26T02:00:00Z' }];
  f.repositories.connect(60, 'gone/app', 300);
  let cookie = await f.login();
  // A customer is refused without losing their session.
  assert.deepEqual(await (await f.get('/api/review/v1/admin', cookie)).json(), { error: 'Operator access is required.' });
  assert.equal((await f.post('admin/plan?installation=99', { freeReviews: 0, monthlyReviews: 1000, multiplier: 1, minimumUsd: 0 }, cookie)).status, 403);
  assert.equal(f.repositories.plan(99).updatedAt, null);
  assert.equal((await f.get('/api/review/v1/session', cookie)).status, 200);
  f.state.userId = 8; cookie = await f.login();
  // Usage: the first review is free, then max(cost x multiplier, minimum); unsettled cost is counted, not guessed.
  f.repositories.setPlan(99, { freeReviews: 1, monthlyReviews: 5, multiplier: 2, minimumUsd: .05 }, 8);
  const now = Date.now(); f.store.enable(true);
  [[.10, true], [.01, true], [.10, true], [.03, false]].forEach(([usd, settled], i) => {
    const id = f.store.enqueue(`paid-${i}`, i + 1), directory = join(f.root, `run-${i}`);
    mkdirSync(directory);
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ profile: models[0].profile, finishedAt: 'now', calls: [{ meteredUsd: usd }, ...(settled ? [] : [{ meteredUsd: null }])] }));
    f.store.db.prepare("UPDATE jobs SET state='completed', started=?, artifact=? WHERE id=?").run(now - 1000 + i, directory, id);
  });
  const admin = await (await f.get('/api/review/v1/admin', cookie)).json();
  assert.deepEqual(admin.limits, { maxReviewsPerDay: 12, reviewsToday: 4 });
  assert.deepEqual(admin.installations.map(i => [i.id, i.account, i.accountType, i.suspended, i.removed]),
    [[99, 'owner', 'Organization', false, false], [77, 'other', 'User', true, false], [300, 'gone', null, false, true]]);
  const owner = admin.installations[0];
  assert.deepEqual(owner.usage, { month: owner.usage.month, resetsAt: owner.usage.resetsAt, reviews: 4, remaining: 1, knownUsd: .24, estimatedUsd: .25, unknownCostReviews: 1 });
  assert.deepEqual(owner.repositories, [{ id: 42, name: 'owner/repo', enabled: true, reviews: 4 }]);
  assert.equal(owner.plan.custom, true); assert.equal(owner.plan.updatedBy, 8);
  // Customers see their plan, usage and estimate, but not recorded cost.
  const own = (await (await f.get('/api/review/v1/session', cookie)).json());
  f.state.userId = 7; const customer = await (await f.get('/api/review/v1/session', await f.login())).json(); f.state.userId = 8;
  assert.equal(own.operator, true);
  assert.deepEqual(customer.connections.installations[0].usage, { month: owner.usage.month, resetsAt: owner.usage.resetsAt, reviews: 4, remaining: 1, estimatedUsd: .25, unknownCostReviews: 1 });
  for (const bad of [{}, { freeReviews: 1, monthlyReviews: -1, multiplier: 2, minimumUsd: 0 }, { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: 0, installation: 77 }]) {
    assert.equal((await f.post('admin/plan?installation=77', bad, cookie)).status, 400);
  }
  assert.equal((await f.post('admin/plan?installation=77', 'not json', cookie)).status, 400);
  assert.equal((await f.post('admin/plan?installation=12345', { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: 0 }, cookie)).status, 404);
  assert.equal((await f.post('admin/plan?installation=77', { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: 0 }, cookie, { Origin: 'https://evil.test' })).status, 403);
  const saved = await f.post('admin/plan?installation=77', { freeReviews: 20, monthlyReviews: 500, multiplier: 1.1, minimumUsd: 0 }, cookie);
  assert.equal(saved.status, 200); assert.equal((await saved.json()).usage.remaining, 500);
  assert.deepEqual(f.repositories.plan(77).plan, { freeReviews: 20, monthlyReviews: 500, multiplier: 1.1, minimumUsd: 0 });
  assert.equal(f.repositories.plan(77).updatedBy, 8);
  // A revoked operator token ends the session even though the operator list still names the user.
  f.state.revoked = true;
  assert.equal((await f.get('/api/review/v1/admin', cookie)).status, 403);
  f.state.revoked = false;
  assert.equal((await f.get('/api/review/v1/admin', cookie)).status, 401);
});
