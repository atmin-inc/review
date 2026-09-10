// Exercise the actual npm archive in a fresh installation, without model or GitHub requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'atmin-package-'));
const cleanup = [];
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  run('npm', ['run', 'build']);
  const { repository, persist } = await import('../test/helpers.mjs');
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', join(root, 'artifacts')]));
  for (const entry of packed.files) {
    assert.ok(/^(dist\/.*\.(js|d\.ts)|profiles\/(smoke-openai|smoke-openrouter-free|baseline-deepseek)\.json|package\.json|README\.md|LICENSE|NOTICE|DEPENDENCIES\.md)$/.test(entry.path), `Unexpected package file: ${entry.path}`);
  }
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', temporary, join(root, 'artifacts', packed.filename)], temporary);
  const installed = join(temporary, 'node_modules/@atmin/review');
  const cli = join(installed, 'dist/cli.js');
  assert.match(run(process.execPath, [cli, '--help'], temporary), /atmin-review review/);
  assert.match(run(process.execPath, [join(installed, 'dist/github/cli.js'), '--help'], temporary), /reconcile/);
  for (const profile of ['smoke-openai', 'smoke-openrouter-free', 'baseline-deepseek']) JSON.parse(readFileSync(join(installed, 'profiles', `${profile}.json`)));
  const fixture = repository({ after: fn => cleanup.push(fn) });
  const directory = persist(fixture);
  const rendered = JSON.parse(run(process.execPath, [cli, 'render', directory, '--format', 'json'], temporary));
  assert.equal(rendered.packet.headSha, fixture.packet.headSha);
  assert.equal(rendered.assessment.outcome, 'Review incomplete');
  process.stdout.write(JSON.stringify({ tarball: join(root, 'artifacts', packed.filename), integrity: packed.integrity, files: packed.files.length, installedRender: 'passed' }) + '\n');
} finally { for (const fn of cleanup) fn(); rmSync(temporary, { recursive: true, force: true }); }
