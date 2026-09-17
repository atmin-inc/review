import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '../dist/snapshot.js';
import { validatePlan } from './martian-compare.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const core = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);
const median = values => {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return !ordered.length ? null : ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

export function summarizeComparison(directory) {
  const manifest = read(join(directory, 'comparison.json'));
  const run = read(join(directory, 'comparison-result.json'));
  const grades = read(join(directory, 'grading.json'));
  const cost = read(join(directory, 'judge-cost.json'));
  validatePlan(manifest);
  if (!run.finishedAt || !grades.final || run.manifestHash !== hash(readFileSync(join(directory, 'comparison.json')))
    || run.trials.length !== 30 || Object.keys(grades.trials).length !== 30) throw Error('Comparison or grading is incomplete');
  for (const [index, trial] of run.trials.entries()) {
    const scheduled = manifest.trials[index], grade = grades.trials[trial.id];
    const url = manifest.cases.find(c => c.id === trial.caseId)?.url;
    const report = join(directory, 'trials', trial.id, 'report.md');
    if (trial.id !== scheduled.id || trial.caseId !== scheduled.caseId || trial.arm !== scheduled.arm
      || !grade || grade.status !== 'graded' || grade.reviewStatus !== trial.status
      || (trial.reportHash && trial.reportHash !== grade.reportHash)
      || grade.reportHash !== hash(existsSync(report) ? readFileSync(report) : '')
      || JSON.stringify(grade.evaluation) !== JSON.stringify(grades.evaluations[url]?.[trial.arm])) throw Error('Stale or mismatched review adjudication');
  }
  const cases = manifest.cases.map(entry => {
    const arms = Object.fromEntries(['atmin-r02-24', 'plain-codex'].map(arm => {
      const trial = run.trials.find(t => t.caseId === entry.id && t.arm === arm);
      const grade = grades.trials[trial.id], evaluation = grade.evaluation;
      const matches = evaluation.true_positives.filter(issue => core.has(issue.category)).length;
      const expected = matches + evaluation.false_negatives.filter(issue => core.has(issue.category)).length;
      return [arm, { status: trial.status, stopReason: trial.stopReason ?? null, elapsedMs: trial.elapsedMs ?? null,
        reportHash: grade.reportHash,
        coreMatches: matches, coreExpected: expected, unmatchedCandidates: evaluation.fp, candidates: grade.candidates.length }];
    }));
    if (arms['atmin-r02-24'].coreExpected !== arms['plain-codex'].coreExpected) throw Error('Paired annotation denominators differ');
    return { ...entry, arms };
  });
  const arms = Object.fromEntries(['atmin-r02-24', 'plain-codex'].map(arm => {
    const trials = run.trials.filter(t => t.arm === arm), completed = trials.filter(t => t.status === 'completed' && t.stopReason === 'finished');
    const durations = completed.map(t => t.elapsedMs), sum = key => trials.reduce((total, t) => total + (t[key] ?? 0), 0);
    const attempts = trials.map(t => t.elapsedMs).filter(Number.isFinite);
    const incompleteUsage = trials.filter(t => {
      const receipt = join(directory, 'trials', t.id, 'receipt.json');
      return existsSync(receipt) ? read(receipt).calls.some(call => call.outputTokens === null)
        : t.status !== 'unattempted' && (t.actualInputTokens == null || t.actualOutputTokens == null);
    }).length;
    const score = grades.scores.core[arm];
    if (score.prs !== 15 || score.tp + score.fn !== cases.reduce((sum, c) => sum + c.arms[arm].coreExpected, 0)) throw Error('Scorer omitted scheduled cases');
    return [arm, { scheduled: 15, completed: completed.length, completedWithinTenMinutes: completed.filter(t => t.elapsedMs <= 600000).length,
      medianCompletedMs: median(durations), maxCompletedMs: durations.length ? Math.max(...durations) : null,
      medianAttemptMs: median(attempts), maxAttemptMs: attempts.length ? Math.max(...attempts) : null,
      actualInputTokens: sum('actualInputTokens'), cachedInputTokens: sum('cachedInputTokens'), actualOutputTokens: sum('actualOutputTokens'),
      trialsWithoutCompleteUsage: incompleteUsage, usageComplete: incompleteUsage === 0,
      core: score, strict: grades.scores.strict[arm], all: grades.scores.all[arm] }];
  }));
  return { benchmarkCommit: manifest.upstreamCommit, manifestHash: run.manifestHash, model: manifest.model, reasoning: manifest.reasoning,
    startedAt: run.startedAt, finishedAt: run.finishedAt, continuedAt: run.continuedAt ?? null,
    developmentCases: 15, reservedCases: 35, profile: 'core', beta: 2, arms, cases,
    judging: { model: manifest.judge.model, settledUsd: cost.calls.filter(c => c.status === 'settled').reduce((sum, c) => sum + c.chargedOrReservedUsd, 0),
      unknownChargeCalls: cost.calls.filter(c => c.status !== 'settled').length, chargedOrReservedUsd: cost.calls.reduce((sum, c) => sum + c.chargedOrReservedUsd, 0), calls: cost.calls.length, limitUsd: cost.maxUsd },
    reviewBilling: { additionalApiUsd: 0, method: 'existing ChatGPT subscription', allocatedSubscriptionCostUsd: null },
    artifacts: Object.fromEntries(['preparation.json', 'comparison.json', 'comparison-result.json', 'grading.json', 'grader-protocol.json', 'judge-cost.json', 'continuation.json']
      .filter(path => existsSync(join(directory, path))).map(path => [path, hash(readFileSync(join(directory, path)))])),
    limitations: ['Selected development cases, one review per arm per PR; no clean-control false-alarm estimate or current hosted-bot comparison.',
      'Local atmin restarts Codex per tool batch; plain Codex keeps one session. Production API continuation differs.',
      'Upstream unmatched candidates are not independently established false positives; disputed labels remain in the unchanged score.',
      'One explicit dispatch continuation after a false quota flag; no completed review was retried.'] };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  const directory = resolve(process.argv[2]), summary = summarizeComparison(directory);
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ arms: summary.arms, judging: summary.judging }, null, 2));
}
