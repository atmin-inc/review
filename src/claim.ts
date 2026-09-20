import { hash } from './snapshot.js';
import { PRIORITIES, type Priority } from './contracts.js';

// A claim is one falsifiable assertion about one location, emitted by the
// investigator. It is not a finding: a finding is what survives verification.
// See spec/claim-schema.md.
export const CLAIM_TYPES = ['injection_risk', 'hardcoded_secret', 'auth_bypass', 'race_condition',
  'data_loss', 'contract_break', 'error_handling_gap', 'resource_leak'] as const;
export type ClaimType = typeof CLAIM_TYPES[number];

// Rung 1's closed catalogue. The investigator selects and parameterizes a check;
// it never authors a new kind of one. Literal grep over frozen blobs is read-only,
// so a model-chosen symbol is a search term, not a capability.
// `expect` exists because most review claims are about absence: a guard removed, a
// null check missing, a bound never applied. Without it a check can only support
// claims about what IS there, and every absence claim would read as refuted.
//
// `revision` exists because a review claims a REGRESSION, and a condition that
// already holds at the merge base is not one. The 2026-09-14 audit recorded this as
// one of three recurring false-positive mechanisms: a claim was attributed to a pull
// request because related lines changed, while its whole trigger existed before.
// Settling that needs the same check run against the base.
export type Expectation = 'present' | 'absent';
export type Side = 'head' | 'base';
interface Sided { expect?: Expectation; revision?: Side }
//
// `file_contains` exists because the other three are all scoped to a symbol, and the
// claims a reviewer most wants to make about a change are often about a *file*: the
// test that covers the changed function, the caller that relies on it. The first live
// runs (2026-09-20, see AGENTS.md) showed the cost of not having it: the model reached
// for `body_contains` with `symbol: "test"` or with a file path, no declaration was
// found, the proposition went unsettled, and one unsettled proposition is enough to
// make a whole claim inconclusive. That produced a merge verdict on a real auth bypass.
export type SymbolicCheck =
  | ({ assertion: 'declaration_contains'; symbol: string; pattern: string } & Sided)
  | ({ assertion: 'body_contains'; symbol: string; pattern: string } & Sided)
  | ({ assertion: 'file_contains'; path: string; pattern: string } & Sided)
  | ({ assertion: 'referenced_outside'; symbol: string; path: string } & Sided);

// A proposition is one thing that must hold for the claim to follow, paired with the
// check that settles it. Keeping them apart was a mistake: it let a single grep hit
// stand in for a whole argument, so "the guard text is absent" could confirm "any
// account can update any record" without anyone establishing the steps between.
export interface Proposition { proposition: string; check?: SymbolicCheck }

export interface ClaimDraft {
  type: ClaimType;
  location: string;
  description: string;
  suspectedCondition: string;
  severity: Priority;
  evidenceToCheck: Proposition[];
  investigatorConfidence?: number;
}
export interface Claim extends ClaimDraft { claimId: string }

// Ordered innermost-first by convention of the scan, not by pattern precedence.
// Heuristic by design: a real parser per language is not worth its cost while the
// only requirement is that the same definition keeps the same name across a rebase.
const DEFINITIONS = [
  /^\s*(?:async\s+)?def\s+(?:self\.|[A-Z]\w*\.)?([A-Za-z_]\w*[?!]?)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|module|interface|enum|trait|struct)\s+([A-Za-z_]\w*)/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*[:=][^=]*(?:=>|function)/,
  /^\s*(?:public|private|protected|static|final|synchronized|abstract|\s)*[A-Za-z_][\w.<>\[\],\s]*\s+([A-Za-z_]\w*)\s*\([^;]*$/,
  /^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/,
];
// A statement is not a definition. Without this, `if (ready) {` anchors a claim to
// a symbol named "if", which merges unrelated claims in unrelated files onto one id.
const STATEMENTS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try',
  'with', 'case', 'elif', 'except', 'using', 'lock', 'new', 'await', 'yield', 'throw', 'assert', 'delete']);
