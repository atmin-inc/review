import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../dist/snapshot.js';
import { readProfile, runStateBuild } from '../dist/run.js';
import { stateAccountedUsd } from '../dist/state-builder.js';
import { codexModel } from './codex-model.mjs';

const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
const sum = (values, key) => values.reduce((total, value) => total + (value[key] ?? 0), 0);

// Builds one repository state per frozen development case from a previous
// comparison's packets, retaining every attempt and receipt. The reserved
// split is never read. Provider access failures stop new dispatch.
export async function buildStates(output, source, profilePath, modelFactory = codexModel, concurrency = 3) {
  const review = fileURLToPath(new URL('../', import.meta.url));
  const split = JSON.parse(readFileSync(join(review, 'benchmarks/martian-development-split.json')));
  const previous = JSON.parse(readFileSync(join(source, 'comparison.json')));
  const development = new Set(split.cases.filter(c => c.split === 'development').map(c => c.id));
  const cases = previous.cases.filter(c => development.has(c.id));
  if (cases.length !== 15) throw Error('All 15 frozen development cases are required');
  const profile = readProfile(profilePath);
  mkdirSync(output);
  const index = { kind: 'repository-state-builds', createdAt: new Date().toISOString(), finishedAt: null, profile, profileHash: hash(readFileSync(profilePath)),
    cases: cases.map(c => ({ id: c.id, packetHash: c.packetHash, status: 'unattempted' })) };
  const indexPath = join(output, 'states.json');
  save(indexPath, index);
  const persist = () => { save(indexPath + '.pending', index); renameSync(indexPath + '.pending', indexPath); };
  let blocked = false;
  const entries = index.cases.values();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (const entry of entries) {
      if (blocked) { entry.status = 'dispatch-stopped'; persist(); continue; }
      const directory = join(source, 'cases', entry.id);
      entry.startedAt = new Date().toISOString(); entry.status = 'running'; persist();
      try {
        if (hash(readFileSync(join(directory, 'packet.json'))) !== entry.packetHash) throw Error('Case changed');
        const model = await modelFactory(profile);
        const { state, receipt } = await runStateBuild(directory, join(output, entry.id), profile, model).finally(() => model.close?.());
        Object.assign(entry, { status: state.complete && receipt.stopReason === 'finished' ? 'complete' : 'partial', stopReason: receipt.stopReason,
          commit: state.commit, complete: state.complete, sections: state.sections.length, limitations: state.limitations.length,
          elapsedMs: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt), modelCalls: receipt.calls.length,
          toolCalls: receipt.toolCalls, toolErrors: receipt.toolErrors.length, reads: receipt.reads,
          actualInputTokens: sum(receipt.calls.filter(c => c.outputTokens !== null), 'inputTokens'),
          cachedInputTokens: sum(receipt.calls, 'cachedInputTokens'), actualOutputTokens: sum(receipt.calls, 'outputTokens'),
          unsettledCalls: receipt.calls.filter(c => c.meteredUsd === null).length, accountedUsd: stateAccountedUsd(receipt),
          stateHash: hash(readFileSync(join(output, entry.id, 'repository-state.json'))) });
        blocked ||= ['authentication', 'rate-limit', 'funding'].includes(receipt.providerFailure?.kind);
      } catch {
        entry.status = 'infrastructure-error'; entry.reason = 'Source, process, or persistence failed'; blocked = true;
      }
      entry.finishedAt = new Date().toISOString(); persist();
      console.log(JSON.stringify({ id: entry.id, status: entry.status, sections: entry.sections, elapsedMs: entry.elapsedMs, stopReason: entry.stopReason }));
    }
  }));
  index.finishedAt = new Date().toISOString(); persist();
  return index;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  if (process.argv.length !== 5) throw Error('Usage: node build-states.mjs <new-output-directory> <frozen-comparison-directory> <profile.json>');
  const index = await buildStates(...process.argv.slice(2).map(p => resolve(p)));
  process.exitCode = index.cases.every(c => c.status === 'complete') ? 0 : 2;
}
