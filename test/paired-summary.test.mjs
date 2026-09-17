import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizePairs } from '../benchmarks/paired-summary.mjs';
import { hash } from '../dist/snapshot.js';

test('paired summary preserves repeats, failed attempts, matching uncertainty and artifact integrity', t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-paired-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
  const cases = Array.from({ length: 15 }, (_, i) => ({ id: `case-${i}`, url: `https://example.test/${i}` }));
  const trials = [1, 2].flatMap(repeat => cases.flatMap(c => (repeat === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
    .map(arm => ({ id: `${c.id}-${arm}-r${repeat}`, caseId: c.id, arm, repeat, evaluationArm: `${arm}-r${repeat}` }))));
  write('frozen.json', {});
  const manifest = { kind: 'frozen-controller-repeat-comparison', cases, trials, files: { 'frozen.json': hash('{}') }, judge: { model: 'test' } };
  write('comparison.json', manifest);
  const grades = { final: true, trials: {}, evaluations: {}, scores: {} };
  const outcomes = trials.map(trial => {
    const found = trial.arm === 'candidate' || trial.repeat === 1;
    const issue = { golden_comment: 'one bug', category: 'bug' };
    const evaluation = { true_positives: found ? [issue] : [], false_negatives: found ? [] : [issue], fp: 1 };
    const report = `trials/${trial.id}/report.md`;
    write(report, trial.id); write(`trials/${trial.id}/receipt.json`, { calls: [{ outputTokens: 20, meteredUsd: 0 }] });
    const reportHash = hash(readFileSync(join(root, report))), status = found ? 'completed' : 'incomplete';
    grades.trials[trial.id] = { status: 'graded', reviewStatus: status, reportHash, candidates: ['claim'], evaluation };
    const url = cases.find(c => c.id === trial.caseId).url;
    (grades.evaluations[url] ??= {})[trial.evaluationArm] = evaluation;
    return { ...trial, status, stopReason: found ? 'finished' : 'budget', reportHash, elapsedMs: found ? 100 : 900, findings: 1 };
  });
  for (const profile of ['strict', 'core', 'all']) grades.scores[profile] = Object.fromEntries(['baseline-r1', 'baseline-r2', 'candidate-r1', 'candidate-r2']
    .map(arm => [arm, { prs: 15, tp: arm === 'baseline-r2' ? 0 : 15, fn: arm === 'baseline-r2' ? 15 : 0, fp: 15 }]));
  const run = { finishedAt: '2026-09-14', manifestHash: hash(readFileSync(join(root, 'comparison.json'))), trials: outcomes };
  write('comparison-result.json', run); write('grading.json', grades); write('grader-protocol.json', {});
  write('judge-cost.json', { maxUsd: 5, calls: [{ status: 'settled', chargedOrReservedUsd: .1 }, { status: 'unknown-charge', chargedOrReservedUsd: .2 }] });
  const summary = summarizePairs(root);
  assert.deepEqual(summary.arms.candidate.scores.core.pooled, { prs: 30, tp: 30, fn: 0, fp: 30, precision: .5, recall: 1, fbeta: 5 / 6 });
  assert.equal(summary.arms.baseline.medianAttemptMs, 500);
  assert.equal(summary.arms.baseline.completed, 15);
  assert.deepEqual(summary.arms.baseline.repeatAgreement, { both: 0, either: 15, onlyOne: 15, neither: 0, casesWithIdenticalMatches: 0 });
  assert.equal(summary.judging.unknownChargeCalls, 1);
  assert.equal(summary.stateBuilds, null);
  assert.deepEqual(summary.arms.candidate.repositoryState, { current: 0, stale: 0, absent: 30 });
  for (const change of [g => { g.final = false; }, g => { g.trials[trials[0].id].reportHash = 'stale'; }, g => { g.scores.core['candidate-r2'].tp--; },
    g => { g.trials[trials[0].id].status = 'grading-error'; }, g => { delete g.evaluations[cases[0].url]['baseline-r2']; }]) {
    const bad = structuredClone(grades); change(bad); write('grading.json', bad); assert.throws(() => summarizePairs(root));
  }
  write('grading.json', grades);
  const priorGrade = { trials: { [trials[0].id]: grades.trials[trials[0].id] } };
  const priorCost = { calls: [{ status: 'settled', chargedOrReservedUsd: .1 }] };
  write('grading-transport-v2/before-grading.json', priorGrade);
  write('grading-transport-v2/before-judge-cost.json', priorCost);
  write('grader-continuation.json', { completedTrialsRetained: [trials[0].id], files: Object.fromEntries(['before-grading.json', 'before-judge-cost.json']
    .map(name => [`grading-transport-v2/${name}`, hash(readFileSync(join(root, 'grading-transport-v2', name)))])) });
  assert.equal(summarizePairs(root).gradingTransportContinuation.completedTrialsRetained.length, 1);
  write('judge-cost.json', { maxUsd: 5, calls: [{ status: 'settled', chargedOrReservedUsd: .05 }] });
  assert.throws(() => summarizePairs(root), /replaced retained outcomes or charges/);
  write('frozen.json', { changed: true });
  assert.throws(() => summarizePairs(root), /Frozen experiment file changed/);
});

