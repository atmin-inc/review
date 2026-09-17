import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtures } from '../benchmarks/contract-fixtures.mjs';

test('each contract oracle passes its base and corrected change and fails the introduced bug', t => {
  for (const fixture of fixtures) for (const variant of ['base', 'bug', 'clean']) {
    const directory = mkdtempSync(join(tmpdir(), 'atmin-contract-oracle-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [path, content] of Object.entries({ ...fixture.base, ...(variant === 'base' ? {} : fixture[variant]) })) writeFileSync(join(directory, path), content);
    writeFileSync(join(directory, 'oracle.mjs'), fixture.oracle);
    const result = spawnSync(process.execPath, ['oracle.mjs'], { cwd: directory, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, variant === 'bug' ? 1 : 0, `${fixture.id}/${variant}: ${result.stderr}`);
    if (variant === 'bug') assert.match(result.stderr, /AssertionError/);
  }
});
