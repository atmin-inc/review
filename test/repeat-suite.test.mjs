import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSuite } from '../benchmarks/repeat-suite.mjs';
import { repository, persist, finalReport } from './helpers.mjs';
import { hash } from '../dist/snapshot.js';

function suite(t) {
  const fixture = repository(t), snapshot = persist(fixture), directory = join(fixture.root, 'suite');
  mkdirSync(join(directory, 'cases'), { recursive: true });
  cpSync(snapshot, join(directory, 'cases', 'fixture'), { recursive: true });
  const profile = readFileSync(new URL('../profiles/completion-codex-local.json', import.meta.url));
  writeFileSync(join(directory, 'profile.json'), profile);
  writeFileSync(join(directory, 'suite.json'), JSON.stringify({ kind: 'frozen-local-repeat-suite', profile: 'profile.json',
    files: { 'profile.json': hash(profile) }, cases: [{ id: 'fixture', packetHash: hash(readFileSync(join(snapshot, 'packet.json'))), diffHash: fixture.packet.diffHash }],
    trials: [{ id: 'fixture-1', caseId: 'fixture' }, { id: 'fixture-2', caseId: 'fixture' }] }));
  return directory;
}

test('repeat suites retain completed and failed trials with identical frozen packets', async t => {
  const directory = suite(t); let trials = 0;
  const output = await runSuite(directory, async profile => {
    const fail = ++trials === 2; let step = 0;
    return { async count() { return 1000; }, async respond() {
      if (fail) throw new Error('simulated unavailable provider');
      const calls = step++ === 0 ? ['base', 'head'].map(side => ({ id: side, name: 'read_file', arguments: JSON.stringify({ path: 'update.ts', side, startLine: 1, count: 200 }) }))
        : step === 2 ? [{ id: 'end', name: 'end_investigation', arguments: JSON.stringify({ complete: true, limitations: [] }) }]
        : [{ id: 'finish', name: 'finish', arguments: JSON.stringify(finalReport()) }];
      return { model: profile.model, status: 'completed', inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, continuation: [], calls };
    }, toolOutput(id, value) { return { id, value }; } };
  });
  assert.deepEqual(output.trials.map(trial => trial.status), ['completed', 'partial']);
  assert.equal(output.trials[1].unsettledCalls, 1);
  assert.equal(output.trials[1].actualInputTokens, 0);
  assert.equal(output.trials[0].reviewedFiles, 1);
  assert.deepEqual(readFileSync(join(directory, 'trials/fixture-1/packet.json')), readFileSync(join(directory, 'trials/fixture-2/packet.json')));
  await assert.rejects(runSuite(directory, async () => { throw new Error('must not dispatch'); }), /EEXIST/);
});

test('changed frozen files fail before dispatch; startup errors leave remaining trials unattempted', async t => {
  const modified = suite(t);
  writeFileSync(join(modified, 'profile.json'), '{}');
  await assert.rejects(runSuite(modified, async () => { throw new Error('must not dispatch'); }), /Frozen suite file changed/);
  const directory = suite(t);
  const output = await runSuite(directory, async () => { throw new Error('private auth error'); });
  assert.deepEqual(output.trials.map(trial => trial.status), ['infrastructure-error', 'unattempted']);
  assert.equal(JSON.stringify(output).includes('private auth error'), false);
});
