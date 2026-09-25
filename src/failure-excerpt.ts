import { TEST } from './callees.js';

// The part of a diff the failure-path pass is shown: the lines within WINDOW of each
// error-handling line (a throw, catch, rejection, raise, except or rescue) that has a
// changed line within WINDOW of it, so a change inside an existing catch counts and a
// removed guard counts. The pass re-sends its context every turn and the provider caches
// none of it (0 of 6,420 repeated tokens, 2026-09-25), so the whole diff made it 2-3x the
// cost of a review on mason-v1 #4590: 137 KB, $0.16-0.21 a run against $0.04-0.08. There
// the excerpt is 22 KB. It is empty when the change touches no error handling, and then
// the pass does not run. Test files are left out: a test's failure paths are not the
// product's. Each window gets its own hunk header, so the excerpt is still a diff.
export const FAILURE_WINDOW = 20;
const ERROR_LINE = /\b(?:throw|catch|reject|raise|rescue|except|finally|panic)\b|Error\(|\.catch\(/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function failureExcerpt(diff: string): { excerpt: string; sites: number } {
  const out: string[] = [];
  let sites = 0;
  for (const file of diff.split(/^(?=diff --git )/m)) {
    const [header = '', ...hunks] = file.split(/^(?=@@ )/m);
    const path = /^\+\+\+ b\/(.+)$/m.exec(header)?.[1];
    if (!path || TEST.test(path)) continue;
    const kept: string[] = [];
    for (const hunk of hunks) {
      const [first = '', ...body] = hunk.replace(/\n$/, '').split('\n');
      const range = HUNK.exec(first);
      if (!range) continue;
      const changed = body.flatMap((line, index) => /^[+-]/.test(line) ? [index] : []);
      const near = (index: number) => changed.some(other => Math.abs(other - index) <= FAILURE_WINDOW);
      const errors = body.flatMap((line, index) => ERROR_LINE.test(line) && near(index) ? [index] : []);
      if (!errors.length) continue;
      sites += errors.length;
      const keep = body.map((_, index) => errors.some(error => Math.abs(error - index) <= FAILURE_WINDOW));
      let oldLine = Number(range[1]), newLine = Number(range[2]);
      const step = (line: string) => {
        if (line.startsWith('\\')) return;
        if (!line.startsWith('+')) oldLine++;
        if (!line.startsWith('-')) newLine++;
      };
      for (let index = 0; index < body.length;) {
        if (!keep[index]) { step(body[index]!); index++; continue; }
        const oldStart = oldLine, newStart = newLine, chunk: string[] = [];
        while (index < body.length && keep[index]) { chunk.push(body[index]!); step(body[index]!); index++; }
        kept.push(`@@ -${oldStart},${oldLine - oldStart} +${newStart},${newLine - newStart} @@${range[3]}`, ...chunk);
      }
    }
    if (kept.length) out.push(header.replace(/\n$/, ''), ...kept);
  }
  return { excerpt: out.length ? `${out.join('\n')}\n` : '', sites };
}
