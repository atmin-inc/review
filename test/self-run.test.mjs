import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../dist/github/store.js';
import { Runners, CLAIM_MS, SILENT_MS, POOL, POOL_WAIT_MS, runnerLabel } from '../dist/github/runners.js';
import { runnerApi } from '../dist/github/runner-api.js';
import { router } from '../dist/github/runner.js';
import { ReviewSettings } from '../dist/github/settings.js';
import { repository, completed } from './helpers.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'atmin-self-run-'));
  const store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, runners: new Runners(store.db) };
}
const job = (n = 1) => `00000000-0000-4000-8000-00000000000${n}`;

// A runner is offered only jobs whose PR its own GitHub user authored: a teammate's runner
// must never receive another person's review, or their subscription would pay for it.
test('a runner claims only its own user\'s jobs, and only while signed in', t => {
  const { root, runners } = setup(t);
  const alice = runners.authenticate(runners.register(1, 'alice')), bob = runners.authenticate(runners.register(2, 'bob'));
  runners.seen(alice.id, 'claude', 'claude-sonnet-5', '1.0.0');
  assert.equal(runners.online(1).id, alice.id);
  assert.equal(runners.online(2), null, 'a runner that never polled is not online');
  runners.offer(job(1), 1, 42, root, { job: job(1), repository: 'o/r', pr: 7, token: 't', previous: null }, 60_000);
  assert.equal(runners.claim(bob), null);
  assert.equal(runners.claim(alice).pr, 7);
  assert.equal(runners.claim(alice), null, 'a claimed job is not offered twice');
  assert.equal(runners.claimed(bob, job(1)), null);
  assert.ok(runners.revoke(1, alice.id));
  assert.equal(runners.authenticate('atr_' + 'x'.repeat(43)), null);
  assert.equal(runners.online(1), null, 'a revoked runner gets no work');
});

// An offer's GitHub token can read the repository's code. The service needs it only until a
// runner claims the offer, so a copy of the database never holds a live one for longer.
test('an offer keeps its GitHub token only until a runner claims it or the offer ends', t => {
  const { root, store, runners } = setup(t);
  const alice = runners.authenticate(runners.register(1, 'alice'));
  const tokens = () => store.db.prepare('SELECT job, offer FROM runner_jobs ORDER BY job').all().map(row => [row.job, JSON.parse(row.offer).token ?? null]);
  let now = 1_000_000;
  for (const n of [1, 2, 3]) runners.offer(job(n), 1, 42, root, { job: job(n), repository: 'o/r', pr: n, token: `ghs_${n}`, previous: null }, 60_000, now);
  assert.equal(runners.claim(alice, now).token, 'ghs_1', 'the runner still receives the token');
  runners.close(job(2));
  assert.equal(runners.poll(job(3), now + CLAIM_MS + 1), 'unclaimed');
  assert.deepEqual(tokens(), [[job(1), null], [job(2), null], [job(3), null]]);
  assert.equal(JSON.parse(store.db.prepare('SELECT offer FROM runner_jobs WHERE job=?').get(job(1)).offer).pr, 1, 'the rest of the offer stays for diagnosis');
  // A database from an older release holds tokens of finished jobs; starting removes them.
  runners.offer(job(4), 1, 42, root, { job: job(4), token: 'ghs_4' }, 60_000, now);
  store.db.prepare(`UPDATE runner_jobs SET state='done', offer=json_set(offer,'$.token','ghs_old') WHERE job=?`).run(job(1));
  new Runners(store.db);
  assert.deepEqual(tokens(), [[job(1), null], [job(2), null], [job(3), null], [job(4), 'ghs_4']], 'an offer not yet claimed keeps its token');
});

// Every way a runner can fail to deliver ends the job, so the worker never holds one forever.
test('a dispatched job ends unclaimed, silent, late or done, never never', t => {
  const { root, runners } = setup(t);
  const alice = runners.authenticate(runners.register(1, 'alice'));
  let now = 1_000_000;
  runners.offer(job(1), 1, 42, root, { job: job(1) }, 60_000, now);
  assert.equal(runners.poll(job(1), now + CLAIM_MS), null);
  assert.equal(runners.poll(job(1), now + CLAIM_MS + 1), 'unclaimed');
  runners.offer(job(2), 1, 42, root, { job: job(2) }, 60 * 60_000, now);
  runners.claim(alice, now);
  assert.equal(runners.poll(job(2), now + SILENT_MS + 1), 'silent');
  assert.equal(runners.heartbeat(alice, job(2)), false, 'a job taken back takes no more reports');
  runners.offer(job(3), 1, 42, root, { job: job(3) }, 60 * 60_000, now);
  runners.claim(alice, now);
  assert.ok(runners.finish(alice, job(3), 'done'));
  assert.equal(runners.poll(job(3), now), 'done');
  runners.close(job(3));
  assert.equal(runners.poll(job(3), now), 'cancelled');
  assert.deepEqual(runners.open(42), [job(1), job(2)], 'a closed job is not open');
});

