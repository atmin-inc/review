import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { Store } from '../dist/github/store.js';
import { Repositories, parsePlan, month } from '../dist/github/repositories.js';
import { dispatchRepositories, webhookServer } from '../dist/github/webhook.js';
import { readProfile } from '../dist/run.js';

function setup(t, maxReviewsPerDay = 2, origin) {
  const root = mkdtempSync(join(tmpdir(), 'review-repositories-'));
  const config = { repository: 'owner/first', repositoryId: 42, installationId: 99, profile: resolve('profiles/smoke-openrouter-free.json'), stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay };
  const models = [{ id: 'free', label: 'Free', profile: readProfile(config.profile) }];
  const store = new Store(root); assert.ok(store.acquire('worker'));
  const directory = new Repositories(config, store, models, 'worker', origin);
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
  f.second.settings.save({ model: 'free', maxUsd: 0, maxReviewsPerDay: 1, maxReviewsPerAuthor: null });
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
  // Past the free review, credit pays; the monthly limit still applies.
  f.directory.grant(99, 1, 'test credit', 8);
  assert.equal(run(f.second, 'e'), true);
  assert.match(run(f.first, 'f'), /limit of 2 reviews/);
  // Reviews from an earlier month do not count against this one.
  for (const entry of [f.first, f.second]) entry.store.db.prepare('UPDATE jobs SET started=? WHERE started IS NOT NULL').run(month(Date.now()).start - 1);
  assert.equal(run(f.first, 'g'), true);
  f.directory.close();
  const restored = new Repositories(f.config, f.store, f.models, 'worker');
  assert.deepEqual(restored.plan(99), { plan: { freeReviews: 1, monthlyReviews: 2, multiplier: 1.1, minimumUsd: 0 }, updatedAt: restored.plan(99).updatedAt, updatedBy: 8 });
  assert.deepEqual(restored.plan(100).plan, { freeReviews: 20, monthlyReviews: 1000, multiplier: 2, minimumUsd: .05 });
  restored.close();
});

test('past its free reviews an organization reviews only while it has credit, on the default plan or an operator\'s', t => {
  // Anyone can install the App, so without credit a stranger's reviews cost at most the free
  // allowance; the refusal tells a repository admin where to buy credit.
  const f = setup(t, 100, 'https://review.example.test');
  let n = 0;
  const run = entry => { entry.store.enable(true); entry.store.enqueue(`d${++n}`, n); return f.directory.reserve(entry, entry.store.next('worker'), 'worker', 100); };
  for (let i = 0; i < 20; i++) assert.equal(run(f.third), true);
  assert.match(run(f.third), /^This organization used its 20 free reviews for \w+ \d{4} and has no review credit left\. A repository admin can buy credit on the atmin dashboard \(https:\/\/review\.example\.test\/billing\?installation=100\) to keep reviewing; otherwise free reviews start again on \d{4}-\d{2}-01\. No inference was started\.$/);
  assert.equal(f.third.store.db.prepare('SELECT count(*) AS n FROM jobs WHERE started IS NOT NULL').get().n, 20);
  // A saved card is not credit; with auto top-up off nothing charges it.
  f.directory.setCustomer(100, 'cus_test1', 7); f.directory.setCard(100, 'pm_test1', 'Visa ending 4242', '12/2030', 'billing@owner.test', 7);
  assert.match(run(f.third), /has no review credit left/);
  // Any credit above zero lets the next review start; what it costs is taken once its cost settles.
  f.directory.grant(100, 0.01, 'test credit', 8);
  assert.equal(run(f.third), true);
  // An operator's plan needs credit past its free reviews too. With none free, the refusal
  // does not count free reviews or promise them next month.
  f.directory.setPlan(99, { freeReviews: 0, monthlyReviews: 50, multiplier: 1.1, minimumUsd: 0 }, 8);
  assert.match(run(f.first), /^This organization has no review credit left\. A repository admin can buy credit on the atmin dashboard \(https:\/\/review\.example\.test\/billing\?installation=99\) to keep reviewing\. No inference was started\.$/);
});

test('without Stripe, the refusal asks atmin for credit and links nowhere', t => {
  const f = setup(t, 100);
  let n = 0;
  const run = entry => { entry.store.enable(true); entry.store.enqueue(`d${++n}`, n); return f.directory.reserve(entry, entry.store.next('worker'), 'worker', 100); };
  for (let i = 0; i < 20; i++) assert.equal(run(f.third), true);
  const refused = run(f.third);
  assert.match(refused, /^This organization used its 20 free reviews for \w+ \d{4} and has no review credit left\. atmin can add credit to keep reviewing; otherwise free reviews start again on /);
  assert.doesNotMatch(refused, /dashboard|card|https?:/);
});

