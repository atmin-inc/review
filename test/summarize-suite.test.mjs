import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../dist/snapshot.js';
import { summarizeSuite } from '../benchmarks/summarize-suite.mjs';

test('summary separates completed detection, salvaged findings, extra findings and unknown usage', t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-repeat-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
  const trials = [{ id: 'one', caseId: 'case' }, { id: 'two', caseId: 'case' }];
  save('suite.json', { benchmarkCommit: 'fixture', cases: [{ id: 'case', url: 'https://example.invalid/pr/1' }], trials });
  save('expected-grader-only.json', { benchmarkCommit: 'fixture', cases: [{ id: 'case', url: 'https://example.invalid/pr/1', comments: ['first issue', 'second issue'] }] });
  save('suite-result.json', { suiteHash: hash(readFileSync(join(root, 'suite.json'))), finishedAt: 'done', trials: [
    { ...trials[0], status: 'completed', stopReason: 'finished', elapsedMs: 120000, actualInputTokens: 100, unsettledCalls: 0 },
    { ...trials[1], status: 'partial', stopReason: 'provider unavailable', elapsedMs: 30000, actualInputTokens: 50, unsettledCalls: 1 },
  ] });
  const findings = [[{ id: 'bug' }], [{ id: 'bug' }, { id: 'extra' }]];
  trials.forEach((trial, i) => { mkdirSync(join(root, 'trials', trial.id), { recursive: true }); save(`trials/${trial.id}/result.json`, { findings: findings[i] }); });
  const grades = { method: 'deterministic grading fixture', labelsHash: hash(readFileSync(join(root, 'expected-grader-only.json'))),
    trials: trials.map((trial, i) => ({ id: trial.id, findingsHash: hash(JSON.stringify(findings[i])),
      matches: [{ annotation: 0, findingIds: ['bug'], reason: 'Same defect mechanism.' }],
      extras: i === 1 ? [{ id: 'extra', assessment: 'uncertain', reason: 'Needs independent validation.' }] : [] })) };
  save('adjudication.json', grades);
  const result = summarizeSuite(root);
  assert.equal(result.completionRate, 0.5);
  assert.ok(result.trials.every(trial => trial.semanticAdjudication === 'completed'));
  assert.equal(result.expectedAnnotationOpportunities, 4);
  assert.equal(result.completedMatchedAnnotations, 1);
  assert.equal(result.salvagedMatchedAnnotations, 1);
  assert.equal(result.completedTrialAnnotationOpportunities, 2);
  assert.equal(result.completedMedianMs, 120000);
  assert.equal(result.uncertainExtras, 1);
  assert.equal(result.unsupportedExtras, 0);
  assert.equal(result.actualInputTokens, 150);
  assert.equal(result.unsettledCalls, 1);
  assert.equal(result.allocatedSubscriptionCostUsd, null);
  grades.trials[1].findingsHash = 'stale'; save('adjudication.json', grades);
  assert.throws(() => summarizeSuite(root), /stale trial adjudication/);
});
