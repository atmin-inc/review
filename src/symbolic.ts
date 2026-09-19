import { declaresSymbol } from './claim.js';
import { searchSource, sourceSlice } from './snapshot.js';
import type { Evidence } from './evidence.js';

// Rung 1. Deterministic facts about the frozen revision: grep over immutable blobs
// plus a declaration test, never a model. Nearly free, and most claims are meant to
// die here. See docs/claim-lifecycle-design-2026-09-17.md section 4.
//
// Polarity is fixed and load-bearing: a hit is evidence FOR the claim, a miss is
// evidence AGAINST it, and a miss on this rung refutes outright. So a check must
// only report a miss when it actually established the negative, never when it
// merely failed to look far enough.
export interface Revision {
  search(query: string): { matches: { path: string; line: number }[]; truncated: boolean };
  lineAt(path: string, line: number): string | null;
}
export interface CheckOutcome { evidence: Evidence[]; limitations: string[] }

export type SymbolicCheck =
  | { assertion: 'declaration_contains'; symbol: string; pattern: string }
  | { assertion: 'referenced_outside'; symbol: string; path: string };

const inconclusive = (check: string, why: string): CheckOutcome => ({ evidence: [], limitations: [`${check}: ${why}`] });

function declarations(revision: Revision, symbol: string) {
  const { matches, truncated } = revision.search(symbol);
  const found = matches.flatMap(match => {
    const text = revision.lineAt(match.path, match.line);
    return text !== null && declaresSymbol(text, symbol) ? [{ ...match, text }] : [];
  });
  return { found, truncated };
}

export function runCheck(revision: Revision, check: SymbolicCheck): CheckOutcome {
  if (check.assertion === 'declaration_contains') {
    const label = `grep: declaration of \`${check.symbol}\` contains ${JSON.stringify(check.pattern)}`;
    const { found, truncated } = declarations(revision, check.symbol);
    if (!found.length) {
      // A search that hit its cap proves nothing about what it did not reach, and a
      // refutation is the strongest verdict available. Absence of evidence here is
      // a limitation, never a miss.
      return truncated ? inconclusive(label, 'the search truncated before any declaration was found')
        : inconclusive(label, `no declaration of \`${check.symbol}\` was found in this revision`);
    }
    const matching = found.filter(item => item.text.includes(check.pattern));
    const site = (matching[0] ?? found[0])!;
    return {
      evidence: [{
        rung: 'symbolic', check: `${label} (${site.path}:${site.line})`,
        result: matching.length ? 'hit' : 'miss',
      }],
      limitations: truncated ? [`${label}: the search truncated, so other declarations may exist`] : [],
    };
  }

  const label = `grep: \`${check.symbol}\` referenced outside ${check.path}`;
  const { matches, truncated } = revision.search(check.symbol);
  const outside = matches.filter(match => match.path !== check.path);
  if (outside.length) {
    return { evidence: [{ rung: 'symbolic', check: `${label} (${outside.length} site(s), first ${outside[0]!.path}:${outside[0]!.line})`, result: 'hit' }], limitations: [] };
  }
  return truncated ? inconclusive(label, 'the search truncated before it could rule out external references')
    : { evidence: [{ rung: 'symbolic', check: label, result: 'miss' }], limitations: [] };
}

export function runChecks(revision: Revision, checks: SymbolicCheck[]): CheckOutcome {
  const outcomes = checks.map(check => runCheck(revision, check));
  return {
    evidence: outcomes.flatMap(outcome => outcome.evidence),
    limitations: outcomes.flatMap(outcome => outcome.limitations),
  };
}

// The rung reads the same immutable revision the investigator was given: native Git
// over frozen blobs, no checkout, no text conversion, no repository scripts.
export function revisionFrom(repository: string, revision: string,
  search = searchSource, slice = sourceSlice): Revision {
  return {
    search: query => search(repository, revision, query),
    lineAt(path, line) {
      try { return slice(repository, revision, path, line, 1).text; } catch { return null; }
    },
  };
}
