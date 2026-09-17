import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash, loadReview } from '../dist/snapshot.js';
import { readProfile, runReview } from '../dist/run.js';
import { codexModel } from './codex-model.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });

// A started suite cannot be resumed or silently turn a failed trial into a retry.
// New trials require a new frozen suite; all scheduled outcomes stay in the index.
export async function runSuite(directory, modelFactory = codexModel) {
  const manifest = read(join(directory, 'suite.json'));
  if (manifest.kind !== 'frozen-local-repeat-suite' || !Array.isArray(manifest.trials) || !manifest.trials.length) throw new Error('Invalid repeat suite');
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (path.startsWith('/') || path.split('/').includes('..') || hash(readFileSync(join(directory, path))) !== digest) throw new Error('Frozen suite file changed');
  }
  const profile = readProfile(join(directory, manifest.profile));
  if (profile.provider !== 'codex-local') throw new Error('This repeat runner requires the local subscription profile');
  const ids = new Set();
  for (const trial of manifest.trials) {
    if (!/^[a-z0-9-]+$/.test(trial.id) || !/^[a-z0-9-]+$/.test(trial.caseId) || ids.has(trial.id)
      || !manifest.cases.some(entry => entry.id === trial.caseId)) throw new Error('Invalid or duplicate trial identity');
    ids.add(trial.id);
  }
  const path = join(directory, 'suite-result.json');
  const result = { suiteHash: hash(readFileSync(join(directory, 'suite.json'))), startedAt: new Date().toISOString(), finishedAt: null,
    trials: manifest.trials.map(trial => ({ ...trial, status: 'unattempted' })) };
  save(path, result);
  const persist = () => { save(`${path}.pending`, result); renameSync(`${path}.pending`, path); };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let blocked = null;
  try {
    for (const trial of result.trials) {
      if (blocked || controller.signal.aborted) { trial.reason = blocked ?? 'cancelled'; persist(); continue; }
      trial.status = 'preparing'; trial.startedAt = new Date().toISOString(); persist();
      try {
        const source = join(directory, 'cases', trial.caseId);
        const output = join(directory, 'trials', trial.id);
        if (existsSync(output)) throw new Error('Trial directory exists');
        mkdirSync(join(directory, 'trials'), { recursive: true });
        cpSync(source, output, { recursive: true, errorOnExist: true, force: false });
        const { packet, result: initial } = loadReview(output);
        const entry = manifest.cases.find(entry => entry.id === trial.caseId);
        if (initial.status !== 'not-started' || hash(readFileSync(join(output, 'packet.json'))) !== entry.packetHash
          || packet.diffHash !== entry.diffHash) throw new Error('Frozen case input changed');
        const model = await modelFactory(profile);
        trial.status = 'running'; persist();
        const { result: review, receipt } = await runReview(output, profile, model, controller.signal).finally(() => model.close?.());
        Object.assign(trial, { status: review.status, stopReason: receipt.stopReason,
          elapsedMs: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
          modelCalls: receipt.calls.length, toolCalls: receipt.toolCalls, toolErrors: receipt.toolErrors.length,
          sourceReads: review.evidence.length, reviewedFiles: review.coverage.filter(file => file.status === 'reviewed').length,
          changedFiles: packet.changedFiles.length, qualityRecorded: !!review.quality,
          findings: review.findings.length, findingsHash: hash(JSON.stringify(review.findings)),
          actualInputTokens: receipt.calls.filter(call => call.outputTokens !== null).reduce((sum, call) => sum + call.inputTokens, 0),
          actualOutputTokens: receipt.calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
          cachedInputTokens: receipt.calls.reduce((sum, call) => sum + (call.cachedInputTokens ?? 0), 0),
          unsettledCalls: receipt.calls.filter(call => call.meteredUsd === null).length,
          additionalApiUsd: 0, billing: 'subscription', semanticAdjudication: 'pending',
        });
        if (['authentication', 'rate-limit', 'funding'].includes(receipt.providerFailure?.kind)) blocked = `provider-${receipt.providerFailure.kind}`;
      } catch {
        trial.status = 'infrastructure-error'; trial.reason = 'Snapshot, local CLI startup, or persistence failed';
        // Startup failures have no settled provider record; stop dispatch rather
        // than assuming an unavailable login or corrupted suite is transient.
        blocked = 'infrastructure-error';
      }
      trial.finishedAt = new Date().toISOString(); persist();
      console.log(JSON.stringify({ trial: trial.id, status: trial.status, elapsedMs: trial.elapsedMs, findings: trial.findings }));
    }
  } finally {
    result.finishedAt = new Date().toISOString(); persist();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
  return result;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('Usage: node repeat-suite.mjs <frozen-suite-directory>');
  const result = await runSuite(resolve(process.argv[2]));
  process.exitCode = result.trials.every(trial => trial.status === 'completed' && trial.stopReason === 'finished') ? 0 : 2;
}
