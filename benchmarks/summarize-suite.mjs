import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '../dist/snapshot.js';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function summarizeSuite(directory) {
  const manifest = read(join(directory, 'suite.json'));
  const run = read(join(directory, 'suite-result.json'));
  const labels = read(join(directory, 'expected-grader-only.json'));
  const grades = read(join(directory, 'adjudication.json'));
  if (!run.finishedAt || run.suiteHash !== hash(readFileSync(join(directory, 'suite.json')))
    || labels.benchmarkCommit !== manifest.benchmarkCommit || grades.labelsHash !== hash(readFileSync(join(directory, 'expected-grader-only.json')))
    || grades.trials.length !== manifest.trials.length || run.trials.length !== manifest.trials.length
    || labels.cases.length !== manifest.cases.length || new Set(labels.cases.map(entry => entry.id)).size !== labels.cases.length) throw new Error('Incomplete or mismatched suite/grading artifacts');
  const used = new Set();
  const trials = run.trials.map((trial, index) => {
    if (trial.id !== manifest.trials[index].id || trial.caseId !== manifest.trials[index].caseId) throw new Error('Trial order/identity changed');
    const expected = labels.cases.find(entry => entry.id === trial.caseId);
    if (expected?.url !== manifest.cases.find(entry => entry.id === trial.caseId)?.url || !Array.isArray(expected?.comments)) throw new Error('Expected labels belong to a different case');
    const grade = grades.trials.find(entry => entry.id === trial.id);
    const path = join(directory, 'trials', trial.id, 'result.json');
    const findings = existsSync(path) ? read(path).findings : [];
    if (!expected || !grade || used.has(grade.id) || grade.findingsHash !== hash(JSON.stringify(findings))) throw new Error('Missing or stale trial adjudication');
    used.add(grade.id);
    const matched = new Set(), coveredFindings = new Set();
    for (const match of grade.matches) {
      if (!Number.isInteger(match.annotation) || match.annotation < 0 || match.annotation >= expected.comments.length
        || matched.has(match.annotation) || !match.findingIds.length || !match.reason) throw new Error('Invalid annotation match');
      matched.add(match.annotation);
      for (const id of match.findingIds) {
        if (!findings.some(finding => finding.id === id)) throw new Error('Match cites absent finding');
        coveredFindings.add(id);
      }
    }
    const extras = findings.filter(finding => !coveredFindings.has(finding.id));
    const extraIds = new Set();
    for (const extra of grade.extras) {
      if (!extras.some(finding => finding.id === extra.id) || extraIds.has(extra.id)
        || !['supported', 'unsupported', 'uncertain'].includes(extra.assessment) || !extra.reason) throw new Error('Invalid extra-finding adjudication');
      extraIds.add(extra.id);
    }
    if (extraIds.size !== extras.length) throw new Error('Extra findings must be adjudicated, not assumed false');
    const completed = trial.status === 'completed' && trial.stopReason === 'finished';
    return { ...trial, semanticAdjudication: 'completed', completed, expectedAnnotations: expected.comments.length,
      matchedAnnotations: matched.size, completedMatchedAnnotations: completed ? matched.size : 0,
      salvagedMatchedAnnotations: completed ? 0 : matched.size, extraFindings: extras.length,
      supportedExtras: grade.extras.filter(extra => extra.assessment === 'supported').length,
      unsupportedExtras: grade.extras.filter(extra => extra.assessment === 'unsupported').length,
      uncertainExtras: grade.extras.filter(extra => extra.assessment === 'uncertain').length };
  });
  const sum = key => trials.reduce((total, trial) => total + (trial[key] ?? 0), 0);
  const completed = trials.filter(trial => trial.completed);
  return { suiteHash: run.suiteHash, method: grades.method, scheduledTrials: trials.length, attemptedTrials: trials.filter(trial => trial.status !== 'unattempted').length,
    completedTrials: completed.length, completionRate: completed.length / trials.length,
    completedWithinTenMinutes: completed.filter(trial => trial.elapsedMs <= 600000).length,
    expectedAnnotationOpportunities: sum('expectedAnnotations'), completedMatchedAnnotations: sum('completedMatchedAnnotations'),
    salvagedMatchedAnnotations: sum('salvagedMatchedAnnotations'),
    completedTrialAnnotationOpportunities: completed.reduce((sum, trial) => sum + trial.expectedAnnotations, 0),
    extraFindings: sum('extraFindings'), supportedExtras: sum('supportedExtras'), unsupportedExtras: sum('unsupportedExtras'), uncertainExtras: sum('uncertainExtras'),
    completedMedianMs: median(completed.map(trial => trial.elapsedMs)), completedRangeMs: completed.length ? [Math.min(...completed.map(trial => trial.elapsedMs)), Math.max(...completed.map(trial => trial.elapsedMs))] : null,
    actualInputTokens: sum('actualInputTokens'), actualOutputTokens: sum('actualOutputTokens'), cachedInputTokens: sum('cachedInputTokens'), unsettledCalls: sum('unsettledCalls'),
    billing: 'subscription', additionalApiUsd: sum('additionalApiUsd'), allocatedSubscriptionCostUsd: null,
    limits: 'Small selected development suite; manual semantic grading, no independent judge or clean controls. Raw annotation denominators retained. This is not an accuracy or precision estimate.', trials };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('Usage: node summarize-suite.mjs <graded-suite-directory>');
  const directory = resolve(process.argv[2]);
  const summary = summarizeSuite(directory);
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ completed: summary.completedTrials, scheduled: summary.scheduledTrials,
    matchedFromCompleted: summary.completedMatchedAnnotations, expectedOpportunities: summary.expectedAnnotationOpportunities,
    medianCompletedSeconds: summary.completedMedianMs / 1000 }));
}
