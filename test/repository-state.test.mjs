import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { repository, persist, finding, finalReport } from './helpers.mjs';
import { investigate, toolDefinitions } from '../dist/investigation.js';
import { parseRepositoryState, selectRepositoryState, verifyStateEvidence, stateGuidance } from '../dist/repository-state.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/smoke-openai.json', import.meta.url)));
const action = (name, args) => ({ id: name, name, arguments: JSON.stringify(args) });
const read = side => action('read_file', { side, path: 'update.ts', startLine: 1, count: 200 });
const defect = () => action('record_finding', { ...finding(), evidenceIds: ['read-1'] });
const cover = (complete = true, limitations = []) => action('end_investigation', { complete, limitations });
const finish = () => action('finish', finalReport());
const withdraw = (id = 'missing-owner-guard') => action('withdraw_finding', { id, reason: 'The caller already checks ownership before calling update.' });
const section = overrides => ({ id: 'ownership', kind: 'contract', title: 'Ownership guard', basis: 'observed', paths: ['update.ts'],
  summary: 'update() must reject callers whose owner differs from the account.', evidence: [{ path: 'update.ts', line: 2 }], ...overrides });
const state = (fixture, overrides = {}) => ({ schemaVersion: 1, repository: fixture.packet.repository, branch: 'main', commit: fixture.packet.baseSha,
  generator: { name: 'test fixture', version: '1' }, createdAt: '2026-09-17T00:00:00.000Z', complete: true, limitations: [],
  sections: [section({}), section({ id: 'purpose', kind: 'purpose', paths: [], summary: 'Fixture repository.' }), section({ id: 'unrelated', kind: 'subsystem', paths: ['docs/', 'other.ts'] })], ...overrides });
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
// Fixture commits carry timestamps, so state must be derived from the run's own fixture.
async function run(t, steps, stateFor, overrides = {}) {
  const fixture = repository(t);
  const directory = persist(fixture);
  const stateFile = stateFor?.(fixture);
  if (stateFile !== undefined) writeFileSync(join(directory, 'repository-state.json'), typeof stateFile === 'string' ? stateFile : JSON.stringify(stateFile));
  const fake = model(steps);
  const output = await investigate(directory, fixture.packet, { ...profile, ...overrides }, fake);
  return { ...output, fake, fixture, directory, context: index => JSON.parse(fake.requests[index].context) };
}

