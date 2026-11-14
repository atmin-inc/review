import { declaresSymbol } from './claim.js';
import { definitionOf, type Revision } from './symbolic.js';

// The definitions, at head, of functions the added lines call and the change does not
// define. A change can be right on its own lines and wrong in what unchanged code does
// with its values, such as new code throwing plain errors into a distant catch-all handler
// that reports every one as a retryable outage. A model left to find that handler often
// never opens its file, so the definitions are resolved by code. Calls are taken by name
// or on `this`/`self` only: `x.map(` names a method
// of a value nothing here can type, and a guess would put unrelated code in front of it.
// A definition that does not fit is named, never silently dropped.
export const MAX_CALLED_CODE_BYTES = 24 * 1024;
export interface CalledCode { symbol: string; path: string; line: number; text: string; capped: boolean }

const CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await',
  'super', 'import', 'require', 'def', 'elif', 'not', 'and', 'or', 'in', 'lambda', 'assert', 'print', 'with']);
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
// Vendored and minified code is someone else's, copied in: its calls are not the change's, and
// a vendored bundle names thousands of short symbols, each a repository search, which took a
// review past its deadline before the model was ever asked.
export const VENDORED = /(?:^|\/)(?:vendor|vendored|third_party|node_modules)\/|\.min\.[cm]?js$/;
export const TEST = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$/;

// Added lines per file, from a unified diff. A deleted file has no head side to call from.
function addedLines(diff: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let path: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { path = line.startsWith('+++ b/') ? line.slice(6) : null; continue; }
    if (line.startsWith('diff --git ')) { path = null; continue; }
    if (!path || !line.startsWith('+')) continue;
    const lines = added.get(path);
    if (lines) lines.push(line.slice(1)); else added.set(path, [line.slice(1)]);
  }
  return added;
}

export function calledCode(diff: string, head: Revision): { called: CalledCode[]; omitted: string[] } {
  const added = addedLines(diff);
  const addedText = [...added.values()].flat();
  // Which added lines hold each word, so a symbol is tested only against lines it occurs in.
  // A declaration names its symbol as a whole word (see declaresSymbol), so the word is a
  // bound on where it can be; a name with `$` is not one word and is tested on every line.
  // Testing every symbol on every line took minutes on a large vendored diff.
  const linesWith = new Map<string, Set<number>>();
  addedText.forEach((line, index) => {
    for (const [word] of line.matchAll(/\w+/g)) {
      const at = linesWith.get(word);
      if (at) at.add(index); else linesWith.set(word, new Set([index]));
    }
  });
  const declared = (symbol: string) => symbol.includes('$')
    ? addedText.some(line => declaresSymbol(line, symbol))
    : [...linesWith.get(symbol) ?? []].some(index => declaresSymbol(addedText[index]!, symbol));
  // name -> the first changed file that calls it, which is where resolution looks first.
  const calls = new Map<string, string>();
  for (const [path, lines] of added) {
    if (!SOURCE.test(path) || TEST.test(path) || VENDORED.test(path)) continue;
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
    if (declared(symbol)) continue;
    const definition = definitionOf(head, symbol, from, path => SOURCE.test(path) && !TEST.test(path));
    if (!definition) continue;
    const size = Buffer.byteLength(definition.text);
    if (bytes + size > MAX_CALLED_CODE_BYTES) { omitted.push(symbol); continue; }
    bytes += size;
    called.push({ symbol, ...definition });
  }
  return { called, omitted };
}
