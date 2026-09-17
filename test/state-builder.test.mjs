import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, persist, finalReport } from './helpers.mjs';
import { buildRepositoryState, stateToolDefinitions, stateAccountedUsd } from '../dist/state-builder.js';
import { runStateBuild } from '../dist/run.js';
import { investigate } from '../dist/investigation.js';
import { parseRepositoryState } from '../dist/repository-state.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/smoke-openai.json', import.meta.url)));
const action = (name, args) => ({ id: name, name, arguments: JSON.stringify(args) });
const read = (path = 'update.ts', startLine = 1, count = 200) => action('read_file', { path, startLine, count });
const section = overrides => action('record_section', { id: 'ownership', kind: 'contract', title: 'Ownership guard', basis: 'observed', paths: ['update.ts'],
  summary: 'update() rejects callers whose owner differs from the account.', evidence: [{ path: 'update.ts', line: 2 }], ...overrides });
const finish = (complete = true, limitations = []) => action('finish_state', { complete, limitations });
function model(steps) {
  let index = 0;
  const requests = [];
  return { requests, async count() { return 1000; },
    async respond(input) {
      requests.push(structuredClone(input));
      const step = steps[index++];
      return { model: profile.model, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0, status: 'completed', continuation: [], calls: Array.isArray(step) ? step : step ? [step] : [] };
    }, toolOutput: (id, value) => ({ id, value }) };
}
const identity = fixture => ({ repository: fixture.packet.repository, branch: 'main', commit: fixture.packet.baseSha });
async function build(t, steps, overrides = {}) {
  const fixture = repository(t);
  const fake = model(steps);
  const output = await buildRepositoryState(join(fixture.source, '.git'), identity(fixture), { ...profile, ...overrides }, fake);
  return { ...output, fake, fixture };
}

test('sections cite captured reads, the artifact validates, and usage is accounted', async t => {
  const { state, receipt, fake } = await build(t, [action('list_files', { contains: '', offset: 0 }), read(), section({}), finish()]);
  parseRepositoryState(state);
  assert.equal(state.complete, true);
  assert.deepEqual(state.limitations, []);
  assert.equal(state.sections.length, 1);
  assert.equal(state.generator.version, receipt.engineVersion);
  assert.equal(receipt.stopReason, 'finished');
  assert.equal(receipt.calls.length, 4);
  assert.equal(receipt.reads, 1);
  assert.ok(stateAccountedUsd(receipt) > 0);
  assert.deepEqual(receipt.toolErrors, []);
  assert.equal(JSON.parse(fake.requests[0].context).fileCount, 1);
  assert.ok(fake.requests[0].tools.every(tool => !('side' in tool.parameters.properties)));
});
test('evidence outside captured reads is rejected and a complete state needs a section', async t => {
  const { state, receipt } = await build(t, [section({}), read('update.ts', 3, 1), section({ evidence: [{ path: 'update.ts', line: 2 }] }),
    section({ evidence: [{ path: 'update.ts', line: null }] }), finish(true)]);
  assert.equal(state.sections.length, 1);
  assert.equal(state.complete, true);
  assert.equal(receipt.toolErrors.filter(e => /within ranges already returned/.test(e.reason)).length, 2);
  assert.equal(receipt.stopReason, 'finished');
  const empty = await build(t, [finish(true), finish(false, ['Nothing explored.'])]);
  assert.ok(empty.receipt.toolErrors.some(e => /at least one recorded section/.test(e.reason)));
  assert.equal(empty.state.complete, false);
});
test('a build cut short by limits still yields an honest partial artifact', async t => {
  const { state, receipt, fake } = await build(t, [read(), section({}), read(), read()], { maxTurns: 3 });
  assert.equal(receipt.stopReason, 'Model turn limit reached');
  assert.equal(state.complete, false);
  assert.deepEqual(state.limitations, ['Model turn limit reached']);
  assert.equal(state.sections.length, 1);
  assert.deepEqual(fake.requests[2].tools.map(tool => tool.name), ['finish_state']);
  assert.ok(stateToolDefinitions.length > 1);
});
test('a persisted build supplies current state to a review of the same snapshot', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const output = join(fixture.root, 'state');
  const { state } = await runStateBuild(directory, output, profile, model([read(), section({}), finish()]));
  assert.equal(state.commit, fixture.packet.baseSha);
  for (const name of ['repository-state.json', 'repository-state.receipt.json', 'trace.ndjson']) assert.ok(existsSync(join(output, name)), name);
  assert.deepEqual(parseRepositoryState(JSON.parse(readFileSync(join(output, 'repository-state.json'), 'utf8'))), state);
  cpSync(join(output, 'repository-state.json'), join(directory, 'repository-state.json'));
  const fake = model([action('read_file', { side: 'head', path: 'update.ts', startLine: 1, count: 200 }), action('read_file', { side: 'base', path: 'update.ts', startLine: 1, count: 200 }),
    action('end_investigation', { complete: true, limitations: [] }), action('finish', finalReport())]);
  const { result, receipt } = await investigate(directory, fixture.packet, profile, fake);
  assert.equal(result.status, 'completed');
  assert.deepEqual(receipt.repositoryState, { status: 'current', commit: fixture.packet.baseSha, sections: 1 });
  assert.equal(JSON.parse(fake.requests[0].context).repositoryState.sections[0].id, 'ownership');
  await assert.rejects(runStateBuild(directory, output, profile, model([])), /EEXIST/);
});
