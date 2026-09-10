import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { capture, git, hash, loadReview } from '../dist/snapshot.js';
import { initialResult } from '../dist/contracts.js';
import { accountedUsd } from '../dist/investigation.js';
import { readProfile, runReview } from '../dist/run.js';
import { assess } from '../dist/assessment.js';
import { renderMarkdown } from '../dist/render.js';
import { fixtures } from './smoke-fixtures.mjs';

const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
function oracle(root, fixture, content, goBinary) {
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, fixture.path), content);
  writeFileSync(join(root, fixture.oraclePath), fixture.oracle);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    GO111MODULE: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off' };
  const command = fixture.language === 'typescript' ? process.execPath : fixture.language === 'python' ? 'python3' : goBinary;
  const args = fixture.language === 'go' ? ['test', '-count=1', '.'] : [fixture.oraclePath];
  try {
    execFileSync(command, args, { cwd: root, env, timeout: 60000, maxBuffer: 100000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 'pass' };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (error.status !== 0 && output.includes('ORACLE_VIOLATION:')) return { status: 'defect-reproduced' };
    throw new Error(`Owned ${fixture.language} oracle could not run; check its local runtime (not counted as a reproduced bug).`);
  }
}
export function prepareSmoke(directory, goBinary = 'go') {
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, 'cases')); mkdirSync(join(directory, 'oracles'));
  const cases = [];
  for (const fixture of fixtures) for (const variant of ['bug', 'clean']) {
    const id = randomUUID(); // No expected label or semantic issue ID in the model's repository identity.
    const root = join(directory, 'cases', id);
    mkdirSync(root); mkdirSync(join(root, 'work'));
    const work = join(root, 'work');
    const run = (...args) => git(work, args).toString('utf8').trim();
    run('init', '--initial-branch=main', '--template=');
    run('config', 'user.name', 'Fixture'); run('config', 'user.email', 'fixture@example.invalid');
    run('config', 'commit.gpgsign', 'false');
    writeFileSync(join(work, fixture.path), fixture.base);
    run('add', '-A'); run('commit', '-qm', 'Initial implementation');
    const baseSha = run('rev-parse', 'HEAD');
    writeFileSync(join(work, fixture.path), fixture[variant]);
    run('add', '-A'); run('commit', '-qm', 'Update implementation');
    const headSha = run('rev-parse', 'HEAD');
    const { packet, diff } = capture(work, { repository: 'fixture/source', pr: 1, baseRef: 'main', baseSha, headSha, state: 'open' });
    const snapshot = join(root, 'review'); mkdirSync(snapshot, { mode: 0o700 });
    cpSync(join(work, '.git'), join(snapshot, 'source.git'), { recursive: true });
    git(join(snapshot, 'source.git'), ['config', 'core.bare', 'true']);
    save(join(snapshot, 'packet.json'), packet); save(join(snapshot, 'result.json'), initialResult(packet));
    writeFileSync(join(snapshot, 'change.diff'), diff, { mode: 0o600 });
    const before = oracle(join(directory, 'oracles', `${id}-base`), fixture, fixture.base, goBinary);
    const after = oracle(join(directory, 'oracles', `${id}-head`), fixture, fixture[variant], goBinary);
    if (before.status !== 'pass' || after.status !== (variant === 'bug' ? 'defect-reproduced' : 'pass')) throw new Error('Smoke oracle expectations failed');
    cases.push({ id, language: fixture.language, variant, directory: `cases/${id}/review`, headSha, baseSha,
      sourceHash: hash(fixture[variant]), oracleHash: hash(fixture.oracle), oracle: { base: before, head: after },
      expected: variant === 'bug' ? fixture.expectation : null });
  }
  const manifest = { schemaVersion: 1, kind: 'owned-development-smoke', createdAt: new Date().toISOString(),
    fixturesHash: hash(JSON.stringify(fixtures)), runtime: { node: process.version, python: 'python3', go: goBinary }, cases };
  save(join(directory, 'suite.json'), manifest);
  return manifest;
}
export async function runSmoke(directory, profilePath, maxUsd, reviewRunner = runReview) {
  if (!Number.isFinite(maxUsd) || maxUsd < 0 || maxUsd > 15) throw new Error('Smoke budget must be explicitly set between $0 and $15');
  const profile = readProfile(profilePath);
  const keyName = profile.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
  if (!process.env[keyName]) throw new Error(`${keyName} is missing; configure locally, never in chat`);
  const manifest = JSON.parse(readFileSync(join(directory, 'suite.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.fixturesHash !== hash(JSON.stringify(fixtures)) || manifest.cases.length !== 6) throw new Error('Unknown or modified smoke corpus');
  const summaryPath = join(directory, 'smoke-result.json');
  if (existsSync(summaryPath)) throw new Error('Smoke batch already started; prepare a new suite to rerun');
  const summary = { schemaVersion: 1, suiteHash: hash(JSON.stringify(manifest)), profile, maxUsd,
    startedAt: new Date().toISOString(), finishedAt: null, accountedUsd: 0, cases: [] };
  save(summaryPath, summary);
  const persist = () => { save(`${summaryPath}.pending`, summary); renameSync(`${summaryPath}.pending`, summaryPath); };
  const signal = new AbortController();
  const cancel = () => signal.abort();
  let providerFailure = null;
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    for (const entry of manifest.cases) {
      if (providerFailure || signal.signal.aborted || summary.accountedUsd + profile.maxUsd > maxUsd) {
        summary.cases.push({ id: entry.id, status: 'unattempted', reason: providerFailure ? `provider-${providerFailure.kind}` : signal.signal.aborted ? 'cancelled' : 'budget' }); persist(); continue;
      }
      // Only a UUID-owned case path is accepted; oracle/manifest paths never enter source tools.
      if (!/^[0-9a-f-]{36}$/.test(entry.id) || entry.directory !== `cases/${entry.id}/review`) throw new Error('Invalid smoke case path');
      const path = join(directory, entry.directory);
      const { packet } = loadReview(path);
      if (packet.headSha !== entry.headSha || packet.baseSha !== entry.baseSha) throw new Error('Smoke snapshot changed');
      // Reserve the whole case durably before dispatch. A killed batch cannot be resumed and re-spent.
      const record = { id: entry.id, status: 'in-flight', accountedUsd: profile.maxUsd, semanticAdjudication: 'pending' };
      summary.cases.push(record); summary.accountedUsd += profile.maxUsd; persist();
      const { result, receipt } = await reviewRunner(path, profile, undefined, signal.signal);
      const cost = accountedUsd(receipt);
      providerFailure = receipt.providerFailure;
      summary.accountedUsd += cost - profile.maxUsd;
      Object.assign(record, { status: result.status, accountedUsd: cost, findingCount: result.findings.length, stopReason: receipt.stopReason });
      writeFileSync(join(path, 'report.md'), renderMarkdown(packet, result, assess(packet, result)), { mode: 0o600, flag: 'wx' });
      persist();
      process.stdout.write(`${JSON.stringify({ case: entry.id, status: result.status, accountedUsd: cost })}\n`);
    }
    summary.finishedAt = new Date().toISOString(); persist();
    save(join(directory, 'adjudication.json'), manifest.cases.map(entry => ({ id: entry.id, expected: entry.expected,
      matchedFindingIds: null, falsePositiveFindingIds: null, reviewer: null, notes: null })));
    return summary;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
      out: { type: 'string' }, suite: { type: 'string' }, go: { type: 'string' }, profile: { type: 'string' }, 'max-usd': { type: 'string' },
    } });
    if (positionals.length !== 1) throw new Error('Use prepare --out <new-directory> [--go <binary>] or run --suite <directory> --profile <json> --max-usd <cap>');
    if (positionals[0] === 'prepare' && values.out) {
      const manifest = prepareSmoke(resolve(values.out), values.go);
      process.stdout.write(`${JSON.stringify({ cases: manifest.cases.length, oracles: 'verified', directory: resolve(values.out) })}\n`);
    } else if (positionals[0] === 'run' && values.suite && values.profile && values['max-usd']) {
      await runSmoke(resolve(values.suite), resolve(values.profile), Number(values['max-usd']));
    } else throw new Error('Missing required smoke command flags');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
