import { declaresSymbol, type Expectation, type Side, type SymbolicCheck } from './claim.js';
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
// Both sides of the change, because a claim about a regression is a claim about the
// difference between them. A check names the side it is asking about.
export interface Revisions { head: Revision; base: Revision }
export const sideOf = (revisions: Revisions, check: SymbolicCheck): Revision =>
  check.revision === 'base' ? revisions.base : revisions.head;

export type { Expectation, Side, SymbolicCheck };

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
  const at = check.revision === 'base' ? ' at the merge base' : '';
  if (check.assertion === 'body_contains') {
    const label = `grep: body of \`${check.symbol}\`${at} ${expect === 'present' ? 'contains' : 'lacks'} ${JSON.stringify(check.pattern)}`;
    const { found, truncated } = declarations(revision, check.symbol);
    if (!found.length) {
      return truncated ? inconclusive(label, 'the search truncated before any declaration was found')
        : inconclusive(label, `no declaration of \`${check.symbol}\` was found in this revision`);
    }
    // Every declaration, not the first one that turned up. A symbol can be defined
    // more than once — an interface and its implementation, a platform variant — and
    // inspecting one of them is the partial inspection the 2026-09-14 audit recorded
    // as a false-positive mechanism: a module read as far as line 180 was treated as
    // evidence that an initialization at 218 did not exist.
    const bodies = found.map(site => ({ site, body: bodyOf(revision, site.path, site.line) }));
    const readable = bodies.flatMap(item => item.body ? [{ site: item.site, body: item.body }] : []);
    if (!readable.length) return inconclusive(label, `the body of \`${check.symbol}\` could not be read`);
    const containing = readable.filter(item => item.body.text.includes(check.pattern));
    // Absence has to hold across all of them, so a body that was cut off at the cap,
    // or one that could not be read at all, leaves it unestablished.
    const incomplete = readable.filter(item => item.body.capped).length + (bodies.length - readable.length);
    if (expect === 'absent' && !containing.length && incomplete) {
      return inconclusive(label, `${incomplete} of ${bodies.length} declaration bodies could not be inspected in full, so absence could not be established`);
    }
    const site = (containing[0] ?? readable[0]!).site;
    const where = bodies.length > 1 ? ` (${site.path}:${site.line}, ${bodies.length} declarations)` : ` (${site.path}:${site.line})`;
    return {
      evidence: [{ rung: 'symbolic', check: `${label}${where}`, result: settle(containing.length > 0, expect) }],
      limitations: incomplete ? [`${label}: ${incomplete} of ${bodies.length} declaration bodies were inspected only in part`] : [],
    };
  }
  if (check.assertion === 'declaration_contains') {
    const label = `grep: declaration of \`${check.symbol}\`${at} ${expect === 'present' ? 'contains' : 'lacks'} ${JSON.stringify(check.pattern)}`;
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

  const label = `grep: \`${check.symbol}\` ${expect === 'present' ? 'referenced' : 'unreferenced'} outside ${check.path}${at}`;
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
