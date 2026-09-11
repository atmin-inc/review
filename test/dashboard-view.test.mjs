import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../dist/github/store.js';
import { livePulls, pullViews, readReview, verifiedRepositories } from '../dist/github/dashboard-view.js';
import { repository, completed, finding, persist } from './helpers.mjs';

function setup(t, priority) {
  const f = repository(t), result = completed(f.packet);
  if (priority) result.findings = [finding(priority)];
  const artifact = persist(f, result), store = new Store(join(f.root, 'state'));
  t.after(() => store.close()); store.enable(true);
  const id = store.enqueue('first', 1);
  store.update(id, { state: 'completed', artifact, report: JSON.stringify({ initial: f.state, check: { output: { title: priority ? 'Suggestions' : 'No issues found' } } }) });
  const config = { repository: f.packet.repository, repositoryId: 42 };
  const live = { ...f.state, title: 'Remove guard', author: 'owner', draft: false, merged: false };
  return { ...f, result, artifact, store, id, config, live };
}

test('dashboard derives verdicts from evidence; stale head, target, closed or unknown PR cannot appear clean', t => {
  const f = setup(t);
  assert.equal(pullViews(f.config, f.store, [f.live])[0].run.verdict, 'No issues found');
  for (const change of [{ headSha: 'a'.repeat(40) }, { baseSha: 'b'.repeat(40) }, { baseRef: 'release' }, { state: 'closed' }]) {
    assert.equal(pullViews(f.config, f.store, [{ ...f.live, ...change }])[0].run.verdict, 'Superseded');
  }
  assert.equal(pullViews(f.config, f.store, [])[0].run.verdict, 'Unverified');
  const skipped = f.store.enqueue('draft-push', 1); f.store.update(skipped, { state: 'skipped' });
  assert.equal(pullViews(f.config, f.store, [{ ...f.live, draft: true }])[0].run.id, f.id);
  assert.equal(pullViews(f.config, f.store, [{ ...f.live, draft: true }])[0].state, 'draft');
  const failed = f.store.enqueue('retry', 1); f.store.update(failed, { state: 'failed', error: 'secret provider body' });
  const view = pullViews(f.config, f.store, [f.live]);
  assert.equal(view.length, 1); assert.equal(view[0].run.id, failed); assert.equal(view[0].run.verdict, null);
  assert.ok(!JSON.stringify(view).includes('secret provider body'));
});

test('detail exposes grounded priorities, evidence and immutable source links; optional policy is respected', t => {
  const f = setup(t, 'P1');
  const detail = readReview(f.config, f.store.get(f.id), f.live);
  assert.equal(detail.report.assessment.outcome, 'Changes needed');
  assert.equal(detail.report.assessment.findings[0].evidence[0].summary, f.result.evidence[0].summary);
  assert.equal(detail.report.assessment.findings[0].url, `https://github.com/${f.config.repository}/blob/${f.packet.headSha}/update.ts#L2`);
  assert.equal(pullViews(f.config, f.store, [f.live])[0].counts.P1, 1);
  f.result.findings = [finding('P4')];
  writeFileSync(join(f.artifact, 'result.json'), JSON.stringify(f.result));
  assert.equal(readReview(f.config, f.store.get(f.id), f.live).report.assessment.hiddenOptionalCount, 1);
  assert.deepEqual(readReview(f.config, f.store.get(f.id), f.live).report.assessment.findings, []);
});

test('missing, corrupt, mismatched and foreign review evidence fails closed without leaking raw errors', t => {
  const f = setup(t);
  const job = f.store.get(f.id);
  for (const change of [{ repository: 'other/private' }, { pr: 999 }, { headSha: 'a'.repeat(40) }]) {
    writeFileSync(join(f.artifact, 'packet.json'), JSON.stringify({ ...f.packet, ...change }));
    const detail = readReview(f.config, { ...job, error: 'ghu_secret' }, f.live);
    assert.equal(detail.report, null); assert.ok(!JSON.stringify(detail).includes('ghu_secret'));
  }
  writeFileSync(join(f.artifact, 'packet.json'), 'private broken JSON');
  assert.equal(pullViews(f.config, f.store, [f.live])[0].run.verdict, 'Review incomplete');
  assert.equal(readReview(f.config, { ...job, artifact: null }, f.live).report, null);
});

test('partial response explains controlled provider failure; mismatched validation cannot manufacture a pass', t => {
  const f = setup(t);
  f.result.status = 'partial';
  writeFileSync(join(f.artifact, 'result.json'), JSON.stringify(f.result));
  writeFileSync(join(f.artifact, 'receipt.json'), JSON.stringify({ providerFailure: { kind: 'rate-limit' }, stopReason: 'secret transport error' }));
  writeFileSync(join(f.artifact, 'validation.json'), JSON.stringify({ headSha: 'a'.repeat(40), baseSha: f.packet.baseSha, checkedAt: new Date().toISOString(), checks: [] }));
  const detail = readReview(f.config, f.store.get(f.id), f.live);
  assert.equal(detail.report.assessment.outcome, 'Review incomplete');
  assert.equal(detail.report.validationAt, null);
  assert.match(detail.reason, /rate limit/); assert.ok(!JSON.stringify(detail).includes('secret transport error'));
});

test('GitHub projection resolves current target, validates repository identity and preserves API failures', async () => {
  const config = { repository: 'owner/repo', repositoryId: 42 }, calls = [];
  const pull = { number: 1, title: 'Real PR title', user: { login: 'owner' }, state: 'open', draft: false, merged_at: null,
    head: { sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'c'.repeat(40), repo: { id: 42, full_name: 'owner/repo' } } };
  const api = async path => { calls.push(path); return path.includes('/pulls?') ? [pull] : { object: { type: 'commit', sha: 'b'.repeat(40) } }; };
  const [live] = await livePulls(config, api);
  assert.equal(live.baseSha, 'b'.repeat(40)); assert.equal(live.title, 'Real PR title'); assert.equal(calls.length, 2);
  pull.base.repo.id = 999;
  await assert.rejects(livePulls(config, api), /Invalid PR/);
  const error = new Error('GitHub down');
  await assert.rejects(livePulls(config, async () => { throw error; }), value => value === error);
});


test('renamed source requires GitHub identity verification; captured evidence is unchanged', async t => {
  const f = setup(t), renamed = { ...f.config, repository: 'renamed/review-fixture' };
  const live = { ...f.live, repository: renamed.repository };
  const job = f.store.get(f.id);
  assert.equal(readReview(renamed, job, live).report, null);
  const paths = [];
  const verified = await verifiedRepositories(renamed, [job], async path => {
    paths.push(path); return { id: f.config.repositoryId, full_name: renamed.repository };
  });
  assert.deepEqual(paths, [`/repos/${f.config.repository}`]);
  const detail = readReview(renamed, job, live, verified);
  assert.equal(detail.report.assessment.outcome, 'No issues found');
  const foreign = await verifiedRepositories(renamed, [job], async () => ({ id: 999, full_name: renamed.repository }));
  assert.equal(readReview(renamed, job, live, foreign).report, null);
  assert.equal(f.packet.repository, 'test/review-fixture');
});