// All of this service's runners may be busy, so a pool job waits longer for one, and its run
// time is counted from when a runner took it, not from when it was offered.
test('a pool job waits for a free runner, and its deadline starts when one takes it', t => {
  const { root, runners } = setup(t);
  const pool = Runners.hosted('s'.repeat(32), 's'.repeat(32), 'hosted-1');
  let now = 1_000_000;
  runners.offer(job(1), POOL, 42, root, { job: job(1) }, 20 * 60_000, now);
  assert.equal(runners.poll(job(1), now + CLAIM_MS + 1), null);
  now += POOL_WAIT_MS - 1;
  assert.equal(runners.claim(pool, now).job, job(1));
  runners.heartbeat(pool, job(1), now + 19 * 60_000);
  assert.equal(runners.poll(job(1), now + 19 * 60_000), null, 'still within 20 minutes of being taken');
  runners.heartbeat(pool, job(1), now + 20 * 60_000 + 1);
  assert.equal(runners.poll(job(1), now + 20 * 60_000 + 1), 'silent');
  runners.offer(job(2), POOL, 42, root, { job: job(2) }, 60_000, 0);
  assert.equal(runners.poll(job(2), POOL_WAIT_MS + 1), 'unclaimed');
});

// The pool's runners run on our model key, so only a holder of the pool secret may be one, and
// a member's runner (their own subscription) is never handed a pool job.
test('only the pool secret makes a pool runner, and pool jobs go only to pool runners', t => {
  const { root, runners } = setup(t);
  const secret = 's'.repeat(32);
  assert.equal(Runners.hosted('wrong'.repeat(8), secret, 'hosted-1'), null);
  assert.equal(Runners.hosted(secret, undefined, 'hosted-1'), null);
  assert.equal(Runners.hosted('short', 'short', 'hosted-1'), null, 'a short secret is refused');
  assert.equal(Runners.hosted(secret, secret, '../x'), null);
  const alice = runners.authenticate(runners.register(1, 'alice'));
  runners.offer(job(1), POOL, 42, root, { job: job(1) }, 60_000);
  assert.equal(runners.claim(alice), null);
  assert.equal(runners.claim(Runners.hosted(secret, secret, 'hosted-1')).job, job(1));
});

