import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { Store } from '../dist/github/store.js';
import { Repositories, parsePlan, month } from '../dist/github/repositories.js';
import { dispatchRepositories, webhookServer } from '../dist/github/webhook.js';
import { readProfile } from '../dist/run.js';

function setup(t, maxReviewsPerDay = 2) {
  const root = mkdtempSync(join(tmpdir(), 'review-repositories-'));
  const config = { repository: 'owner/first', repositoryId: 42, installationId: 99, profile: resolve('profiles/smoke-openrouter-free.json'), stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay };
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
  assert.match(f.directory.reserve(f.second, f.second.store.next('worker'), 'worker', 2), /rolling 24-hour review limit/);
  assert.equal(f.first.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  f.directory.close();
  const restored = new Repositories(f.config, f.store, f.models, 'worker');
  assert.equal(restored.entries.get(43).settings.current().maxReviewsPerDay, 1);
  assert.equal(restored.entries.get(42).settings.current().maxReviewsPerDay, 2);
  assert.equal(restored.entries.get(43).store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 2);
  restored.entries.get(42).store.enqueue('fourth', 2);
  assert.match(restored.reserve(restored.entries.get(42), restored.entries.get(42).store.next('worker'), 'worker', 2), /rolling 24-hour review limit/);
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

test('each installation is held to its monthly plan; other installations keep reviewing', t => {
  // Any GitHub account can install the App and connect repositories, so a monthly cap per
  // installation is what bounds the model spend a stranger can cause.
  const f = setup(t, 100);
  const run = (entry, delivery) => { entry.store.enable(true); entry.store.enqueue(delivery, 1); return f.directory.reserve(entry, entry.store.next('worker'), 'worker', 100); };
  f.directory.setPlan(99, { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: .05 }, 8);
  assert.equal(run(f.first, 'a'), true);
  // The cap spans every repository of the installation, and the reason reaches the PR comment.
  assert.match(run(f.second, 'b'), /^This organization reached its limit of 1 reviews for \w+ \d{4}\. Reviews resume on \d{4}-\d{2}-01, or sooner/);
  assert.equal(f.second.store.db.prepare('SELECT count(*) AS n FROM jobs WHERE started IS NOT NULL').get().n, 0);
  assert.equal(run(f.third, 'c'), true);
  f.directory.setPlan(99, { freeReviews: 1, monthlyReviews: 0, multiplier: 2, minimumUsd: .05 }, 8);
  assert.match(run(f.second, 'd'), /^Reviews are turned off for this organization/);
  f.directory.setPlan(99, { freeReviews: 1, monthlyReviews: 2, multiplier: 1.1, minimumUsd: 0 }, 8);
  assert.equal(run(f.second, 'e'), true);
  assert.match(run(f.first, 'f'), /limit of 2 reviews/);
  // Reviews from an earlier month do not count against this one.
  for (const entry of [f.first, f.second]) entry.store.db.prepare('UPDATE jobs SET started=? WHERE started IS NOT NULL').run(month(Date.now()).start - 1);
  assert.equal(run(f.first, 'g'), true);
  f.directory.close();
  const restored = new Repositories(f.config, f.store, f.models, 'worker');
  assert.deepEqual(restored.plan(99), { plan: { freeReviews: 1, monthlyReviews: 2, multiplier: 1.1, minimumUsd: 0 }, updatedAt: restored.plan(99).updatedAt, updatedBy: 8 });
  assert.deepEqual(restored.plan(100).plan, { freeReviews: 20, monthlyReviews: 20, multiplier: 2, minimumUsd: .05 });
  restored.close();
});

test('plans reject values outside operator bounds, and each installation connects at most ten repositories', t => {
  const f = setup(t);
  for (const bad of [null, [], {}, { freeReviews: 1, monthlyReviews: 1, multiplier: 2 }, { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: 0, extra: 1 },
    { freeReviews: -1, monthlyReviews: 1, multiplier: 2, minimumUsd: 0 }, { freeReviews: 1.5, monthlyReviews: 1, multiplier: 2, minimumUsd: 0 },
    { freeReviews: 1, monthlyReviews: 100001, multiplier: 2, minimumUsd: 0 }, { freeReviews: 1, monthlyReviews: 1, multiplier: 11, minimumUsd: 0 },
    { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: '0' }, { freeReviews: 1, monthlyReviews: 1, multiplier: Infinity, minimumUsd: 0 }]) {
    assert.throws(() => parsePlan(bad)); assert.throws(() => f.directory.setPlan(99, bad, 8));
  }
  assert.deepEqual(f.directory.plan(99).plan, { freeReviews: 20, monthlyReviews: 20, multiplier: 2, minimumUsd: .05 });
  for (let id = 1; id <= 8; id++) f.directory.connect(1000 + id, `owner/r${id}`, 99);
  assert.equal(f.directory.of(99).length, 10);
  assert.throws(() => f.directory.connect(2000, 'owner/eleventh', 99), /limit/);
  assert.equal(f.directory.connect(2001, 'other/second', 100).config.installationId, 100);
});
