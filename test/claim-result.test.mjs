import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, persist, current } from './helpers.mjs';
import { runClaimReviewAsResult } from '../dist/claim-result.js';
import { loadReview } from '../dist/snapshot.js';
import { assess } from '../dist/assessment.js';
import { readVerification } from '../dist/verification.js';
import { runView } from '../dist/github/dashboard-view.js';

// The GitHub worker and the `review` command publish from result.json. These tests hold
// the bridge to what the worker needs: a confirmed claim becomes a finding the existing
// publication path accepts, a refuted one does not, and nothing is spent twice.

const profile = { provider: 'openai', model: 'gpt-5.4-2026-03-05', maxUsd: 2, maxTurns: 6,
  maxToolCalls: 20, maxInputTokens: 50000, maxOutputTokens: 4096, deadlineMs: 600000 };
const action = (name, args) => ({ id: `${name}-${Math.random()}`, name, arguments: JSON.stringify(args) });
const claim = (severity, extra = {}) => ({
  type: 'auth_bypass', location: 'update.ts:2', severity,
  description: 'update() returns without comparing owner to account.',
  suspectedCondition: 'A different account submits a known record id.',
  evidenceToCheck: [{ proposition: 'No ownership comparison remains in the function body.',
    check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } }], ...extra });
const REFUTED = { type: 'contract_break', location: 'update.ts:1', severity: 'P1',
  description: 'update() is called from other modules that assume the old signature.',
  suspectedCondition: 'Another module calls update() and relies on the throw.',
  evidenceToCheck: [{ proposition: 'update is referenced outside update.ts.',
    check: { assertion: 'referenced_outside', symbol: 'update', path: 'update.ts' } }] };
function model(steps) {
  let index = 0;
  return {
    async count() { return 1000; },
    async respond() {
      const step = steps[index++];
      return { model: profile.model, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0,
        status: 'completed', continuation: [], calls: Array.isArray(step) ? step : step ? [step] : [] };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
}
// Tests must never reach the live rung-3 API, whatever the environment holds.
function withoutJev(t) {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved; });
}

test('a confirmed claim is published as a finding and a refuted one is not', async t => {
  withoutJev(t);
  const directory = persist(repository(t));
  await runClaimReviewAsResult(directory, profile, undefined, model([
    [action('record_claim', claim('P1')), action('record_claim', REFUTED)],
    action('end_investigation', { complete: true, limitations: [] })]));

  // loadReview re-validates every anchor against the frozen Git objects, which is what
  // the worker does before it publishes.
  const { packet, result } = loadReview(directory);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.findings.map(f => [f.priority, f.category, f.anchor.path, f.anchor.line]), [['P1', 'security', 'update.ts', 2]]);
  assert.ok(result.coverage.every(c => c.status === 'reviewed'));
  const assessment = assess(packet, result, current());
  assert.equal(assessment.outcome, 'Changes needed');
  assert.match(result.limitations.join(' '), /cross-family rung was off/);

  // The claim record is kept under its own name, so the worker's local fix checks, which
  // write verification.json, can neither overwrite it nor misread it.
  assert.equal(existsSync(join(directory, 'verification.json')), false);
  assert.equal(JSON.parse(readFileSync(join(directory, 'claim-verification.json'), 'utf8')).chains.length, 2);
  assert.deepEqual(readVerification(directory, packet, result.findings).checks, []);

  // The dashboard reads spend from receipt.json; a finished run's spend is metered.
  const view = runView({ repository: 'o/r' }, { id: 'j', pr: 1, state: 'completed', created: 0, started: 1, report: null, artifact: directory });
  assert.equal(view.usage.model, profile.model);
  assert.ok(view.usage.totalUsd > 0);

  // One run per snapshot: a second call must refuse before any model is asked.
  let asked = false;
  await assert.rejects(runClaimReviewAsResult(directory, profile, undefined, { ...model([]), async respond() { asked = true; } }),
    /existing investigation/);
  assert.equal(asked, false);
});

test('a withheld minor finding is listed, not published, and a run that stops claims no coverage', async t => {
  withoutJev(t);
  const minor = persist(repository(t));
  await runClaimReviewAsResult(minor, profile, undefined, model([
    action('record_claim', claim('P3')), action('end_investigation', { complete: true, limitations: [] })]));
  const withheld = loadReview(minor).result;
  assert.equal(withheld.findings.length, 0);
  assert.match(withheld.limitations.join(' '), /1 confirmed minor \(P3\) finding\(s\) withheld: update\.ts:2/);

  // No end_investigation: the turn limit stops the run with its claim recorded.
  const stopped = persist(repository(t));
  await runClaimReviewAsResult(stopped, { ...profile, maxTurns: 2 }, undefined, model([action('record_claim', claim('P1')), action('record_claim', REFUTED)]));
  const { packet, result } = loadReview(stopped);
  assert.equal(result.status, 'partial');
  assert.ok(result.coverage.every(c => c.status === 'unreviewed'));
  assert.equal(result.findings.length, 1);
  assert.equal(assess(packet, result, current()).scope, 'partial');
  // Spend on a stopped run may hold a reservation, so it is not shown as metered.
  assert.equal(JSON.parse(readFileSync(join(stopped, 'receipt.json'), 'utf8')).calls[0].meteredUsd, null);
});
