import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '../dist/snapshot.js';
import { validatePlan } from './paired-review.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const core = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};
const sum = (values, key) => values.reduce((total, value) => total + (value[key] ?? 0), 0);
const labels = (evaluation, key) => evaluation[key].filter(issue => core.has(issue.category)).map(issue => issue.golden_comment).sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function pool(scores) {
  const tp = sum(scores, 'tp'), fp = sum(scores, 'fp'), fn = sum(scores, 'fn');
  return { tp, fp, fn, prs: sum(scores, 'prs'), precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0, fbeta: 5 * tp + 4 * fn + fp ? 5 * tp / (5 * tp + 4 * fn + fp) : 0 };
}

export function summarizePairs(directory) {
  const manifest = read(join(directory, 'comparison.json')), run = read(join(directory, 'comparison-result.json'));
  const grades = read(join(directory, 'grading.json')), cost = read(join(directory, 'judge-cost.json'));
  const protocol = read(join(directory, 'grader-protocol.json'));
  const continuation = existsSync(join(directory, 'grader-continuation.json')) ? read(join(directory, 'grader-continuation.json')) : null;
  validatePlan(manifest);
  if (!run.finishedAt || !grades.final || run.manifestHash !== hash(readFileSync(join(directory, 'comparison.json')))
    || run.trials.length !== 60 || Object.keys(grades.trials).length !== 60) throw Error('Comparison or grading is incomplete');
  for (const [path, digest] of [...Object.entries(manifest.files), ...Object.entries(protocol.files ?? {}), ...Object.entries(continuation?.files ?? {})]) {
    if (path.startsWith('/') || path.split('/').includes('..') || hash(readFileSync(join(directory, path))) !== digest) throw Error('Frozen experiment file changed');
  }
  if (continuation) {
    const before = read(join(directory, 'grading-transport-v2/before-grading.json'));
    const beforeCost = read(join(directory, 'grading-transport-v2/before-judge-cost.json'));
    if (!equal(continuation.completedTrialsRetained, Object.keys(before.trials))
      || Object.entries(before.trials).some(([id, grade]) => !equal(grade, grades.trials[id]))
      || !equal(beforeCost.calls, cost.calls.slice(0, beforeCost.calls.length))) throw Error('Grader continuation replaced retained outcomes or charges');
  }
  for (const [index, trial] of run.trials.entries()) {
    const scheduled = manifest.trials[index], grade = grades.trials[trial.id];
    const url = manifest.cases.find(c => c.id === trial.caseId)?.url;
    const report = join(directory, 'trials', trial.id, 'report.md');
    if (['id', 'caseId', 'arm', 'repeat', 'evaluationArm'].some(key => trial[key] !== scheduled[key])
      || ['preparing', 'running'].includes(trial.status) || !grade || grade.status !== 'graded'
      || grade.reviewStatus !== trial.status || grade.evaluation?.skipped || grade.evaluation?.errors_count
      || (trial.reportHash && trial.reportHash !== grade.reportHash)
      || grade.reportHash !== hash(existsSync(report) ? readFileSync(report) : '')
      || !equal(grade.evaluation, grades.evaluations[url]?.[trial.evaluationArm])) throw Error('Stale or mismatched review adjudication');
  }
  const cases = manifest.cases.map(entry => {
    const trials = run.trials.filter(t => t.caseId === entry.id).map(trial => {
      const grade = grades.trials[trial.id], evaluation = grade.evaluation;
      const matched = labels(evaluation, 'true_positives'), missed = labels(evaluation, 'false_negatives');
      return { id: trial.id, arm: trial.arm, repeat: trial.repeat, status: trial.status, stopReason: trial.stopReason ?? null,
        elapsedMs: trial.elapsedMs ?? null, reportHash: grade.reportHash, findings: trial.findings ?? 0,
        candidates: grade.candidates.length, unmatchedCandidates: evaluation.fp,
        coreMatches: matched.length, coreExpected: matched.length + missed.length, matched, missed };
    });
    const expected = trials.map(t => [...t.matched, ...t.missed].sort());
    if (expected.some(e => !equal(e, expected[0]))) throw Error('Paired annotation denominators differ');
    const agreement = Object.fromEntries(['baseline', 'candidate'].map(arm => {
      const [a, b] = trials.filter(t => t.arm === arm);
      const both = a.matched.filter(label => b.matched.includes(label)).length;
      const either = new Set([...a.matched, ...b.matched]).size;
      return [arm, { both, either, onlyOne: either - both, neither: a.coreExpected - either,
        identicalMatches: equal(a.matched, b.matched) }];
    }));
    const comparisons = [1, 2].map(repeat => {
      const baseline = trials.find(t => t.arm === 'baseline' && t.repeat === repeat);
      const candidate = trials.find(t => t.arm === 'candidate' && t.repeat === repeat);
      return { repeat, candidateMinusBaselineMatches: candidate.coreMatches - baseline.coreMatches,
        candidateMinusBaselineMs: Number.isFinite(candidate.elapsedMs) && Number.isFinite(baseline.elapsedMs) ? candidate.elapsedMs - baseline.elapsedMs : null };
    });
    return { ...entry, trials, agreement, comparisons,
      candidateMinusBaselineMatches: sum(trials.filter(t => t.arm === 'candidate'), 'coreMatches') - sum(trials.filter(t => t.arm === 'baseline'), 'coreMatches') };
  });
  const arms = Object.fromEntries(['baseline', 'candidate'].map(arm => {
    const trials = run.trials.filter(t => t.arm === arm), attempted = trials.filter(t => t.status !== 'unattempted');
    const durations = attempted.map(t => t.elapsedMs ?? Date.parse(t.finishedAt) - Date.parse(t.startedAt)).filter(Number.isFinite);
    const unknownUsage = attempted.filter(t => {
      const path = join(directory, 'trials', t.id, 'receipt.json');
      return !existsSync(path) || read(path).calls.some(c => c.outputTokens === null || c.meteredUsd === null);
    }).length;
    const scores = Object.fromEntries(['strict', 'core', 'all'].map(profile => {
      const repeats = [1, 2].map(repeat => grades.scores[profile]?.[`${arm}-r${repeat}`]);
      if (repeats.some(score => !score || score.prs !== 15)) throw Error('Scorer omitted scheduled cases');
      if (profile === 'core' && repeats.some((score, i) => {
        const selected = cases.flatMap(c => c.trials).filter(t => t.arm === arm && t.repeat === i + 1);
        return score.tp !== sum(selected, 'coreMatches') || score.tp + score.fn !== sum(selected, 'coreExpected') || score.fp !== sum(selected, 'unmatchedCandidates');
      })) throw Error('Scorer counts differ from adjudications');
      return [profile, { repeats, pooled: pool(repeats) }];
    }));
    const completed = trials.filter(t => t.status === 'completed' && t.stopReason === 'finished');
    const agreement = cases.map(c => c.agreement[arm]);
    const phaseDurations = trials.flatMap(t => {
      const path = join(directory, 'trials', t.id, 'receipt.json');
      if (!existsSync(path)) return [];
      const receipt = read(path), discoveryMs = Date.parse(receipt.discovery?.finishedAt) - Date.parse(receipt.startedAt);
      return Number.isFinite(discoveryMs) && Number.isFinite(t.elapsedMs) ? [{ discoveryMs, assessmentMs: t.elapsedMs - discoveryMs }] : [];
    });
    return [arm, { scheduled: 30, attempted: attempted.length, completed: completed.length,
      repositoryState: Object.fromEntries(['current', 'stale', 'absent'].map(status => [status, trials.filter(t => (t.repositoryState?.status ?? 'absent') === status).length])),
      withdrawals: sum(trials, 'withdrawals'),
      completedWithinTenMinutes: completed.filter(t => t.elapsedMs <= 600000).length,
      statuses: Object.fromEntries([...new Set(trials.map(t => t.status))].map(status => [status, trials.filter(t => t.status === status).length])),
      medianAttemptMs: median(durations), maxAttemptMs: durations.length ? Math.max(...durations) : null,
      attemptsWithoutDuration: attempted.length - durations.length,
      phaseTiming: { trials: phaseDurations.length, medianDiscoveryMs: median(phaseDurations.map(t => t.discoveryMs)), medianAssessmentMs: median(phaseDurations.map(t => t.assessmentMs)) },
      actualInputTokens: sum(trials, 'actualInputTokens'), cachedInputTokens: sum(trials, 'cachedInputTokens'), actualOutputTokens: sum(trials, 'actualOutputTokens'),
      modelCalls: sum(trials, 'modelCalls'), toolCalls: sum(trials, 'toolCalls'), toolErrors: sum(trials, 'toolErrors'),
      trialsWithoutCompleteUsage: unknownUsage, unsettledCalls: sum(trials, 'unsettledCalls'),
      repeatAgreement: { both: sum(agreement, 'both'), either: sum(agreement, 'either'), onlyOne: sum(agreement, 'onlyOne'), neither: sum(agreement, 'neither'),
        casesWithIdenticalMatches: agreement.filter(a => a.identicalMatches).length }, scores }];
  }));
  // State-build cost is reported beside review cost, never folded into it.
  const stateBuilds = manifest.states ? Object.fromEntries(manifest.cases.map(entry => {
    const state = read(join(directory, manifest.states[entry.id]));
    const receipt = read(join(directory, manifest.states[entry.id].replace(/repository-state\.json$/, 'repository-state.receipt.json')));
    return [entry.id, { complete: state.complete, sections: state.sections.length, stopReason: receipt.stopReason,
      elapsedMs: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt), modelCalls: receipt.calls.length, toolCalls: receipt.toolCalls,
      actualInputTokens: sum(receipt.calls.filter(c => c.outputTokens !== null), 'inputTokens'), cachedInputTokens: sum(receipt.calls, 'cachedInputTokens'),
      actualOutputTokens: sum(receipt.calls, 'outputTokens'), accountedUsd: receipt.calls.reduce((total, c) => total + (c.meteredUsd ?? c.reservedUsd), 0) }];
  })) : null;
  const buildTotals = stateBuilds && Object.fromEntries(['elapsedMs', 'modelCalls', 'toolCalls', 'actualInputTokens', 'cachedInputTokens', 'actualOutputTokens', 'accountedUsd']
    .map(key => [key, sum(Object.values(stateBuilds), key)]));
  return { manifestHash: run.manifestHash, benchmarkCommit: manifest.upstreamCommit, engines: manifest.engines,
    stateBuilds: stateBuilds && { completeStates: Object.values(stateBuilds).filter(b => b.complete).length, totals: buildTotals, cases: stateBuilds },
    model: manifest.model, reasoning: manifest.reasoning, startedAt: run.startedAt, finishedAt: run.finishedAt,
    developmentCases: 15, reservedCases: 35, repeats: 2, arms, cases,
    pairedCases: { candidateMore: cases.filter(c => c.candidateMinusBaselineMatches > 0).length,
      equal: cases.filter(c => c.candidateMinusBaselineMatches === 0).length, baselineMore: cases.filter(c => c.candidateMinusBaselineMatches < 0).length },
    judging: { model: manifest.judge.model, settledUsd: sum(cost.calls.filter(c => c.status === 'settled'), 'chargedOrReservedUsd'),
      unknownChargeCalls: cost.calls.filter(c => c.status !== 'settled').length, chargedOrReservedUsd: sum(cost.calls, 'chargedOrReservedUsd'), calls: cost.calls.length, limitUsd: cost.maxUsd },
    reviewBilling: { additionalApiUsd: 0, method: 'existing ChatGPT subscription', allocatedSubscriptionCostUsd: null },
    gradingTransportContinuation: continuation,
    artifacts: Object.fromEntries(['comparison.json', 'comparison-result.json', 'grading.json', 'grader-protocol.json', 'judge-cost.json', 'grader-continuation.json', 'grader-protocol-original.json']
      .filter(path => existsSync(join(directory, path)))
      .map(path => [path, hash(readFileSync(join(directory, path)))])),
    limitations: ['Two repeats on 15 public development PRs; repeats are not independent new cases. The 35 reserved cases remain unrun.',
      'Upstream unmatched candidates are not independently established false positives. Source-audit decisions do not change these scores.',
      manifest.states ? 'Both arms share one engine build, the local Codex adapter, model, profile, renderer and source packets; only candidate trials receive repository-state.json. Production API transport differs.'
        : 'Both controllers share the repaired continuous local Codex adapter, model, profile, renderer and source packets. Production API transport differs.',
      'No clean-control false-alarm estimate or current hosted-bot comparison. Latency includes quality assessment and optional fix proposals.'] };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  const directory = resolve(process.argv[2]), summary = summarizePairs(directory);
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ arms: summary.arms, judging: summary.judging }, null, 2));
}