async function api(t, runners, user = { id: 1, login: 'alice' }) {
  const handler = runnerApi(runners, 'Iv-client', 'p'.repeat(32), async (_url, init) => init.headers.Authorization === 'Bearer gho_valid_token_for_tests_123'
    ? new Response(JSON.stringify(user)) : new Response('{}', { status: 401 }), async () => {}, 0);
  const server = createServer(async (request, response) => { if (!await handler(request, response)) { response.writeHead(418); response.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/runner/v1`;
  return (path, body, token, pool) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(pool ? { 'x-atmin-runner-pool': pool } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

// The upload is the only thing a runner can change on the service, so it is held to the same
// contracts as a hosted run: anything else fails the job and the service reviews instead.
test('the runner API signs in with GitHub and accepts only valid review records', async t => {
  const { root, runners } = setup(t);
  const call = await api(t, runners);
  assert.equal((await (await call('/config')).json()).clientId, 'Iv-client');
  assert.equal((await call('/login', { githubToken: 'gho_wrong_token_for_tests_123' })).status, 401);
  const { token, login } = await (await call('/login', { githubToken: 'gho_valid_token_for_tests_123' })).json();
  assert.equal(login, 'alice');
  assert.equal((await call('/poll', { cli: 'claude', model: 'claude-sonnet-5', version: '1.0.0' })).status, 401);
  assert.equal((await call('/poll', { cli: 'gemini', model: 'x', version: '1' }, token)).status, 400);
  assert.equal((await (await call('/poll', { cli: 'claude', model: 'claude-sonnet-5', version: '1.0.0' }, token)).json()).offer, null);
  const fixture = repository(t);
  const directory = join(root, 'runs', job(1)); mkdirSync(directory, { recursive: true });
  runners.offer(job(1), 1, 42, directory, { job: job(1), repository: 'o/r', pr: 7, token: 'read-only', previous: null }, 60_000);
  const { offer } = await (await call('/poll', { cli: 'claude', model: 'claude-sonnet-5', version: '1.0.0' }, token)).json();
  assert.equal(offer.job, job(1));
  assert.equal(runners.online(1).model, 'claude-sonnet-5');
  assert.equal((await call(`/jobs/${job(1)}/heartbeat`, {}, token)).status, 200);
  assert.equal((await call(`/jobs/${job(1)}/result`, { packet: { nope: true }, result: {} }, token)).status, 400);
  assert.equal(runners.outcome(job(1)).error, 'upload-invalid');
  assert.ok(!existsSync(join(directory, 'packet.json')));
  assert.equal((await call(`/jobs/${job(1)}/result`, { packet: fixture.packet, result: completed(fixture.packet) }, token)).status, 409, 'a failed job takes no second upload');

  const second = join(root, 'runs', job(2)); mkdirSync(second, { recursive: true });
  runners.offer(job(2), 1, 42, second, { job: job(2), repository: 'o/r', pr: 7, token: 'read-only', previous: null }, 60_000);
  await call('/poll', { cli: 'claude', model: 'claude-sonnet-5', version: '1.0.0' }, token);
  assert.equal((await call(`/jobs/${job(2)}/result`, { packet: fixture.packet, result: completed(fixture.packet) }, token)).status, 200);
  assert.equal(runners.outcome(job(2)).state, 'done');
  assert.equal(JSON.parse(readFileSync(join(second, 'packet.json'), 'utf8')).headSha, fixture.packet.headSha);
  const extra = join(root, 'runs', job(3)); mkdirSync(extra, { recursive: true });
  runners.offer(job(3), 1, 42, extra, { job: job(3), repository: 'o/r', pr: 7, token: 'read-only', previous: null }, 60_000);
  await call('/poll', { cli: 'claude', model: 'claude-sonnet-5', version: '1.0.0' }, token);
  await call(`/jobs/${job(3)}/result`, { packet: fixture.packet, result: completed(fixture.packet), records: { 'receipt.json': '{"spentUsd":99}' } }, token);
  assert.ok(!existsSync(join(extra, 'receipt.json')), 'a member\'s runner cannot write the receipt billing reads');
});

// An idle runner's poll is held open until work arrives or the poll time runs out, so idle runners
// cost nothing. Node marks a request destroyed once its body is read, and the handler took that
// for a runner gone away: every poll returned at once, and on review.atmin.ai (2026-10-08) each
// idle runner polled about 380 times a second, a third of the server's CPU. Real sleep and real
// HTTP here, because a fake sleep cannot tell a held poll from one answered at once.
test('an idle poll is held for the poll time and ends when the runner goes away', async t => {
  const { runners } = setup(t);
  const pool = 'p'.repeat(32);
  let ended = null;
  const handler = runnerApi(runners, undefined, pool, fetch, undefined, 3000);
  const server = createServer(async (request, response) => { await handler(request, response); ended = Date.now(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const poll = signal => fetch(`http://127.0.0.1:${server.address().port}/api/runner/v1/poll`, { method: 'POST', signal,
    headers: { Authorization: `Bearer ${pool}`, 'x-atmin-runner-pool': 'hosted-1' }, body: '{}' });
  let started = Date.now();
  assert.equal((await (await poll()).json()).offer, null);
  assert.ok(Date.now() - started >= 2900, `an idle poll was answered after ${Date.now() - started} ms, not held`);
  ended = null; started = Date.now();
  const gone = new AbortController();
  const request = poll(gone.signal).catch(() => {});
  setTimeout(() => gone.abort(), 200);
  await request;
  while (ended === null) await new Promise(done => setTimeout(done, 50));
  assert.ok(ended - started < 2000, 'a poll whose runner went away stops before its poll time');
});