test('the contract rejects malformed state and duplicate sections', async t => {
  const fixture = repository(t);
  parseRepositoryState(state(fixture));
  for (const change of [s => s.commit = 'main', s => s.sections[0].kind = 'style', s => s.sections[0].evidence = [], s => s.sections[1].id = s.sections[0].id,
    s => s.sections[0].extra = true, s => delete s.complete, s => s.sections[0].basis = 'guessed']) {
    const bad = state(fixture); change(bad);
    assert.throws(() => parseRepositoryState(bad), /Invalid repository state/);
  }
});
test('selection keeps repository-wide and path-matched sections and withholds state for another commit', async t => {
  const fixture = repository(t);
  const current = selectRepositoryState(parseRepositoryState(state(fixture)), fixture.packet);
  assert.equal(current.status, 'current');
  assert.deepEqual(current.sections.map(s => s.id), ['ownership', 'purpose']);
  assert.equal(current.guidance, stateGuidance);
  const otherCommit = selectRepositoryState(parseRepositoryState(state(fixture, { commit: fixture.packet.headSha })), fixture.packet);
  assert.equal(otherCommit.status, 'stale');
  assert.match(otherCommit.reason, /withheld/);
  assert.equal(selectRepositoryState(parseRepositoryState(state(fixture, { repository: 'other/repository' })), fixture.packet).status, 'stale');
});
test('state evidence must resolve to real lines at the state commit', async t => {
  const fixture = repository(t);
  const source = join(fixture.source, '.git');
  verifyStateEvidence(source, parseRepositoryState(state(fixture)));
  verifyStateEvidence(source, parseRepositoryState(state(fixture, { sections: [section({ evidence: [{ path: 'update.ts', line: null }] })] })));
  assert.throws(() => verifyStateEvidence(source, parseRepositoryState(state(fixture, { sections: [section({ evidence: [{ path: 'missing.ts', line: 1 }] })] }))), /missing path/);
  assert.throws(() => verifyStateEvidence(source, parseRepositoryState(state(fixture, { sections: [section({ evidence: [{ path: 'update.ts', line: 5 }] })] }))), /outside its file/);
});
test('current state enters the frozen context as guidance only and absent state leaves the context unchanged', async t => {
  const withState = await run(t, [read('head'), read('base'), cover(), finish()], state);
  const supplied = withState.context(0).repositoryState;
  assert.equal(supplied.status, 'current');
  assert.deepEqual(supplied.sections.map(s => s.id), ['ownership', 'purpose']);
  assert.equal(supplied.guidance, stateGuidance);
  assert.deepEqual(withState.receipt.repositoryState, { status: 'current', commit: withState.fixture.packet.baseSha, sections: 2 });
  assert.equal(withState.result.status, 'completed');
  assert.ok(!withState.result.limitations.some(l => /Repository state/.test(l)));
  const without = await run(t, [read('head'), read('base'), cover(), finish()]);
  assert.ok(!('repositoryState' in without.context(0)));
  assert.equal(without.receipt.repositoryState, null);
  assert.notEqual(withState.receipt.contextHash, without.receipt.contextHash);
  // Findings still need captured reads; a state section is never finding evidence.
  const cited = await run(t, [read('head'), action('record_finding', { ...finding(), evidenceIds: ['ownership'] }), read('base'), cover(), finish()], state);
  assert.equal(cited.result.findings.length, 0);
  assert.ok(cited.receipt.toolErrors.some(e => /captured source/.test(e.reason)));
});
test('state for another commit is withheld with a recorded limitation instead of substituted', async t => {
  const { result, receipt, context } = await run(t, [read('head'), read('base'), cover(), finish()], fixture => state(fixture, { commit: fixture.packet.headSha }));
  assert.equal(context(0).repositoryState.status, 'stale');
  assert.equal(context(0).repositoryState.sections, undefined);
  assert.equal(receipt.repositoryState.status, 'stale');
  assert.ok(result.limitations.some(l => /withheld/.test(l)));
  assert.equal(result.status, 'completed');
});
test('invalid or unverifiable state fails closed before any model request', async t => {
  const invalid = await run(t, [finish()], () => '{"schemaVersion":2}');
  assert.equal(invalid.fake.requests.length, 0);
  assert.equal(invalid.result.status, 'partial');
  assert.match(invalid.receipt.stopReason, /^Invalid repository state/);
  const unverifiable = await run(t, [finish()], fixture => state(fixture, { sections: [section({ evidence: [{ path: 'missing.ts', line: 1 }] })] }));
  assert.equal(unverifiable.fake.requests.length, 0);
  assert.match(unverifiable.receipt.stopReason, /^Repository state section ownership cites a missing path/);
});
test('a recorded finding can be withdrawn with retained counterevidence, in discovery or assessment', async t => {
  const discovery = await run(t, [read('head'), defect(), withdraw(), read('base'), cover(), finish()]);
  assert.equal(discovery.result.status, 'completed');
  assert.deepEqual(discovery.result.findings, []);
  assert.equal(discovery.receipt.withdrawals.length, 1);
  assert.equal(discovery.receipt.withdrawals[0].priority, 'P1');
  assert.match(discovery.receipt.withdrawals[0].reason, /already checks ownership/);
  assert.deepEqual(discovery.receipt.toolErrors, []);
  const assessment = await run(t, [read('head'), defect(), read('base'), cover(), withdraw(), finish()]);
  assert.deepEqual(assessment.result.findings, []);
  assert.equal(assessment.receipt.withdrawals.length, 1);
  assert.ok(assessment.fake.requests[4].tools.some(tool => tool.name === 'withdraw_finding'));
  const unknown = await run(t, [read('head'), withdraw('never-recorded'), read('base'), cover(), finish()]);
  assert.deepEqual(unknown.receipt.withdrawals, []);
  assert.ok(unknown.receipt.toolErrors.some(e => /No recorded finding/.test(e.reason)));
  assert.ok(toolDefinitions.some(tool => tool.name === 'withdraw_finding'));
});
test('withdrawal is unavailable once reporting starts, so a final response cannot silently drop findings', async t => {
  // Six responses: the fifth is the first reporting-only response.
  const { result, receipt, fake } = await run(t, [read('head'), defect(), read('base'), cover(), [withdraw(), finish()], finish()], undefined, { maxTurns: 6 });
  assert.deepEqual(fake.requests[4].tools.map(tool => tool.name), ['finish']);
  assert.ok(receipt.toolErrors.some(e => /unavailable tool/.test(e.reason)));
  assert.equal(result.findings.length, 1);
  assert.deepEqual(receipt.withdrawals, []);
});
test('the hand-authored example state parses and its evidence resolves at its commit', async t => {
  const example = parseRepositoryState(JSON.parse(readFileSync(new URL('../docs/repository-state-example.json', import.meta.url), 'utf8')));
  assert.equal(example.repository, 'atmin-inc/review');
  assert.equal(example.complete, false);
  const source = join(process.cwd(), '.git');
  try { execFileSync('git', ['-C', process.cwd(), 'cat-file', '-e', `${example.commit}^{commit}`], { stdio: 'ignore' }); }
  catch { t.skip(`commit ${example.commit} is not in this checkout; evidence not verified`); return; }
  verifyStateEvidence(source, example);
  assert.throws(() => verifyStateEvidence(source, { ...example, sections: [{ ...example.sections[0], evidence: [{ path: 'README.md', line: 100000 }] }] }), /outside its file/);
});