// Strangers' repositories share one disk (2026-09-30): one organization's records must not
// fill it for everyone. Shared copies are refetched by the next review, so they go first.
test('an organization over its storage limit loses its shared copies first, and is refused only while its run records alone are over it', t => {
  const f = setup(t, 100);
  f.config.maxInstallationDiskMb = 1;
  const run = (entry, delivery) => { entry.store.enable(true); entry.store.enqueue(delivery, 1); return f.directory.reserve(entry, entry.store.next('worker'), 'worker', 100); };
  const fill = (path, bytes) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes)); };
  const copy = entry => join(entry.config.stateDirectory, 'source-cache.git');
  fill(join(copy(f.second), 'objects', 'pack', 'big.pack'), 2 * 1024 ** 2);
  fill(join(f.first.config.stateDirectory, 'runs', 'a', 'calls.json'), 512 * 1024);
  fill(join(copy(f.third), 'objects', 'pack', 'other.pack'), 512 * 1024);
  assert.deepEqual(f.directory.stored(99), { runs: 512 * 1024, copies: 2 * 1024 ** 2 });
  assert.equal(run(f.second, 'over-with-copies'), true);
  assert.equal(existsSync(copy(f.second)), false);
  assert.ok(existsSync(join(f.first.config.stateDirectory, 'runs', 'a', 'calls.json')));
  fill(join(f.second.config.stateDirectory, 'runs', 'b', 'calls.json'), 1024 ** 2);
  assert.match(run(f.second, 'over-with-runs'), /over its 1 MB storage limit, so this review did not start/);
  assert.equal(f.second.store.db.prepare('SELECT started FROM jobs ORDER BY created DESC, rowid DESC LIMIT 1').get().started, null);
  // Another organization under its limit keeps reviewing, and keeps its shared copy.
  assert.equal(run(f.third, 'other-organization'), true);
  assert.ok(existsSync(join(copy(f.third), 'objects', 'pack', 'other.pack')));
  delete f.config.maxInstallationDiskMb;
  assert.equal(f.directory.storageLimitMb(), 5120);
});

test('plans reject values outside operator bounds, and each installation connects at most ten repositories', t => {
  const f = setup(t);
  for (const bad of [null, [], {}, { freeReviews: 1, monthlyReviews: 1, multiplier: 2 }, { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: 0, extra: 1 },
    { freeReviews: -1, monthlyReviews: 1, multiplier: 2, minimumUsd: 0 }, { freeReviews: 1.5, monthlyReviews: 1, multiplier: 2, minimumUsd: 0 },
    { freeReviews: 1, monthlyReviews: 100001, multiplier: 2, minimumUsd: 0 }, { freeReviews: 1, monthlyReviews: 1, multiplier: 11, minimumUsd: 0 },
    { freeReviews: 1, monthlyReviews: 1, multiplier: 2, minimumUsd: '0' }, { freeReviews: 1, monthlyReviews: 1, multiplier: Infinity, minimumUsd: 0 }]) {
    assert.throws(() => parsePlan(bad)); assert.throws(() => f.directory.setPlan(99, bad, 8));
  }
  assert.deepEqual(f.directory.plan(99).plan, { freeReviews: 20, monthlyReviews: 1000, multiplier: 2, minimumUsd: .05 });
  for (let id = 1; id <= 8; id++) f.directory.connect(1000 + id, `owner/r${id}`, 99);
  assert.equal(f.directory.of(99).length, 10);
  assert.throws(() => f.directory.connect(2000, 'owner/eleventh', 99), /limit/);
  assert.equal(f.directory.connect(2001, 'other/second', 100).config.installationId, 100);
});

test('the billing table of the first billing release gains the new columns and keeps its rows; old invoices are left as they are', t => {
  // The server already has these tables, made before email, card expiry and auto top-up, and
  // monthly invoices from the release before credit.
  const root = mkdtempSync(join(tmpdir(), 'review-repositories-'));
  const config = { repository: 'owner/first', repositoryId: 42, installationId: 99, profile: resolve('profiles/smoke-openrouter-free.json'), stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay: 2 };
  const store = new Store(root); assert.ok(store.acquire('worker'));
  store.db.exec(`CREATE TABLE billing (installation INTEGER PRIMARY KEY, customer TEXT NOT NULL, paymentMethod TEXT, card TEXT, updated INTEGER NOT NULL, updatedBy INTEGER NOT NULL);
    CREATE TABLE invoices (installation INTEGER NOT NULL, month TEXT NOT NULL, invoice TEXT, amountCents INTEGER NOT NULL, reviews INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(installation, month));
    INSERT INTO billing VALUES(99, 'cus_old', 'pm_old', 'Visa ending 4242', 1, 7);
    INSERT INTO invoices VALUES(99, '2026-09', 'in_old', 120, 30, 'finalized', 1);`);
  const models = [{ id: 'free', label: 'Free', profile: readProfile(config.profile) }];
  const directory = new Repositories(config, store, models, 'worker');
  t.after(() => { directory.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(directory.billing(99), { customer: 'cus_old', paymentMethod: 'pm_old', card: 'Visa ending 4242', expires: null, email: null, topUpCents: null, topUpFailed: null, updated: 1, updatedBy: 7 });
  assert.deepEqual(store.db.prepare('SELECT invoice, state FROM invoices').all().map(row => ({ ...row })), [{ invoice: 'in_old', state: 'finalized' }]);
  assert.equal(directory.balance(99), 0);
  // Opening it again adds nothing twice.
  directory.close();
  assert.equal(new Repositories(config, store, models, 'worker').billing(99).topUpCents, null);
});
