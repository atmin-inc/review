import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { Store } from '../dist/github/store.js';
import { Repositories } from '../dist/github/repositories.js';
import { dispatchRepositories, webhookServer } from '../dist/github/webhook.js';
import { readProfile } from '../dist/run.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-repositories-'));
  const config = { repository: 'owner/first', repositoryId: 42, installationId: 99, profile: resolve('profiles/smoke-openrouter-free.json'), stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay: 2 };
  const models = [{ id: 'free', label: 'Free', profile: readProfile(config.profile) }];
  const store = new Store(root); assert.ok(store.acquire('worker'));
  const directory = new Repositories(config, store, models, 'worker');
  t.after(() => { directory.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { directory, config, store, models, first: directory.entries.get(42), second: directory.connect(43, 'owner/second', 99), third: directory.connect(44, 'other/third', 100) };
}

test('repositories retain separate jobs/settings after restart and share a durable rolling review cap', t => {
  const f = setup(t);
  for (const entry of [f.first, f.second]) {
    entry.store.enable(true);
    entry.store.enqueue('same-delivery', 1);
    const job = entry.store.next('worker');
    assert.ok(f.directory.reserve(entry, job, 'worker', 2));
    entry.store.update(job.id, { state: 'failed' });
  }
  f.second.settings.save({ model: 'free', maxUsd: 0, maxReviewsPerDay: 1 });
  f.second.store.enqueue('third', 2);
  assert.equal(f.directory.reserve(f.second, f.second.store.next('worker'), 'worker', 2), false);
  assert.equal(f.first.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  f.directory.close();
  const restored = new Repositories(f.config, f.store, f.models, 'worker');
  assert.equal(restored.entries.get(43).settings.current().maxReviewsPerDay, 1);
  assert.equal(restored.entries.get(42).settings.current().maxReviewsPerDay, 2);
  assert.equal(restored.entries.get(43).store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 2);
  restored.entries.get(42).store.enqueue('fourth', 2);
  assert.equal(restored.reserve(restored.entries.get(42), restored.entries.get(42).store.next('worker'), 'worker', 2), false);
  const old = Date.now() - 86_400_001;
  for (const entry of restored.entries.values()) entry.store.db.prepare('UPDATE jobs SET started=? WHERE started IS NOT NULL').run(old);
  const job = restored.entries.get(42).store.db.prepare("SELECT * FROM jobs WHERE state='running'").get();
  assert.ok(restored.reserve(restored.entries.get(42), job, 'worker', 2));
  restored.close();
});

test('signed webhooks dispatch by installation and repository, and removal only pauses affected repositories', async t => {
  const f = setup(t), secret = 'test-webhook-secret';
  const github = () => ({ canReview: async () => true });
  const server = webhookServer(secret, (event, delivery, payload) => dispatchRepositories(f.directory.entries, github, event, delivery, payload));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const send = (event, body, signature = true) => {
    const payload = JSON.stringify(body);
    return fetch(`http://127.0.0.1:${server.address().port}/webhooks/github`, { method: 'POST', headers: {
      'x-github-event': event, 'x-github-delivery': 'delivery', 'x-hub-signature-256': signature ? `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}` : 'invalid',
    }, body: payload });
  };
  const pr = { installation: { id: 99 }, repository: { id: 43, full_name: 'owner/second' }, action: 'opened', number: 1 };
  f.first.store.enable(true); f.second.store.enable(true); f.third.store.enable(true);
  assert.equal((await send('pull_request', pr, false)).status, 401);
  await send('pull_request', { ...pr, installation: { id: 100 } });
  // A repository is reached only through the installation it was connected from.
  const third = { ...pr, installation: { id: 100 }, repository: { id: 44, full_name: 'other/third' } };
  await send('pull_request', { ...third, installation: { id: 99 } });
  assert.equal(f.third.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  await send('pull_request', third);
  assert.equal(f.third.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  await send('pull_request', { ...pr, repository: { id: 43, full_name: 'owner/first' } });
  assert.equal(f.second.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  await send('pull_request', pr); await send('pull_request', pr);
  assert.equal(f.second.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  assert.equal(f.first.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  await send('installation_repositories', { installation: { id: 99 }, repositories_removed: [{ id: 43 }] });
  assert.equal(f.first.store.enabled(), true); assert.equal(f.second.store.enabled(), false);
  assert.equal(f.second.store.db.prepare('SELECT state FROM jobs').get().state, 'cancelled');
  await send('installation', { installation: { id: 100 }, action: 'suspend' });
  assert.equal(f.first.store.enabled(), true); assert.equal(f.third.store.enabled(), false);
  await send('installation', { installation: { id: 99 }, action: 'suspend' });
  assert.equal(f.first.store.enabled(), false);
});