// This service's runners send every record of a run, including a failed one's receipt, which
// billing reads; names that could leave the run directory are refused.
test('a pool runner uploads every record of its run, and only plain record names', async t => {
  const { root, runners } = setup(t);
  const call = await api(t, runners);
  const pool = 'p'.repeat(32);
  assert.equal((await call('/poll', {}, 'q'.repeat(32), 'hosted-1')).status, 401);
  const fixture = repository(t);
  const offer = (n) => { const directory = join(root, 'runs', job(n)); mkdirSync(directory, { recursive: true });
    runners.offer(job(n), POOL, 42, directory, { job: job(n), repository: 'o/r', pr: 7, token: 'read-only', previous: null }, 60_000); return directory; };
  const first = offer(1);
  assert.equal((await (await call('/poll', {}, pool, 'hosted-1')).json()).offer.job, job(1));
  assert.equal((await call(`/jobs/${job(1)}/result`, { packet: fixture.packet, result: completed(fixture.packet),
    records: { 'receipt.json': '{}', 'trace.perfetto.json': '{}', 'change.diff': 'diff' } }, pool, 'hosted-1')).status, 200);
  assert.ok(['receipt.json', 'trace.perfetto.json', 'change.diff', 'packet.json'].every(name => existsSync(join(first, name))));
  const second = offer(2);
  await call('/poll', {}, pool, 'hosted-1');
  assert.equal((await call(`/jobs/${job(2)}/result`, { packet: fixture.packet, result: completed(fixture.packet),
    records: { '../escape.json': '{}' } }, pool, 'hosted-1')).status, 400);
  assert.ok(!existsSync(join(root, 'runs', 'escape.json')) && !existsSync(join(second, 'packet.json')));
  const third = offer(3);
  await call('/poll', {}, pool, 'hosted-1');
  assert.equal((await call(`/jobs/${job(3)}/fail`, { reason: 'model', records: { 'receipt.json': '{"spent":1}' } }, pool, 'hosted-1')).status, 200);
  assert.equal(runners.outcome(job(3)).state, 'failed');
  assert.equal(readFileSync(join(third, 'receipt.json'), 'utf8'), '{"spent":1}');
});

// Self-run is the repository admin's choice: a member with a runner online still gets a hosted
// review while the setting is off.
test('the runner is offered work only where the repository turned self-run on', async t => {
  const { root, store, runners } = setup(t);
  const config = { repository: 'o/r', repositoryId: 42, installationId: 21, stateDirectory: root, profile: new URL('../profiles/smoke-openrouter-free.json', import.meta.url).pathname, host: '127.0.0.1', port: 0, maxReviewsPerDay: 6 };
  const settings = new ReviewSettings(config, store);
  const alice = runners.authenticate(runners.register(1, 'alice'));
  runners.seen(alice.id, 'claude', 'claude-sonnet-5', '1.0.0');
  const offered = [];
  const route = router(config, { readToken: async () => 'read-only' }, { online: user => runners.online(user), offer: (...args) => offered.push(args) }, settings);
  assert.equal(route.ownRunner(1), null);
  settings.save({ ...settings.current(), selfRun: true });
  assert.equal(route.ownRunner(1).id, alice.id);
  assert.equal(route.ownRunner(2), null);
  assert.equal(runnerLabel(route.ownRunner(1)), "@alice's runner (Claude Code / claude-sonnet-5)");
  // A member's runner gets no model profile or local checks: it reviews with its own CLI.
  await route.offer({ id: job(1), pr: 7 }, alice, root, null);
  await route.offer({ id: job(2), pr: 7 }, 'pool', root, null);
  assert.deepEqual([offered[0][1], offered[0][4].profile], [1, undefined]);
  assert.equal(offered[1][1], POOL);
  assert.equal(offered[1][4].profile.provider, 'openrouter');
  assert.equal(offered[1][4].token, 'read-only');
});

// The pool secret runs reviews on this service's model key and hands out each job's GitHub token,
// so it works only from this machine: through the public proxy it is refused even when correct.
test('the pool secret is refused on a request that came through the public proxy', async t => {
  const { runners } = setup(t);
  const pool = 'p'.repeat(32);
  const handler = runnerApi(runners, undefined, pool, fetch, async () => {}, 0);
  const server = createServer(async (request, response) => { await handler(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const poll = extra => fetch(`http://127.0.0.1:${server.address().port}/api/runner/v1/poll`, { method: 'POST',
    headers: { Authorization: `Bearer ${pool}`, 'x-atmin-runner-pool': 'hosted-1', ...extra }, body: '{}' });
  assert.equal((await poll({ 'X-Forwarded-For': '203.0.113.7' })).status, 401);
  assert.equal((await poll({})).status, 200);
});
