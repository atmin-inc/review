import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { git, hash, loadReview } from './snapshot.js';
import type { Packet, Finding } from './contracts.js';
import type { ValidationCheck } from './assessment.js';

export interface LocalCheck { repositoryId: number; name: string; argv: string[]; }
export interface Verification {
  schemaVersion: 1; headSha: string; baseSha: string;
  checks: ValidationCheck[];
  fixes: { findingId: string; digest: string; checks: ValidationCheck[] }[];
}
const fixDigest = (f: Finding) => hash(JSON.stringify({ path: f.anchor.path, fix: f.fix }));

// Empty filesystem by default: only runtime files and this immutable checkout
// are mounted. No host home, credentials, Git metadata, network or writable repo.
export function sandboxArguments(workspace: string, argv: string[], runtime = process.execPath): string[] {
  const root = dirname(dirname(runtime));
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    ...(root === '/usr' ? [] : ['--ro-bind', root, root]),
    '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp',
    '--ro-bind', workspace, '/workspace', '--chdir', '/workspace', '--clearenv',
    '--setenv', 'PATH', `${dirname(runtime)}:/usr/bin:/bin`, '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8', '--', ...(argv[0] === 'node' ? [runtime, ...argv.slice(1)] : argv)];
}
export function sandboxCheck(workspace: string, check: LocalCheck, signal: AbortSignal, timeoutMs = 30_000): Promise<ValidationCheck> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ name: check.name, status: 'not-run', reason: 'Isolated check cancelled before starting.' }); return; }
    const proc = spawn('bwrap', sandboxArguments(workspace, check.argv), {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let bytes = 0, stopped = false;
    const stop = () => { stopped = true; try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { /* Already exited. */ } };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    const consume = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) stop(); };
    proc.stdout.on('data', consume); proc.stderr.on('data', consume);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    proc.once('error', () => { cleanup(); resolve({ name: check.name, status: 'not-run', reason: 'Isolated worker could not start. No execution pass is claimed.' }); });
    proc.once('close', code => {
      cleanup();
      resolve({ name: check.name, status: !stopped && code === 0 ? 'pass' : 'fail',
        reason: stopped ? 'Isolated check exceeded its time/output limit or was cancelled.'
          : `Operator-configured check ${code === 0 ? 'passed' : `exited with status ${code ?? 'unknown'}`} in a read-only checkout with networking disabled.` });
    });
  });
}
function checkout(repository: string, head: string, workspace: string): void {
  const entries = git(repository, ['ls-tree', '-rz', head]).toString('utf8').split('\0').filter(Boolean);
  if (entries.length > 2000) throw new Error('Isolated checkout exceeds 2,000 files');
  let bytes = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Isolated checks currently require regular files; symlinks and submodules are unsupported');
    const [, mode, object, path] = match;
    const target = resolve(workspace, path!);
    if (!target.startsWith(workspace + '/') || path!.split('/').some(p => p === '.git' || p === '..')) throw new Error('Invalid checkout path');
    const content = git(repository, ['cat-file', 'blob', object!]);
    bytes += content.length;
    if (bytes > 20 * 1024 * 1024) throw new Error('Isolated checkout exceeds 20 MiB');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: mode === '100755' ? 0o700 : 0o600, flag: 'wx' });
  }
}
export async function verifyReview(directory: string, checks: LocalCheck[], signal: AbortSignal): Promise<Verification> {
  const { packet, result } = loadReview(directory);
  const report: Verification = { schemaVersion: 1, headSha: packet.headSha, baseSha: packet.baseSha, checks: [], fixes: [] };
  const workspace = mkdtempSync(join(directory, 'check-workspace-'));
  const run = async () => {
    const results: ValidationCheck[] = [];
    for (const check of checks) results.push(await sandboxCheck(workspace, check, signal));
    return results;
  };
  try {
    if (process.platform !== 'linux') throw new Error('Isolated worker requires Linux');
    checkout(join(directory, 'source.git'), packet.headSha, workspace);
    report.checks = await run();
    // ponytail: at most three independent patches; combined/multi-file fixes need a separate plan.
    for (const finding of result.findings.filter(f => f.fix).slice(0, 3)) {
      if (signal.aborted) break;
      const fix = finding.fix!, path = join(workspace, finding.anchor.path), original = readFileSync(path, 'utf8');
      const lines = original.split('\n');
      lines.splice(fix.startLine - 1, fix.endLine - fix.startLine + 1, ...(fix.replacement === '' ? [] : fix.replacement.split('\n')));
      writeFileSync(path, lines.join('\n'));
      try { report.fixes.push({ findingId: finding.id, digest: fixDigest(finding), checks: await run() }); }
      finally { writeFileSync(path, original); }
    }
  } catch {
    report.checks = checks.map(check => ({ name: check.name, status: 'not-run', reason: 'The isolated worker could not verify this snapshot. No execution pass is claimed.' }));
    report.fixes = [];
  } finally { rmSync(workspace, { recursive: true, force: true }); }
  writeFileSync(join(directory, 'verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
// This file is written by the credential-free controller child, never by the model
// or repository process. Bind observations to commits and the exact proposed patch.
export function readVerification(directory: string, packet: Packet, findings: Finding[]): Verification {
  const empty: Verification = { schemaVersion: 1, headSha: packet.headSha, baseSha: packet.baseSha, checks: [], fixes: [] };
  const path = join(directory, 'verification.json');
  if (!existsSync(path)) return empty;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 64 * 1024) return empty;
    const value = JSON.parse(bytes.toString()) as Verification;
    const valid = (checks: ValidationCheck[]) => Array.isArray(checks) && checks.length <= 5
      && new Set(checks.map(c => c.name)).size === checks.length
      && checks.every(c => c && typeof c.name === 'string' && typeof c.reason === 'string' && ['pass', 'fail', 'not-run'].includes(c.status));
    if (value.schemaVersion !== 1 || value.headSha !== packet.headSha || value.baseSha !== packet.baseSha || !valid(value.checks)
      || !Array.isArray(value.fixes) || value.fixes.length > 3) return empty;
    return { ...value, fixes: value.fixes.filter(f => valid(f.checks)
      && findings.some(finding => finding.fix && finding.id === f.findingId && fixDigest(finding) === f.digest)) };
  } catch { return empty; }
}
