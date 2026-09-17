import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

test('symlinked benchmark entrypoints run instead of silently succeeding', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'atmin-benchmark-entrypoint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['paired-review', 'paired-summary', 'prepare-paired-review',
    'martian-compare', 'martian-summary', 'repeat-suite', 'summarize-suite']) {
    const link = join(directory, `${name}.mjs`);
    symlinkSync(fileURLToPath(new URL(`../benchmarks/${name}.mjs`, import.meta.url)), link);
    // Invalid input must reach the CLI's validation, before any model invocation.
    await assert.rejects(exec(process.execPath, [link, join(directory, 'missing')]), error => {
      assert.match(error.stderr, /Usage:|ENOENT/);
      return true;
    }, name);
  }
});
