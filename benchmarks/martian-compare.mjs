import { cpSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hash } from '../dist/snapshot.js';
import { plainCodex } from './plain-codex.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });

export function validatePlan(manifest) {
  const cases = manifest.cases, trials = manifest.trials;
  const id = value => typeof value === 'string' && /^[a-z0-9-]+$/.test(value);
  if (manifest.kind !== 'frozen-martian-paired-comparison' || !Array.isArray(cases) || !Array.isArray(trials)
    || cases.length !== 15 || trials.length !== 30 || cases.some(c => !id(c.id))
    || new Set(cases.map(c => c.id)).size !== 15 || trials.some(t => !id(t.id) || !id(t.caseId))
    || new Set(trials.map(t => t.id)).size !== 30) throw Error('Expected 15 distinct paired cases');
  for (const entry of cases) {
    const arms = trials.filter(t => t.caseId === entry.id).map(t => t.arm).sort();
    if (JSON.stringify(arms) !== JSON.stringify(['atmin-r02-24', 'plain-codex'])) throw Error('Each case requires one trial per arm');
  }
}

export async function compare(directory, continueUnattempted = false) {
  const manifest = read(join(directory, 'comparison.json'));
  validatePlan(manifest);
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (path.startsWith('/') || path.split('/').includes('..') || hash(readFileSync(join(directory, path))) !== digest) throw Error('Frozen experiment file changed');
  }
  const engine = path => import(pathToFileURL(join(directory, 'engine', path)).href);
  const [{ runReview, readProfile }, { codexModel }, { loadReview }, { assess }, { renderMarkdown }] = await Promise.all([
    engine('dist/run.js'), engine('benchmarks/codex-model.mjs'), engine('dist/snapshot.js'), engine('dist/assessment.js'), engine('dist/render.js')]);
  const profile = readProfile(join(directory, 'engine/profiles/completion-codex-local.json'));
  const resultPath = join(directory, 'comparison-result.json');
  const result = continueUnattempted ? read(resultPath) : { manifestHash: hash(readFileSync(join(directory, 'comparison.json'))), startedAt: new Date().toISOString(), finishedAt: null,
    trials: manifest.trials.map(trial => ({ ...trial, status: 'unattempted' })) };
  const pendingIds = new Set(result.trials.filter(t => t.status === 'unattempted').map(t => t.id));
  if (continueUnattempted) {
    if (!result.finishedAt || result.continuedAt || result.trials.some(t => ['running', 'preparing'].includes(t.status))
      || result.manifestHash !== hash(readFileSync(join(directory, 'comparison.json')))
      || result.trials.length !== manifest.trials.length || result.trials.some((t, i) => t.id !== manifest.trials[i].id)) throw Error('Cannot continue this run');
    save(join(directory, 'comparison-result.initial.json'), result);
    result.continuedAt = new Date().toISOString(); result.finishedAt = null;
  } else save(resultPath, result);
  const persist = () => { save(resultPath + '.pending', result); renameSync(resultPath + '.pending', resultPath); };
  persist();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let blocked = false;
  async function run(trial) {
    if (!pendingIds.has(trial.id)) return;
    if (blocked || abort.signal.aborted) { trial.reason = 'dispatch-stopped'; persist(); return; }
    const output = join(directory, 'trials', trial.id), source = join(directory, 'cases', trial.caseId);
    trial.startedAt = new Date().toISOString(); trial.status = 'preparing'; persist();
    try {
      const entry = manifest.cases.find(c => c.id === trial.caseId);
      if (!entry || hash(readFileSync(join(source, 'packet.json'))) !== entry.packetHash || hash(readFileSync(join(source, 'change.diff'))) !== entry.diffHash) throw Error('Case changed');
      if (existsSync(output)) throw Error('Trial already exists');
      mkdirSync(output, { recursive: true }); trial.status = 'running'; persist();
      if (trial.arm === 'atmin-r02-24') {
        cpSync(source, output, { recursive: true });
        const model = await codexModel(profile);
        const { result: review, receipt } = await runReview(output, profile, model, abort.signal).finally(() => model.close?.());
        const { packet } = loadReview(output);
        writeFileSync(join(output, 'report.md'), renderMarkdown(packet, review, assess(packet, review)), { flag: 'wx' });
        Object.assign(trial, { status: review.status, stopReason: receipt.stopReason,
          elapsedMs: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt), modelCalls: receipt.calls.length,
          toolCalls: receipt.toolCalls, toolErrors: receipt.toolErrors.length, findings: review.findings.length,
          sourceReads: review.evidence.length, reviewedFiles: review.coverage.filter(f => f.status === 'reviewed').length,
          actualInputTokens: receipt.calls.filter(c => c.outputTokens !== null).reduce((sum, c) => sum + c.inputTokens, 0),
          actualOutputTokens: receipt.calls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0),
          cachedInputTokens: receipt.calls.reduce((sum, c) => sum + (c.cachedInputTokens ?? 0), 0), additionalApiUsd: 0, billing: 'subscription' });
        blocked ||= ['authentication', 'rate-limit', 'funding'].includes(receipt.providerFailure?.kind);
      } else if (trial.arm === 'plain-codex') {
        const work = join(output, 'source');
        const env = { PATH: process.env.PATH, HOME: output, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-hardlinks', '--template=', join(source, 'source.git'), work], { env, timeout: 120000 });
        // Local branches make normal git inspection sufficient; no remote access.
        for (const branch of ['comparison-base', 'target']) execFileSync('git', ['-C', work, 'branch', branch, `origin/${branch}`], { env });
        execFileSync('git', ['-C', work, 'remote', 'remove', 'origin'], { env });
        const native = await plainCodex(work, output, undefined, abort.signal);
        Object.assign(trial, native); blocked ||= native.providerLimited;
        trial.toolCalls = existsSync(join(output, 'source.ndjson')) ? readFileSync(join(output, 'source.ndjson'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
      } else throw Error('Unknown arm');
      trial.reportHash = hash(readFileSync(join(output, 'report.md')));
    } catch {
      trial.status = 'infrastructure-error'; trial.reason = 'Source, process, or persistence failed'; blocked = true;
    }
    trial.finishedAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({ id: trial.id, status: trial.status, elapsedMs: trial.elapsedMs, findings: trial.findings, stopReason: trial.stopReason }));
  }
  try {
    // Paired, alternating arm order. Three independent PRs in flight; each PR's
    // two arms run sequentially. Failed and unattempted trials stay in the index.
    for (let offset = 0; offset < manifest.cases.length; offset += 3) {
      await Promise.all(manifest.cases.slice(offset, offset + 3).map(async entry => {
        for (const trial of result.trials.filter(t => t.caseId === entry.id)) await run(trial);
      }));
    }
  } finally {
    result.finishedAt = new Date().toISOString(); persist();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
  return result;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  if (process.argv.length < 3 || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--continue-unattempted')) throw Error('Usage: node martian-compare.mjs <directory> [--continue-unattempted]');
  const result = await compare(resolve(process.argv[2]), process.argv[3] === '--continue-unattempted');
  process.exitCode = result.trials.every(t => t.status === 'completed') ? 0 : 2;
}
