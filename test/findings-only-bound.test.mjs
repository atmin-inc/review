import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundArm, boundComparison } from '../benchmarks/findings-only-bound.mjs';

// The bound exists to answer "how far can re-instrumenting the denominator alone
// take us". If it is computed by pooling, it answers a more flattering question
// than the one asked, so the per-trial ceiling is the property under test.
test('a trial cannot contribute more matches than it emitted findings', () => {
  const pooled = [{ id: 'a', findings: 0, coreMatches: 1, coreExpected: 1 },
    { id: 'b', findings: 4, coreMatches: 0, coreExpected: 3 }];
  const bound = boundArm(pooled);
  assert.equal(bound.coreMatches, 1);
  assert.equal(bound.precisionUpperBound, 0, 'trial a matched through prose; trial b matched nothing');
  assert.equal(bound.fromProse, 1);
  assert.deepEqual(bound.proseTrials, ['a']);
});

test('pooling would overstate the ceiling, which is why it is not used', () => {
  const trials = [{ id: 'a', findings: 0, coreMatches: 2, coreExpected: 2 },
    { id: 'b', findings: 5, coreMatches: 1, coreExpected: 4 }];
  const pooledRatio = 3 / 5;
  assert.ok(boundArm(trials).precisionUpperBound < pooledRatio);
  assert.equal(boundArm(trials).precisionUpperBound, 1 / 5);
});

test('the frozen run bounds the baseline arm below the 70% ship bar', () => {
  const result = boundComparison(new URL('../benchmarks/paired-comparison-2026-09-14.json', import.meta.url).pathname);
  const baseline = result.arms.baseline;
  assert.equal(baseline.trials, 30);
  assert.equal(baseline.coreMatches, 27);
  assert.equal(baseline.findings, 56);
  // 25/56. Re-instrumenting the denominator cannot on its own reach the floor.
  assert.ok(Math.abs(baseline.precisionUpperBound - 25 / 56) < 1e-12);
  assert.ok(baseline.precisionUpperBound < 0.7);
  assert.equal(baseline.fromProse, 2);
});

test('the diagnostic declares that it replaces nothing', () => {
  const result = boundComparison(new URL('../benchmarks/paired-comparison-2026-09-14.json', import.meta.url).pathname);
  assert.equal(result.supersedes, null);
  assert.equal(result.label, 'findings-only-bound');
});
