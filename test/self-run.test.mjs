import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../dist/github/store.js';
import { Runners, CLAIM_MS, SILENT_MS, runnerLabel } from '../dist/github/runners.js';
import { runnerApi } from '../dist/github/runner-api.js';
import { selfRun } from '../dist/github/runner.js';
import { ReviewSettings } from '../dist/github/settings.js';
import { repository, completed } from './helpers.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'atmin-self-run-'));
  const store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, runners: new Runners(store.db, async () => {}) };
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
  runners.offer(job(1), 1, 42, root, { job: job(1), repository: 'o/r', pr: 7, token: 't', previous: null });
  assert.equal(runners.claim(bob), null);
  assert.equal(runners.claim(alice).pr, 7);
  assert.equal(runners.claim(alice), null, 'a claimed job is not offered twice');
  assert.equal(runners.claimed(bob, job(1)), null);
  assert.ok(runners.revoke(1, alice.id));
  assert.equal(runners.authenticate('atr_' + 'x'.repeat(43)), null);
  assert.equal(runners.online(1), null, 'a revoked runner gets no work');
});

// Every way a runner can fail to deliver ends the wait, so the worker reviews on the service.
test('waiting ends unclaimed, silent or done, never forever', async t => {
  const { root, runners } = setup(t);
  const alice = runners.authenticate(runners.register(1, 'alice'));
  const never = new AbortController().signal;
  let now = 1_000_000;
  runners.offer(job(1), 1, 42, root, { job: job(1) }, now);
  const unclaimed = runners.wait(job(1), never, Infinity, () => (now += CLAIM_MS + 1));
  assert.equal(await unclaimed, 'unclaimed');
  runners.offer(job(2), 1, 42, root, { job: job(2) }, now);
  runners.claim(alice, now);
  assert.equal(await runners.wait(job(2), never, Infinity, () => (now += SILENT_MS + 1)), 'silent');
  assert.equal(runners.heartbeat(alice, job(2)), false, 'a job taken back takes no more reports');
  runners.offer(job(3), 1, 42, root, { job: job(3) }, now);
  runners.claim(alice, now);
  assert.ok(runners.finish(alice, job(3), 'done'));
  assert.equal(await runners.wait(job(3), never, Infinity, () => now), 'done');
});

async function api(t, runners, user = { id: 1, login: 'alice' }) {
  const handler = runnerApi(runners, 'Iv-client', async (_url, init) => init.headers.Authorization === 'Bearer gho_valid_token_for_tests_123'
    ? new Response(JSON.stringify(user)) : new Response('{}', { status: 401 }), async () => {}, 0);
  const server = createServer(async (request, response) => { if (!await handler(request, response)) { response.writeHead(418); response.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/runner/v1`;
  return (path, body, token) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  runners.offer(job(1), 1, 42, directory, { job: job(1), repository: 'o/r', pr: 7, token: 'read-only', previous: null });
  const { offer } = await (await call('/poll', { cli: 'claude', model: 'claude-sonnet-5', version: '1.0.0' }, token)).json();
  assert.equal(offer.job, job(1));
  assert.equal(runners.online(1).model, 'claude-sonnet-5');
  assert.equal((await call(`/jobs/${job(1)}/heartbeat`, {}, token)).status, 200);
  assert.equal((await call(`/jobs/${job(1)}/result`, { packet: { nope: true }, result: {} }, token)).status, 400);
  assert.equal(runners.outcome(job(1)).error, 'upload-invalid');
  assert.ok(!existsSync(join(directory, 'packet.json')));
  assert.equal((await call(`/jobs/${job(1)}/result`, { packet: fixture.packet, result: completed(fixture.packet) }, token)).status, 409, 'a failed job takes no second upload');

  const second = join(root, 'runs', job(2)); mkdirSync(second, { recursive: true });
  runners.offer(job(2), 1, 42, second, { job: job(2), repository: 'o/r', pr: 7, token: 'read-only', previous: null });
  await call('/poll', { cli: 'claude', model: 'claude-sonnet-5', version: '1.0.0' }, token);
  assert.equal((await call(`/jobs/${job(2)}/result`, { packet: fixture.packet, result: completed(fixture.packet) }, token)).status, 200);
  assert.equal(runners.outcome(job(2)).state, 'done');
  assert.equal(JSON.parse(readFileSync(join(second, 'packet.json'), 'utf8')).headSha, fixture.packet.headSha);
});

// Self-run is the repository admin's choice: a member with a runner online still gets a hosted
// review while the setting is off.
test('the runner is offered work only where the repository turned self-run on', async t => {
  const { root, store, runners } = setup(t);
  const config = { repository: 'o/r', repositoryId: 42, installationId: 21, stateDirectory: root, profile: new URL('../profiles/smoke-openrouter-free.json', import.meta.url).pathname, host: '127.0.0.1', port: 0, maxReviewsPerDay: 6 };
  const settings = new ReviewSettings(config, store);
  const alice = runners.authenticate(runners.register(1, 'alice'));
  runners.seen(alice.id, 'claude', 'claude-sonnet-5', '1.0.0');
  const self = selfRun(config, { readToken: async () => 'read-only' }, settings, runners);
  assert.equal(self.runner({}, 1), null);
  settings.save({ ...settings.current(), selfRun: true });
  assert.equal(self.runner({}, 1).id, alice.id);
  assert.equal(self.runner({}, 2), null);
  assert.equal(runnerLabel(self.runner({}, 1)), "@alice's runner (Claude Code / claude-sonnet-5)");
});
