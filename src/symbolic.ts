import { declaresSymbol, searchable, type Expectation, type Side, type SymbolicCheck } from './claim.js';
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
  search(query: string, within?: string): { matches: { path: string; line: number }[]; truncated: boolean };
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

interface Declaration { path: string; line: number; text: string; span: number }

// A declaration is not always one line. Python and TypeScript both wrap a long parameter
// list, and `declaration_contains` reading only the first line makes the parameter it was
// asked about invisible: measured 2026-09-21 on Martian case-046, where
// `IssueSyncIntegration.sync_status_outbound` declares `assignment_source` six lines below
// `def`, so the check missed and refuted a correct claim at the strongest verdict there
// is. Read the signature to the end of its parameter list instead, and hand the line count
// to `bodyOf` so the two assertions stay disjoint rather than both claiming these lines.
const DECLARATION_LINES = 40;
function declarationAt(revision: Revision, path: string, line: number, first: string): { text: string; span: number } {
  const depth = (value: string) => [...value].reduce((open, ch) => open + (ch === '(' ? 1 : ch === ')' ? -1 : 0), 0);
  if (depth(first) <= 0) return { text: first, span: 1 };
  const text = revision.slice(path, line, DECLARATION_LINES);
  if (text === null) return { text: first, span: 1 };
  const lines = text.split('\n');
  let open = 0;
  for (let index = 0; index < lines.length; index++) {
    open += depth(lines[index]!);
    if (open <= 0) return { text: lines.slice(0, index + 1).join('\n'), span: index + 1 };
  }
  return { text: first, span: 1 };
}
interface Declarations { found: Declaration[]; truncated: boolean }
const indentOf = (value: string) => value.length - value.trimStart().length;

function declaredAs(revision: Revision, symbol: string): Declarations {
  const { matches, truncated } = revision.search(symbol);
  const found = matches.flatMap(match => {
    const text = revision.lineAt(match.path, match.line);
    return text !== null && declaresSymbol(text, symbol)
      ? [{ ...match, ...declarationAt(revision, match.path, match.line, text) }] : [];
  });
  return { found, truncated };
}

// A member written the way a reader would name it - `IssueSyncIntegration.should_sync` -
// is not text that appears in the source, so the literal search finds nothing and the
// proposition goes unsettled with a limitation nobody downstream can act on. Measured
// 2026-09-21 on Martian case-046: all eleven limitations in one run were this, and the
// claims they belonged to were correct.
//
// A second global search does not resolve it either: `sync_status_outbound` alone returns
// more matches than the search caps at, so the owner's file is never among them. The
// owner's name is distinctive, so look that up instead and read the member out of its
// body.
function withinOwner(revision: Revision, owner: string, member: string): Declarations {
  const found = declaredAs(revision, owner).found.flatMap(match => {
    const text = revision.slice(match.path, match.line, BODY_LINES);
    if (text === null) return [];
    const lines = text.split('\n');
    const opening = indentOf(lines[0] ?? '');
    const inside: Declaration[] = [];
    for (let offset = 1; offset < lines.length; offset++) {
      const line = lines[offset]!;
      if (line.trim() && indentOf(line) <= opening) break;
      if (declaresSymbol(line, member))
        inside.push({ path: match.path, line: match.line + offset, ...declarationAt(revision, match.path, match.line + offset, line) });
    }
    return inside;
  });
  // The owner's body is read only as far as the cap, so finding nothing inside it does
  // not establish that the member is absent -- the same reservation a truncated search
  // carries, and reported the same way.
  return { found, truncated: found.length === 0 };
}

// The fallback runs only when the literal name found nothing, so a symbol that resolves
// on its own is never reinterpreted, and it can only settle a proposition that would
// otherwise settle nothing.
function declarations(revision: Revision, symbol: string) {
  const literal = declaredAs(revision, symbol);
  const dot = symbol.lastIndexOf('.');
  if (literal.found.length || literal.truncated || dot <= 0) return literal;
  const owner = symbol.slice(0, dot), member = symbol.slice(dot + 1);
  if (!searchable(owner) || !searchable(member)) return literal;
  return withinOwner(revision, owner, member);
}

// The assertion is evaluated in its positive form, then read against what the claim
// expects. A claim that a guard is gone is supported by the guard being absent, so
// polarity has to come from the claim, not from the check's phrasing.
const settle = (established: boolean, expect: Expectation = 'present'): 'hit' | 'miss' =>
  established === (expect === 'present') ? 'hit' : 'miss';

