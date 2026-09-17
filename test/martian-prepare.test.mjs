import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { repository } from './helpers.mjs';
import { git } from '../dist/snapshot.js';
import { projectTrees } from '../benchmarks/martian-prepare.mjs';
import { sourceShell } from '../benchmarks/source-shell.mjs';
import { validatePlan } from '../benchmarks/martian-compare.mjs';
import { providerLimited } from '../benchmarks/plain-codex.mjs';
import { summarizeComparison } from '../benchmarks/martian-summary.mjs';

test('successful turns and diagnostic IDs cannot trigger rate-limit dispatch stops', () => {
  assert.equal(providerLimited(true, 'HTTP 429'), false);
  assert.equal(providerLimited(false, 'cache thread=abc429def'), false);
  assert.equal(providerLimited(false, 'HTTP 429 Too Many Requests'), true);
  assert.equal(providerLimited(false, 'You have reached your usage limit'), true);
});

test('comparison rejects duplicate arms and escaping case paths before dispatch', () => {
  const cases = Array.from({ length: 15 }, (_, i) => ({ id: `case-${i}` }));
  const plan = { kind: 'frozen-martian-paired-comparison', cases,
    trials: cases.flatMap(c => ['atmin-r02-24', 'plain-codex'].map(arm => ({ id: `${c.id}-${arm}`, caseId: c.id, arm }))) };
  validatePlan(plan);
  const repeated = structuredClone(plan);
  repeated.trials[1].arm = 'atmin-r02-24';
  assert.throws(() => validatePlan(repeated), /one trial per arm/);
  const escaped = structuredClone(plan);
  escaped.cases[0].id = '../outside';
  assert.throws(() => validatePlan(escaped), /distinct paired cases/);
});

test('comparison summary cannot publish an unfinished experiment', t => {
  const f = repository(t);
  const cases = Array.from({ length: 15 }, (_, i) => ({ id: `case-${i}` }));
  const manifest = { kind: 'frozen-martian-paired-comparison', cases,
    trials: cases.flatMap(c => ['atmin-r02-24', 'plain-codex'].map(arm => ({ id: `${c.id}-${arm}`, caseId: c.id, arm }))) };
  for (const [name, value] of Object.entries({ 'comparison.json': manifest,
    'comparison-result.json': { finishedAt: null }, 'grading.json': { final: false }, 'judge-cost.json': {} })) {
    writeFileSync(join(f.root, name), JSON.stringify(value));
  }
  assert.throws(() => summarizeComparison(f.root), /incomplete/);
});

test('comparison preserves source trees and diff without original history or future fixes', async t => {
  const f = repository(t);
  f.write('future-answer.txt', 'future solution');
  const future = f.commit('secret future solution');
  const projected = join(f.root, 'projected.git');
  const result = await projectTrees(f.source, projected, f.state.baseSha, f.state.headSha);
  const run = (...args) => git(projected, args).toString().trim();
  assert.equal(run('rev-parse', 'head^{tree}'), f.run('rev-parse', `${f.state.headSha}^{tree}`));
  assert.equal(run('rev-parse', 'target^{tree}'), f.run('rev-parse', `${f.state.baseSha}^{tree}`));
  assert.equal(run('diff', 'comparison-base', 'head'), f.run('diff', f.state.baseSha, f.state.headSha));
  assert.deepEqual(run('log', '--all', '--format=%s').split('\n').sort(), ['Comparison base', 'Proposed change']);
  for (const sha of [future, f.state.headSha, f.state.baseSha]) assert.throws(() => run('cat-file', '-e', sha));
  assert.equal(result.originalMergeBaseSha, f.state.baseSha);
});

test('source shell reads the repository but denies adjacent files, symlinks, writes and networking', { skip: process.platform !== 'darwin' }, async t => {
  const f = repository(t);
  const outside = join(f.root, 'outside.txt');
  writeFileSync(outside, 'outside-marker');
  symlinkSync(outside, join(f.source, 'outside-link'));
  const run = sourceShell(f.source);
  assert.match((await run('git diff HEAD~1 HEAD; rg updated update.ts')).output, /updated/);
  for (const command of [`cat '${outside}'`, 'cat outside-link', 'echo changed > update.ts', 'curl --max-time 2 -I https://example.com']) {
    const result = await run(command);
    assert.notEqual(result.exitCode, 0, command);
    assert.doesNotMatch(result.output, /outside-marker/);
  }
  assert.match(readFileSync(join(f.source, 'update.ts'), 'utf8'), /export function/);
});
