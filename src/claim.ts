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
// `revision` is part of the question, not decoration on the check. The reviewer's whole
// subject is a difference between two revisions, so "the body lacks `account.ownerId`" is
// true at head and false at base and means nothing unqualified. Measured 2026-09-20: rung
// 1 ran that check at head and missed, correctly; rung 3 was handed the bare sentence
// along with a state carrying both sides and the diff, answered for the other side, and
// `suspectChecks` held back a correct `auth_bypass`. Neither rung was wrong. They were
// answering different questions.
//
// So the side is resolved once, by `propositionSide`, and every rung is asked at that
// same value. The check may still name a side — a claim about a regression genuinely
// needs one proposition at base and one at head — and when it does, it wins, because it
// is what rung 1 actually ran against. Absent both, head: the state after the change is
// what a review is about.
export interface Proposition { proposition: string; revision?: Side; check?: SymbolicCheck }
export const propositionSide = (item: Proposition): Side =>
  item.check?.revision ?? item.revision ?? 'head';

// What the code at the location should have carried instead: one literal line or
// fragment, and optionally a path where that text already appears, when the location
// departs from a convention its siblings or its contract follow. Measured 2026-09-21
// over 60 runs, this corrective form is the one property that separates the findings
// matching a human comment from the noise, and it is rare because nothing asked for it.
// Asked for in the prompt alone (2026-09-22) it appeared 0 times; here it is a field the
// code checks, so a claim with no departure to name cannot be recorded.
export interface Correction { text: string; seenAt?: string }
export interface ClaimDraft {
  type: ClaimType;
  location: string;
  description: string;
  suspectedCondition: string;
  severity: Priority;
  evidenceToCheck: Proposition[];
  shouldBe?: Correction;
  investigatorConfidence?: number;
}
// The slice of a revision the correction check needs, so this module stays free of the
// symbolic layer that imports it.
export interface CorrectionLookup { search(query: string, within?: string): { matches: unknown[] } }
export interface RejectionOptions { requireCorrection?: boolean; head?: CorrectionLookup }
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

// Every type in CLAIM_TYPES is a statement about how code behaves, and a document does
// not behave. Without this, a run over a documentation-only change emits claims about
// prose — a stale commit hash, an unreproducible test count, undefined jargon — typed
// `error_handling_gap` or `contract_break` because those are the only words on offer.
// Their propositions are true statements about the text, so verification establishes
// them and they reach high confidence. Measured on 2026-09-20 against PR #4, a docs-only
// change: one run in five emitted 9 such claims and confirmed 6 of them.
//
// The answer is not a documentation type. That would invite the model to produce more of
// exactly this and let the reviewer score itself on prose. It is that this vocabulary
// does not reach documents, so a claim located in one is malformed. Data and config
// files are deliberately absent from this list: a defect in a CI workflow or a JSON
// schema is a real defect these types can describe.
const PROSE = /\.(md|markdown|mdx|rst|adoc|asciidoc|txt|text)$/i;

// Rules 1 to 4 of spec/claim-schema.md. Rule 5 is an investigator instruction, and
// rule 2 is only partly decidable here: code can reject a restatement of the
// description, but whether a condition truly names a trigger is a judgment call.
export function claimRejection(draft: ClaimDraft, source: string | null, options: RejectionOptions = {}): string | null {
  if (!CLAIM_TYPES.includes(draft.type)) return `type ${JSON.stringify(draft.type)} is outside the claim vocabulary`;
  if (options.requireCorrection && !draft.shouldBe) {
    return 'shouldBe is required: name the text the code at this location should have carried instead. A consequence is not a defect until you can name the departure';
  }
  if (!PRIORITIES.includes(draft.severity)) return `severity ${JSON.stringify(draft.severity)} is not a priority`;
  if (!draft.evidenceToCheck.length) return 'evidenceToCheck must name at least one proposition to verify';
  if (!draft.suspectedCondition.trim()) return 'suspectedCondition is empty, so the claim is not falsifiable';
  if (normalizeProse(draft.suspectedCondition) === normalizeProse(draft.description)) {
    return 'suspectedCondition restates description rather than naming a trigger';
  }
  const { path, line } = parseLocation(draft.location);
  if (PROSE.test(path)) {
    return `${draft.type} is a claim about how code behaves, and ${path} is prose; this vocabulary does not describe documents`;
  }
  if (source !== null && (line < 1 || line > source.split('\n').length)) {
    return `location line ${line} does not resolve in the reviewed revision`;
  }
  if (draft.shouldBe) {
    const { text, seenAt } = draft.shouldBe;
    if (!searchable(text)) return 'shouldBe.text must be one literal line of at most 200 characters, as it would appear in the file';
    if (source !== null && (source.split('\n')[line - 1] ?? '').includes(text.trim())) {
      return 'shouldBe.text already appears on the location line, so it names nothing to change';
    }
    if (seenAt !== undefined && options.head) {
      const there = parseLocation(seenAt.includes(':') ? seenAt : `${seenAt}:1`).path;
      if (!options.head.search(text, there).matches.length) {
        return `shouldBe.seenAt names ${there}, and that file does not contain shouldBe.text at head; a convention the code departs from has to exist somewhere you can name`;
      }
    }
  }
  // Rung 1 searches for a single literal line of at most 200 characters, so a longer or
  // multi-line pattern names a check that cannot be run. Measured 2026-09-21 on Martian
  // case-016: the model wrote a reasonable multi-line pattern, the claim was accepted,
  // and the search threw during verification and took the whole review with it — three
  // runs out of three, after the pilot had recorded that case as a clean merge.
  for (const { check } of draft.evidenceToCheck) {
    for (const [field, value] of [['pattern', check && 'pattern' in check ? check.pattern : null],
      ['symbol', check && 'symbol' in check ? check.symbol : null]] as const) {
      if (typeof value !== 'string' || searchable(value)) continue;
      return /[\r\n]/.test(value)
        ? `a check ${field} must be a single line, and this one spans several; search for one distinctive line instead`
        : `a check ${field} must be at most ${SEARCH_LIMIT} characters, and this one is ${value.length}; search for a shorter distinctive fragment`;
    }
  }
  return null;
}
// What `search` in src/snapshot.ts accepts, restated where claims are judged so the two
// cannot drift apart.
export const SEARCH_LIMIT = 200;
export const searchable = (value: string): boolean =>
  value.length > 0 && value.length <= SEARCH_LIMIT && !/[\0\r\n]/.test(value);

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