// The lines belonging to a definition: everything indented past it, up to the cap.
// Works for braces and for significant indentation alike, because the closing brace
// sits back at the definition's own indent.
function bodyOf(revision: Revision, path: string, line: number, span = 1): { text: string; capped: boolean } | null {
  // The signature and what follows it are read separately. Read as one range, a wrapped
  // signature pushed the request past the 200-line read limit, the read threw, and every
  // body check on it came back "could not be read": seen 2026-09-24 on every multi-line
  // TypeScript declaration in mason-v1 #4583, which is what Prettier makes of most of them.
  const signature = revision.slice(path, line, span);
  if (signature === null) return null;
  const rest = followingLines(revision, path, line + span);
  if (rest === null) return null;
  const lines = [...signature.split('\n'), ...rest];
  const opening = indentOf(lines[0] ?? '');
  let end = span;
  while (end < lines.length && (!lines[end]!.trim() || indentOf(lines[end]!) > opening)) end++;
  // The declaration line belongs to `declaration_contains`, which reads exactly that
  // line. Including it here made the two assertions overlap on it and broke the negative
  // form of this one: `body_contains(f, "actorId", expect: 'absent')` is how a reviewer
  // says a parameter is accepted and never used, and the parameter list refuted it every
  // time. Measured 2026-09-20 over 31 runs: four correct `auth_bypass` claims died on
  // that alone, with nothing downstream able to see why.
  // A definition with nothing indented under it has no body separate from its
  // declaration, so there the line stays; dropping it would leave an empty body that
  // refutes every `expect: 'present'` check.
  const body = end > span ? lines.slice(span, end) : lines.slice(0, end);
  return { text: body.join('\n'), capped: end === lines.length && rest.length === BODY_LINES - 1 };
}
// Up to BODY_LINES - 1 lines from `start`, fewer when the range would pass the read's
// 24 KB limit, and none at the end of the file, where a definition has no body below it.
function followingLines(revision: Revision, path: string, start: number): string[] | null {
  for (let count = BODY_LINES - 1; count >= 1; count = Math.floor(count / 2)) {
    const text = revision.slice(path, start, count);
    if (text !== null) return text.split('\n');
  }
  // Nothing readable: either the declaration is the file's last line or a single line is
  // over the limit. The first is an empty body; the second cannot be told from it here, so
  // it is read as unreadable rather than as empty.
  return revision.lineAt(path, start - 1) !== null && revision.lineAt(path, start) === null ? [] : null;
}

export function runCheck(revision: Revision, check: SymbolicCheck): CheckOutcome {
  const expect = check.expect ?? 'present';
  const at = check.revision === 'base' ? ' at the merge base' : '';
  // `search` rejects anything that is not a single literal line of at most 200
  // characters, and it rejects it by throwing. A claim carrying one is not a claim rung
  // 1 can run, and it must not be able to end the review: before this, one such pattern
  // threw out of verification and lost every other claim in the run with it. Claims are
  // screened at emit time too, but a claim can also arrive from a file or a fixture.
  const literals = [...('pattern' in check ? [check.pattern] : []), ...('symbol' in check ? [check.symbol] : [])];
  if (literals.some(value => !searchable(value))) {
    return inconclusive(`${check.assertion}${at}`,
      'the check names a pattern or symbol the search cannot run: it must be a single line of at most 200 characters');
  }
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
    const bodies = found.map(site => ({ site, body: bodyOf(revision, site.path, site.line, site.span) }));
    const readable = bodies.flatMap(item => item.body ? [{ site: item.site, body: item.body }] : []);
    if (!readable.length) return inconclusive(label, `the body of \`${check.symbol}\` could not be read`);
    const containing = readable.filter(item => item.body.text.includes(check.pattern));
    // A search that hit its cap did not reach every declaration, so finding nothing
    // among the ones it did reach establishes nothing either way. Without this, a
    // common symbol name in a large repository refutes whatever is asked about it.
    // Measured 2026-09-21 on Martian case-005: `handler` has more declarations than the
    // search returns, the pattern the claim named sits in one the search never reached,
    // and a true High-severity concurrency finding was refuted at high confidence with
    // no limitation recorded. The claim's own location named the right file.
    if (!containing.length && truncated) {
      return inconclusive(label, `the search truncated before it could reach every declaration of \`${check.symbol}\`, so this says nothing about the ones it did not read`);
    }
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
    // Same as `body_contains`: nothing found among an incomplete set of declarations is
    // not evidence about the ones the search never reached.
    if (!matching.length && truncated) {
      return inconclusive(label, `the search truncated before it could reach every declaration of \`${check.symbol}\`, so this says nothing about the ones it did not read`);
    }
    const site = (matching[0] ?? found[0])!;
    return {
      evidence: [{ rung: 'symbolic', check: `${label} (${site.path}:${site.line})`, result: settle(matching.length > 0, expect) }],
      limitations: truncated ? [`${label}: the search truncated, so other declarations may exist`] : [],
    };
  }

  if (check.assertion === 'file_contains') {
    const label = `grep: ${check.path}${at} ${expect === 'present' ? 'contains' : 'lacks'} ${JSON.stringify(check.pattern)}`;
    // A file that is not in this revision settles nothing. Reading it as "the pattern
    // is absent" would let a claim about a test be supported by the test not existing,
    // which is a different claim and one nobody made.
    if (revision.slice(check.path, 1, 1) === null) {
      return inconclusive(label, `${check.path} does not exist in this revision`);
    }
    const { matches, truncated } = revision.search(check.pattern, check.path);
    const inFile = matches.filter(match => match.path === check.path);
    // The search caps, and a cap proves nothing about what it did not reach. Absence
    // stays unestablished rather than being reported as the refutation a miss is.
    if (!inFile.length && truncated) {
      return inconclusive(label, 'the search truncated before it could rule out a match in this file');
    }
    const where = inFile.length ? ` (${check.path}:${inFile[0]!.line})` : ` (${check.path})`;
    return { evidence: [{ rung: 'symbolic', check: `${label}${where}`, result: settle(inFile.length > 0, expect) }], limitations: [] };
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
    search: (query, within) => search(repository, revision, query, within),
    lineAt(path, line) {
      try { return slice(repository, revision, path, line, 1).text; } catch { return null; }
    },
    slice(path, startLine, count) {
      try { return slice(repository, revision, path, startLine, count).text; } catch { return null; }
    },
  };
}
