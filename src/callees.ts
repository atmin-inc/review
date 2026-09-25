import { declaresSymbol } from './claim.js';
import { definitionOf, type Revision } from './symbolic.js';

// The definitions, at head, of functions the added lines call and the change does not
// define. A change can be right on its own lines and wrong in what unchanged code does
// with its values: on mason-v1 #4590 (2026-09-24) new code threw plain errors into a
// catch-all mapper 780 lines away that labels every one "vendor unavailable, retry", and
// in seven runs the model never opened that file. Resolved by code, not left to the model
// to go looking. Calls are taken by name or on `this`/`self` only: `x.map(` names a method
// of a value nothing here can type, and a guess would put unrelated code in front of it.
// A definition that does not fit is named, never silently dropped.
export const MAX_CALLED_CODE_BYTES = 24 * 1024;
export interface CalledCode { symbol: string; path: string; line: number; text: string; capped: boolean }

const CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await',
  'super', 'import', 'require', 'def', 'elif', 'not', 'and', 'or', 'in', 'lambda', 'assert', 'print', 'with']);
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
export const TEST = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$/;

// Added lines per file, from a unified diff. A deleted file has no head side to call from.
function addedLines(diff: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let path: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { path = line.startsWith('+++ b/') ? line.slice(6) : null; continue; }
    if (line.startsWith('diff --git ')) { path = null; continue; }
    if (path && line.startsWith('+')) added.set(path, [...(added.get(path) ?? []), line.slice(1)]);
  }
  return added;
}

export function calledCode(diff: string, head: Revision): { called: CalledCode[]; omitted: string[] } {
  const added = addedLines(diff);
  const addedText = [...added.values()].flat();
  // name -> the first changed file that calls it, which is where resolution looks first.
  const calls = new Map<string, string>();
  for (const [path, lines] of added) {
    if (!SOURCE.test(path) || TEST.test(path)) continue;
    for (const line of lines) {
      for (const match of line.matchAll(CALL)) {
        const before = line.slice(0, match.index);
        if (/\.\s*$/.test(before) && !/\b(?:this|self)\.\s*$/.test(before)) continue;
        const name = match[1]!;
        if (!NOT_CALLS.has(name) && !calls.has(name)) calls.set(name, path);
      }
    }
  }
  const called: CalledCode[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const [symbol, from] of calls) {
    // Defined by the change itself: the model already has it in the diff.
    if (addedText.some(line => declaresSymbol(line, symbol))) continue;
    const definition = definitionOf(head, symbol, from, path => SOURCE.test(path) && !TEST.test(path));
    if (!definition) continue;
    const size = Buffer.byteLength(definition.text);
    if (bytes + size > MAX_CALLED_CODE_BYTES) { omitted.push(symbol); continue; }
    bytes += size;
    called.push({ symbol, ...definition });
  }
  return { called, omitted };
}
