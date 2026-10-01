import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// `atmin` must stay a dispatcher that no tool owns (Lors, 2026-10-01): every atmin tool adds
// commands by shipping `atmin-<name>`, so this command must reach any of them unchanged.
const atmin = fileURLToPath(new URL('../packaging/atmin-cli/atmin.mjs', import.meta.url));
function bin(t, tools) {
  const directory = mkdtempSync(join(tmpdir(), 'atmin-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, script] of Object.entries(tools)) { writeFileSync(join(directory, name), script); chmodSync(join(directory, name), 0o755); }
  return { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` };
}

test('atmin runs atmin-<command> with the same arguments and exit code, and lists what is installed', t => {
  const env = bin(t, { 'atmin-demo': '#!/bin/sh\necho "args:$1|$2"; exit 3\n', 'atmin-other': '#!/bin/sh\nexit 0\n', 'not-atmin': '#!/bin/sh\n' });
  const run = spawnSync(process.execPath, [atmin, 'demo', 'a', 'b c'], { env, encoding: 'utf8' });
  assert.equal(run.stdout, 'args:a|b c\n');
  assert.equal(run.status, 3, 'the tool\'s exit code is atmin\'s');
  const help = spawnSync(process.execPath, [atmin, '--help'], { env, encoding: 'utf8' }).stdout;
  assert.match(help, /^ {2}demo$/m); assert.match(help, /^ {2}other$/m); assert.doesNotMatch(help, /not-atmin/);
});

test('an unknown or malformed command fails without running anything', t => {
  const env = bin(t, {});
  for (const command of ['missing', '../atmin-demo', 'Demo']) {
    const run = spawnSync(process.execPath, [atmin, command], { env, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /is not an installed atmin command/);
  }
});

// The review runner finishes its review on the first stop signal; a service manager stopping
// `atmin code-review-runner` must reach the runner, not just kill the wrapper.
test('a stop signal reaches the tool, and atmin waits for it to finish', async t => {
  const env = bin(t, { 'atmin-slow': '#!/bin/sh\ntrap \'echo stopping; exit 7\' TERM\necho ready\nwhile true; do sleep 0.1; done\n' });
  const child = spawn(process.execPath, [atmin, 'slow'], { env });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  while (!out.includes('ready')) await once(child.stdout, 'data');
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 7);
  assert.match(out, /stopping/);
});

// With the dispatcher, `atmin review <PR>` arrives as `atmin-review <PR>`.
test('atmin-review treats a bare pull request URL as the review command', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'https://github.com/o/r/pull/1'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /review\/investigate requires --profile/);
});
