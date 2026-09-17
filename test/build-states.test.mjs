import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, persist } from './helpers.mjs';
import { buildStates } from '../benchmarks/build-states.mjs';
import { hash } from '../dist/snapshot.js';
import { parseRepositoryState } from '../dist/repository-state.js';

const profilePath = new URL('../profiles/smoke-openai.json', import.meta.url).pathname;
const profile = JSON.parse(readFileSync(profilePath));
const action = (name, args) => ({ id: name, name, arguments: JSON.stringify(args) });
const ids = JSON.parse(readFileSync(new URL('../benchmarks/martian-development-split.json', import.meta.url))).cases.filter(c => c.split === 'development').map(c => c.id);

test('state builds retain every case outcome and stop dispatch after a provider access failure', async t => {
  const fixture = repository(t);
  const snapshot = persist(fixture);
  const source = join(fixture.root, 'previous');
  mkdirSync(join(source, 'cases'), { recursive: true });
  for (const id of ids) cpSync(snapshot, join(source, 'cases', id), { recursive: true });
  const packetHash = hash(readFileSync(join(snapshot, 'packet.json')));
  writeFileSync(join(source, 'comparison.json'), JSON.stringify({ cases: [...ids, 'case-999'].map(id => ({ id, packetHash })) }));
  let built = 0;
  const factory = async () => {
    const attempt = ++built;
    let turn = 0;
    return { closed: false, close() { this.closed = true; }, async count() { return 1000; },
      async respond() {
        const step = [action('read_file', { path: 'update.ts', startLine: 1, count: 200 }),
          action('record_section', { id: 'ownership', kind: 'contract', title: 'Ownership guard', basis: 'observed', paths: ['update.ts'], summary: 'update() checks ownership.', evidence: [{ path: 'update.ts', line: 2 }] }),
          attempt === 2 ? undefined : action('finish_state', { complete: true, limitations: [] })][turn++];
        return { model: profile.model, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0, status: step ? 'completed' : 'incomplete', continuation: [], calls: step ? [step] : [] };
      }, toolOutput: (id, value) => ({ id, value }) };
  };
  const output = join(fixture.root, 'states');
  const index = await buildStates(output, source, profilePath, factory, 1);
  assert.equal(index.cases.length, 15);
  assert.equal(index.cases.filter(c => c.status === 'complete').length, 14);
  assert.equal(index.cases.filter(c => c.status === 'partial').length, 1);
  assert.equal(index.cases[1].stopReason, 'Provider response incomplete; recorded sections preserved');
  assert.equal(index.cases[1].sections, 1);
  assert.ok(index.cases.every(c => c.accountedUsd > 0 && c.actualOutputTokens > 0 && c.stateHash === hash(readFileSync(join(output, c.id, 'repository-state.json')))));
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'states.json'), 'utf8')).cases, index.cases);
  assert.equal(parseRepositoryState(JSON.parse(readFileSync(join(output, ids[0], 'repository-state.json'), 'utf8'))).commit, fixture.packet.baseSha);
  assert.ok(existsSync(join(output, ids[0], 'repository-state.receipt.json')));
  // A failed authentication stops dispatch; remaining cases are recorded, not silently retried.
  const blocked = join(fixture.root, 'blocked');
  const denied = async () => ({ async count() { return 1000; }, async respond() { const { ProviderRequestError } = await import('../dist/provider-error.js'); throw new ProviderRequestError('inference', 401); }, toolOutput: (id, value) => ({ id, value }) });
  const stopped = await buildStates(blocked, source, profilePath, denied, 1);
  assert.equal(stopped.cases[0].status, 'partial');
  assert.match(stopped.cases[0].stopReason, /authentication/);
  assert.equal(stopped.cases.filter(c => c.status === 'dispatch-stopped').length, 14);
});
