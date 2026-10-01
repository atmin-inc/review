import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../dist/github/store.js';
import { Runners } from '../dist/github/runners.js';
import { runnerApi } from '../dist/github/runner-api.js';
import { runOffer, profileFor } from '../dist/code-review-runner.js';
import { repository, completed } from './helpers.mjs';

// The runner and the service end to end over HTTP: what the runner reviews is what atmin
// publishes, and a review the runner cannot finish is handed back with its reason so atmin
// reviews the PR itself instead of leaving it unreviewed.
async function service(t) {
  const root = mkdtempSync(join(tmpdir(), 'atmin-runner-e2e-'));
  const store = new Store(root);
  const runners = new Runners(store.db, async () => {});
  const handler = runnerApi(runners, 'Iv-client', async () => new Response(JSON.stringify({ id: 1, login: 'alice' })), async () => {}, 0);
  const server = createServer(async (request, response) => { if (!await handler(request, response)) { response.writeHead(404); response.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { server: `http://127.0.0.1:${server.address().port}`, token: runners.register(1, 'alice') };
  const offer = (n) => {
    const job = `00000000-0000-4000-8000-00000000000${n}`, directory = join(root, 'runs', job);
    mkdirSync(directory, { recursive: true });
    const value = { job, repository: 'o/r', pr: 7, token: 'read-only', previous: null };
    runners.offer(job, 1, 42, directory, value);
    runners.claim(runners.authenticate(config.token));
    return { value, directory };
  };
  return { runners, config, offer };
}

test('a finished review is uploaded and lands in the run directory', async t => {
  const s = await service(t);
  const fixture = repository(t);
  const { value, directory } = s.offer(1);
  let token;
  const outcome = await runOffer(s.config, value, async (offer, dir) => {
    token = offer.token; mkdirSync(dir);
    writeFileSync(join(dir, 'packet.json'), JSON.stringify(fixture.packet));
    writeFileSync(join(dir, 'result.json'), JSON.stringify(completed(fixture.packet)));
    return { ok: true };
  }, new AbortController().signal);
  assert.equal(outcome, 'done');
  assert.equal(token, 'read-only');
  assert.equal(s.runners.outcome(value.job).state, 'done');
  assert.equal(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')).status, 'completed');
});

test('a review that hits the usage limit is handed back with that reason', async t => {
  const s = await service(t);
  const { value } = s.offer(2);
  assert.equal(await runOffer(s.config, value, async () => ({ ok: false, reason: 'usage-limit' }), new AbortController().signal), 'usage-limit');
  assert.deepEqual({ ...s.runners.outcome(value.job) }, { state: 'failed', error: 'usage-limit' });
});

test('a review atmin took back stops at the next heartbeat', async t => {
  const s = await service(t);
  const { value } = s.offer(3);
  s.runners.finish(s.runners.authenticate(s.config.token), value.job, 'failed', 'other');
  const outcome = await runOffer(s.config, value, (_offer, _dir, signal) => new Promise(done => signal.addEventListener('abort', () => done({ ok: false, reason: 'cancelled' }))),
    new AbortController().signal, fetch, 10);
  assert.equal(outcome, 'cancelled');
});

test('the runner profile is a zero-cost Claude Code profile', () => {
  assert.deepEqual({ ...profileFor('claude-sonnet-5') }, { provider: 'claude-local', model: 'claude-sonnet-5', maxUsd: 0, maxTurns: 60, maxToolCalls: 200,
    maxInputTokens: 150000, maxOutputTokens: 8192, deadlineMs: 1800000 });
  assert.throws(() => profileFor('gpt-6-luna'));
});
