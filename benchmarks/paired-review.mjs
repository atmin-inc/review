import { cpSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from '../dist/snapshot.js';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });

export function validatePlan(manifest) {
  const { cases, trials } = manifest;
  const id = value => typeof value === 'string' && /^[a-z0-9-]+$/.test(value);
  if (manifest.kind !== 'frozen-controller-repeat-comparison' || !Array.isArray(cases) || !Array.isArray(trials)
    || cases.length !== 15 || trials.length !== 60 || cases.some(c => !id(c.id))
    || new Set(cases.map(c => c.id)).size !== 15 || trials.some(t => !id(t.id) || !id(t.caseId))
    || new Set(trials.map(t => t.id)).size !== 60) throw Error('Expected 15 cases and 60 distinct trials');
  for (const entry of cases) {
    const selected = trials.filter(t => t.caseId === entry.id);
    if (JSON.stringify(selected.map(t => `${t.arm}:${t.repeat}`).sort()) !== JSON.stringify(['baseline:1', 'baseline:2', 'candidate:1', 'candidate:2'])) throw Error('Each case needs both arms twice');
    if (selected.some(t => t.evaluationArm !== `${t.arm}-r${t.repeat}`)) throw Error('Repeated evaluations must remain distinct');
    const first = selected.filter(t => t.repeat === 1), second = selected.filter(t => t.repeat === 2);
    if (first[0].arm === second[0].arm) throw Error('Reverse arm order on the second repeat');
  }
}

export async function compare(directory) {
  const manifest = read(join(directory, 'comparison.json'));
  validatePlan(manifest);
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (path.startsWith('/') || path.split('/').includes('..') || hash(readFileSync(join(directory, path))) !== digest) throw Error('Frozen experiment file changed');
  }
  const engine = path => import(pathToFileURL(join(directory, 'engine', path)).href);
  const [{ runReview, readProfile }, { codexModel }, { loadReview }, { assess }, { renderMarkdown }] = await Promise.all([
    engine('dist/run.js'), engine('benchmarks/codex-model.mjs'), engine('dist/snapshot.js'), engine('dist/assessment.js'), engine('dist/render.js')]);
  const { runReview: baselineReview } = await import(pathToFileURL(join(directory, 'baseline/dist/run.js')).href);
  // Identical adapter code must resolve each runtime's own trace context and
  // ProviderRequestError class; cross-runtime imports lose both identities.
  if (hash(readFileSync(join(directory, 'baseline/benchmarks/codex-model.mjs'))) !== hash(readFileSync(join(directory, 'engine/benchmarks/codex-model.mjs')))) throw Error('Paired adapters differ');
  const { codexModel: baselineModel } = await import(pathToFileURL(join(directory, 'baseline/benchmarks/codex-model.mjs')).href);
  const profile = readProfile(join(directory, 'engine/profiles/completion-codex-local.json'));
  const resultPath = join(directory, 'comparison-result.json');
  const result = { manifestHash: hash(readFileSync(join(directory, 'comparison.json'))), startedAt: new Date().toISOString(), finishedAt: null,
    trials: manifest.trials.map(trial => ({ ...trial, status: 'unattempted' })) };
  save(resultPath, result);
  const persist = () => { save(resultPath + '.pending', result); renameSync(resultPath + '.pending', resultPath); };
  persist();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let blocked = false;
  async function run(trial) {
    if (blocked || abort.signal.aborted) { trial.reason = 'dispatch-stopped'; persist(); return; }
    const output = join(directory, 'trials', trial.id), source = join(directory, 'cases', trial.caseId);
    trial.startedAt = new Date().toISOString(); trial.status = 'preparing'; persist();
    try {
      const entry = manifest.cases.find(c => c.id === trial.caseId);
      if (!entry || hash(readFileSync(join(source, 'packet.json'))) !== entry.packetHash || hash(readFileSync(join(source, 'change.diff'))) !== entry.diffHash) throw Error('Case changed');
      if (existsSync(output)) throw Error('Trial already exists');
      mkdirSync(output, { recursive: true }); trial.status = 'running'; persist();
      cpSync(source, output, { recursive: true });
      const model = await (trial.arm === 'baseline' ? baselineModel : codexModel)(profile);
      const { result: review, receipt } = await (trial.arm === 'baseline' ? baselineReview : runReview)(output, profile, model, abort.signal).finally(() => model.close?.());
      const { packet } = loadReview(output);
      writeFileSync(join(output, 'report.md'), renderMarkdown(packet, review, assess(packet, review)), { flag: 'wx' });
      Object.assign(trial, { status: review.status, stopReason: receipt.stopReason,
        elapsedMs: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt), modelCalls: receipt.calls.length,
        toolCalls: receipt.toolCalls, toolErrors: receipt.toolErrors.length, findings: review.findings.length,
        discovery: receipt.discovery ?? null, qualityRecorded: !!review.quality,
        unsettledCalls: receipt.calls.filter(c => c.meteredUsd === null).length,
        sourceReads: review.evidence.length, reviewedFiles: review.coverage.filter(f => f.status === 'reviewed').length,
        actualInputTokens: receipt.calls.filter(c => c.outputTokens !== null).reduce((sum, c) => sum + c.inputTokens, 0),
        actualOutputTokens: receipt.calls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0),
        cachedInputTokens: receipt.calls.reduce((sum, c) => sum + (c.cachedInputTokens ?? 0), 0), additionalApiUsd: 0, billing: 'subscription' });
      blocked ||= ['authentication', 'rate-limit', 'funding'].includes(receipt.providerFailure?.kind);
      trial.reportHash = hash(readFileSync(join(output, 'report.md')));
    } catch {
      trial.status = 'infrastructure-error'; trial.reason = 'Source, process, or persistence failed'; blocked = true;
    }
    trial.finishedAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({ id: trial.id, status: trial.status, elapsedMs: trial.elapsedMs, findings: trial.findings, stopReason: trial.stopReason }));
  }
  try {
    // Three independent PR pairs in flight; the two arms of a pair never
    // overlap. Repeat two reverses their order, and every attempt is retained.
    for (const repeat of [1, 2]) {
      const entries = manifest.cases.values();
      await Promise.all(Array.from({ length: 3 }, async () => {
        for (const entry of entries) {
          for (const trial of result.trials.filter(t => t.caseId === entry.id && t.repeat === repeat)) await run(trial);
        }
      }));
    }
  } finally {
    result.finishedAt = new Date().toISOString(); persist();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
  return result;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  if (process.argv.length !== 3) throw Error('Usage: node paired-review.mjs <frozen-directory>');
  const result = await compare(resolve(process.argv[2]));
  process.exitCode = result.trials.every(t => t.status === 'completed') ? 0 : 2;
}
