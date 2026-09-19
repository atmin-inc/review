import { declaresSymbol, type Expectation, type SymbolicCheck } from './claim.js';
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
  slice(path: string, startLine: number, count: number): string | null;
}
// git grep and sourceSlice both cap a read, so a body longer than this is inspected
// only as far as the cap and the shortfall is reported rather than assumed empty.
const BODY_LINES = 200;
export interface CheckOutcome { evidence: Evidence[]; limitations: string[] }

export type { Expectation, SymbolicCheck };

const inconclusive = (check: string, why: string): CheckOutcome => ({ evidence: [], limitations: [`${check}: ${why}`] });

function declarations(revision: Revision, symbol: string) {
  const { matches, truncated } = revision.search(symbol);
  const found = matches.flatMap(match => {
    const text = revision.lineAt(match.path, match.line);
    return text !== null && declaresSymbol(text, symbol) ? [{ ...match, text }] : [];
  });
  return { found, truncated };
}

// The assertion is evaluated in its positive form, then read against what the claim
// expects. A claim that a guard is gone is supported by the guard being absent, so
// polarity has to come from the claim, not from the check's phrasing.
const settle = (established: boolean, expect: Expectation = 'present'): 'hit' | 'miss' =>
  established === (expect === 'present') ? 'hit' : 'miss';

// The lines belonging to a definition: everything indented past it, up to the cap.
// Works for braces and for significant indentation alike, because the closing brace
// sits back at the definition's own indent.
function bodyOf(revision: Revision, path: string, line: number): { text: string; capped: boolean } | null {
  const text = revision.slice(path, line, BODY_LINES);
  if (text === null) return null;
  const lines = text.split('\n');
  const indentOf = (value: string) => value.length - value.trimStart().length;
  const opening = indentOf(lines[0] ?? '');
  let end = 1;
  while (end < lines.length && (!lines[end]!.trim() || indentOf(lines[end]!) > opening)) end++;
  return { text: lines.slice(0, end).join('\n'), capped: end === lines.length && lines.length === BODY_LINES };
}

export function runCheck(revision: Revision, check: SymbolicCheck): CheckOutcome {
  const expect = check.expect ?? 'present';
  if (check.assertion === 'body_contains') {
    const label = `grep: body of \`${check.symbol}\` ${expect === 'present' ? 'contains' : 'lacks'} ${JSON.stringify(check.pattern)}`;
    const { found, truncated } = declarations(revision, check.symbol);
    if (!found.length) {
      return truncated ? inconclusive(label, 'the search truncated before any declaration was found')
        : inconclusive(label, `no declaration of \`${check.symbol}\` was found in this revision`);
    }
    const site = found[0]!;
    const body = bodyOf(revision, site.path, site.line);
    if (body === null) return inconclusive(label, `the body of \`${check.symbol}\` could not be read`);
    // A body cut off at the cap cannot establish absence: the pattern may be past it.
    if (body.capped && !body.text.includes(check.pattern) && expect === 'absent') {
      return inconclusive(label, `the body exceeded ${BODY_LINES} lines, so absence could not be established`);
    }
    return {
      evidence: [{ rung: 'symbolic', check: `${label} (${site.path}:${site.line})`, result: settle(body.text.includes(check.pattern), expect) }],
      limitations: body.capped ? [`${label}: only the first ${BODY_LINES} lines of the body were inspected`] : [],
    };
  }
  if (check.assertion === 'declaration_contains') {
    const label = `grep: declaration of \`${check.symbol}\` ${expect === 'present' ? 'contains' : 'lacks'} ${JSON.stringify(check.pattern)}`;
    const { found, truncated } = declarations(revision, check.symbol);
    if (!found.length) {
      // A search that hit its cap proves nothing about what it did not reach, and a
      // refutation is the strongest verdict available. Absence of evidence here is
      // a limitation, never a miss, whichever way the claim points.
      return truncated ? inconclusive(label, 'the search truncated before any declaration was found')
        : inconclusive(label, `no declaration of \`${check.symbol}\` was found in this revision`);
    }
    const matching = found.filter(item => item.text.includes(check.pattern));
    const site = (matching[0] ?? found[0])!;
    return {
      evidence: [{ rung: 'symbolic', check: `${label} (${site.path}:${site.line})`, result: settle(matching.length > 0, expect) }],
      limitations: truncated ? [`${label}: the search truncated, so other declarations may exist`] : [],
    };
  }

  const label = `grep: \`${check.symbol}\` ${expect === 'present' ? 'referenced' : 'unreferenced'} outside ${check.path}`;
  const { matches, truncated } = revision.search(check.symbol);
  const outside = matches.filter(match => match.path !== check.path);
  if (!outside.length && truncated) {
    return inconclusive(label, 'the search truncated before it could rule out external references');
  }
  const where = outside.length ? ` (${outside.length} site(s), first ${outside[0]!.path}:${outside[0]!.line})` : '';
  return { evidence: [{ rung: 'symbolic', check: `${label}${where}`, result: settle(outside.length > 0, expect) }], limitations: [] };
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
    slice(path, startLine, count) {
      try { return slice(repository, revision, path, startLine, count).text; } catch { return null; }
    },
  };
}