const indentOf = (line: string): number => line.length - line.trimStart().length;

export function parseLocation(location: string): { path: string; line: number } {
  const match = /^(.+):(\d+)$/.exec(location);
  if (!match) throw new Error(`A claim location must be path:line, got ${JSON.stringify(location)}`);
  return { path: match[1]!, line: Number(match[2]) };
}

// The innermost definition enclosing this line, by scanning outward. Returns null
// at file scope, which normalizes to the path alone.
export function enclosingSymbol(source: string, line: number): string | null {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return null;
  let outermost = indentOf(lines[line - 1]!);
  for (let index = line - 1; index >= 0; index--) {
    const text = lines[index]!;
    if (!text.trim()) continue;
    const indent = indentOf(text);
    if (indent > outermost) continue;
    outermost = indent;
    if (STATEMENTS.has(/^\s*([A-Za-z_]\w*)/.exec(text)?.[1] ?? '')) continue;
    for (const pattern of DEFINITIONS) {
      const found = pattern.exec(text);
      if (found && !STATEMENTS.has(found[1]!)) return found[1]!;
    }
  }
  return null;
}

// Path plus enclosing symbol, never a raw line number: a rebase that shifts lines
// must not mint a new claim, or the regression harness cannot diff across revisions.
export function normalizeLocation(location: string, source: string | null): string {
  const { path, line } = parseLocation(location);
  const symbol = source === null ? null : enclosingSymbol(source, line);
  return symbol === null ? path : `${path}#${symbol}`;
}

export function claimId(draft: ClaimDraft, source: string | null): string {
  return `c-${hash([draft.type, normalizeLocation(draft.location, source), draft.suspectedCondition].join('\u0000')).slice(0, 12)}`;
}

const normalizeProse = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Rules 1 to 4 of spec/claim-schema.md. Rule 5 is an investigator instruction, and
// rule 2 is only partly decidable here: code can reject a restatement of the
// description, but whether a condition truly names a trigger is a judgment call.
export function claimRejection(draft: ClaimDraft, source: string | null): string | null {
  if (!CLAIM_TYPES.includes(draft.type)) return `type ${JSON.stringify(draft.type)} is outside the claim vocabulary`;
  if (!PRIORITIES.includes(draft.severity)) return `severity ${JSON.stringify(draft.severity)} is not a priority`;
  if (!draft.evidenceToCheck.length) return 'evidenceToCheck must name at least one proposition to verify';
  if (!draft.suspectedCondition.trim()) return 'suspectedCondition is empty, so the claim is not falsifiable';
  if (normalizeProse(draft.suspectedCondition) === normalizeProse(draft.description)) {
    return 'suspectedCondition restates description rather than naming a trigger';
  }
  const { line } = parseLocation(draft.location);
  if (source !== null && (line < 1 || line > source.split('\n').length)) {
    return `location line ${line} does not resolve in the reviewed revision`;
  }
  return null;
}

// Two claims colliding within one run get an appended ordinal. The first keeps the
// bare id so a single-claim run is stable against a later collision elsewhere.
export function assignClaimIds(drafts: ClaimDraft[], sourceOf: (path: string) => string | null): Claim[] {
  const seen = new Map<string, number>();
  return drafts.map(draft => {
    const base = claimId(draft, sourceOf(parseLocation(draft.location).path));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { ...draft, claimId: count ? `${base}-${count}` : base };
  });
}

// A line declares `symbol` when a definition pattern names exactly it, or when it
// binds the name directly. Used by rung 1 to find where something is actually
// defined rather than trusting whatever prefix of a file happened to be read.
export function declaresSymbol(line: string, symbol: string): boolean {
  if (STATEMENTS.has(/^\s*([A-Za-z_]\w*)/.exec(line)?.[1] ?? '')) return false;
  if (DEFINITIONS.some(pattern => pattern.exec(line)?.[1] === symbol)) return true;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.])${escaped}\\s*(?::[^=]*)?=(?!=)`).test(line);
}
