// A separately labelled diagnostic over the frozen paired comparison. It bounds
// precision on a structured-findings denominator; it does not replace the pinned
// upstream score, which stays the comparable number. See paired-comparison-2026-09-14.md.
//
// The bound is per trial, never pooled. A trial cannot have derived more matches
// from structured findings than it emitted, so min(coreMatches, findings) is the
// ceiling for that trial. Pooling first overstates the ceiling, because it lets a
// trial that matched through report prose borrow another trial's unmatched findings.
import { readFileSync } from 'node:fs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sum = (values, of) => values.reduce((total, value) => total + of(value), 0);

export function boundArm(trials) {
  const findings = sum(trials, t => t.findings);
  const coreMatches = sum(trials, t => t.coreMatches);
  const fromFindings = sum(trials, t => Math.min(t.coreMatches, t.findings));
  return {
    trials: trials.length, findings, coreMatches,
    coreExpected: sum(trials, t => t.coreExpected),
    // Matches a structured finding provably cannot account for: they came from
    // extracted report prose, so a findings-only denominator would lose them.
    fromProse: coreMatches - fromFindings,
    proseTrials: trials.filter(t => t.coreMatches > t.findings).map(t => t.id),
    precisionUpperBound: findings ? fromFindings / findings : null,
  };
}

export function boundComparison(path) {
  const comparison = read(path);
  const trials = comparison.cases.flatMap(c => c.trials);
  if (trials.length !== 60) throw Error(`Expected 60 frozen trials, found ${trials.length}`);
  return {
    label: 'findings-only-bound',
    supersedes: null,
    note: 'Upper bound only. Attributing each match to a specific finding needs the raw run artifacts.',
    manifestHash: comparison.manifestHash,
    arms: Object.fromEntries(['baseline', 'candidate'].map(arm =>
      [arm, boundArm(trials.filter(t => t.arm === arm))])),
  };
}

if (import.meta.filename === process.argv[1]) {
  const result = boundComparison(process.argv[2] ?? new URL('paired-comparison-2026-09-14.json', import.meta.url).pathname);
  for (const [arm, a] of Object.entries(result.arms)) {
    console.log(`${arm}: ${a.coreMatches} core matches of ${a.coreExpected} expected, ${a.findings} structured findings`);
    console.log(`  findings-only precision <= ${(a.precisionUpperBound * 100).toFixed(1)}%`);
    console.log(`  ${a.fromProse} match(es) provably from report prose${a.proseTrials.length ? `: ${a.proseTrials.join(', ')}` : ''}`);
  }
  console.log(`\n${result.note}`);
}
