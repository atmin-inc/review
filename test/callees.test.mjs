import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repository } from './helpers.mjs';
import { capture } from '../dist/snapshot.js';
import { revisionFrom } from '../dist/symbolic.js';
import { calledCode, MAX_CALLED_CODE_BYTES } from '../dist/callees.js';

// The change under review hands its errors to a mapper it does not touch. That mapper is
// where the defect shows (every plain error becomes "vendor unavailable, retry"), and on
// mason-v1 #4590 the model never opened it, so it has to arrive with the change.
function change(t, files) {
  const f = repository(t);
  f.run('checkout', '-q', '--detach', f.state.baseSha);
  f.write('lib/errors.ts', 'export function mapError(e) {\n  return { kind: "VendorUnavailable", retryAfterMs: 5000 };\n}\n');
  for (const [path, text] of Object.entries(files.base ?? {})) f.write(path, text);
  const baseSha = f.commit('target');
  for (const [path, text] of Object.entries(files.head)) f.write(path, text);
  const headSha = f.commit('change');
  const { packet, diff } = capture(f.source, { ...f.state, baseSha, headSha });
  return calledCode(diff.toString('utf8'), revisionFrom(f.source, packet.headSha));
}

test('an unchanged function the added lines call arrives with its body', t => {
  const { called, omitted } = change(t, { head: { 'api.ts':
    'import { mapError } from "./lib/errors";\nfunction helper(x) {\n  return x;\n}\nexport function run(rows) {\n  try { return rows.map(helper); } catch (e) { throw mapError(e); }\n}\n' } });
  assert.deepEqual(called.map(c => [c.symbol, c.path, c.line]), [['mapError', 'lib/errors.ts', 1]]);
  assert.match(called[0].text, /VendorUnavailable[\s\S]*retryAfterMs: 5000/);
  assert.deepEqual(omitted, []);
});

// A name declared twice elsewhere, and nowhere in the calling file, could be either; the
// wrong one in front of the model is worse than none.
test('an ambiguous name resolves to nothing rather than a guess', t => {
  const { called } = change(t, {
    base: { 'other/errors.ts': 'export function mapError(e) {\n  return null;\n}\n' },
    head: { 'api.ts': 'export function run(e) {\n  throw mapError(e);\n}\n' },
  });
  assert.deepEqual(called, []);
});

test('definitions past the budget are named, not silently dropped', t => {
  // Two definitions of about 60% of the budget each: the first fits, the second cannot.
  const big = name => `export function ${name}() {\n${`  const filler = "${'x'.repeat(140)}";\n`.repeat(Math.ceil(MAX_CALLED_CODE_BYTES * 0.6 / 160))}}\n`;
  const { called, omitted } = change(t, {
    base: { 'lib/first.ts': big('first'), 'lib/second.ts': big('second') },
    head: { 'api.ts': 'export function run(e) {\n  first();\n  second();\n  throw mapError(e);\n}\n' },
  });
  assert.deepEqual(omitted, ['second']);
  assert.deepEqual(called.map(c => c.symbol), ['first', 'mapError']);
});