test('a repository-state summary reports state usage per arm and build cost beside review cost', t => {
  const root = mkdtempSync(join(tmpdir(), 'atmin-state-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
  const cases = Array.from({ length: 15 }, (_, i) => ({ id: `case-${i}`, url: `https://example.test/${i}` }));
  const trials = [1, 2].flatMap(repeat => cases.flatMap(c => (repeat === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
    .map(arm => ({ id: `${c.id}-${arm}-r${repeat}`, caseId: c.id, arm, repeat, evaluationArm: `${arm}-r${repeat}` }))));
  const manifest = { kind: 'frozen-repository-state-comparison', cases, trials, files: {}, states: {}, judge: { model: 'test' } };
  for (const c of cases) {
    write(`states/${c.id}/repository-state.json`, { complete: c.id !== 'case-0', sections: [{}, {}] });
    write(`states/${c.id}/repository-state.receipt.json`, { stopReason: 'finished', startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:01:00.000Z', toolCalls: 4,
      calls: [{ inputTokens: 100, cachedInputTokens: 10, outputTokens: 5, reservedUsd: 1, meteredUsd: 0 }, { inputTokens: 50, cachedInputTokens: 0, outputTokens: null, reservedUsd: 0.5, meteredUsd: null }] });
    manifest.states[c.id] = `states/${c.id}/repository-state.json`;
    for (const name of ['repository-state.json', 'repository-state.receipt.json']) manifest.files[`states/${c.id}/${name}`] = hash(readFileSync(join(root, 'states', c.id, name)));
  }
  write('comparison.json', manifest);
  const grades = { final: true, trials: {}, evaluations: {}, scores: {} };
  const issue = { golden_comment: 'one bug', category: 'bug' };
  const outcomes = trials.map(trial => {
    const evaluation = { true_positives: [issue], false_negatives: [], fp: 0 };
    write(`trials/${trial.id}/report.md`, trial.id);
    const reportHash = hash(readFileSync(join(root, 'trials', trial.id, 'report.md')));
    grades.trials[trial.id] = { status: 'graded', reviewStatus: 'completed', reportHash, candidates: ['claim'], evaluation };
    (grades.evaluations[cases.find(c => c.id === trial.caseId).url] ??= {})[trial.evaluationArm] = evaluation;
    return { ...trial, status: 'completed', stopReason: 'finished', reportHash, elapsedMs: 100, findings: 1, withdrawals: trial.arm === 'candidate' ? 1 : 0,
      repositoryState: trial.arm === 'candidate' ? { status: trial.caseId === 'case-1' ? 'stale' : 'current', commit: 'c', sections: 2 } : null };
  });
  for (const profile of ['strict', 'core', 'all']) grades.scores[profile] = Object.fromEntries(['baseline-r1', 'baseline-r2', 'candidate-r1', 'candidate-r2'].map(arm => [arm, { prs: 15, tp: 15, fn: 0, fp: 0 }]));
  write('comparison-result.json', { finishedAt: '2026-09-17', manifestHash: hash(readFileSync(join(root, 'comparison.json'))), trials: outcomes });
  write('grading.json', grades); write('grader-protocol.json', {}); write('judge-cost.json', { maxUsd: 5, calls: [] });
  const summary = summarizePairs(root);
  assert.deepEqual(summary.arms.candidate.repositoryState, { current: 28, stale: 2, absent: 0 });
  assert.deepEqual(summary.arms.baseline.repositoryState, { current: 0, stale: 0, absent: 30 });
  assert.equal(summary.arms.candidate.withdrawals, 30);
  assert.equal(summary.stateBuilds.completeStates, 14);
  assert.deepEqual(summary.stateBuilds.totals, { elapsedMs: 900000, modelCalls: 30, toolCalls: 60, actualInputTokens: 1500, cachedInputTokens: 150, actualOutputTokens: 75, accountedUsd: 7.5 });
  assert.match(summary.limitations[2], /only candidate trials receive repository-state\.json/);
});
