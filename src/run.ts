import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { investigate, parseProfile, type Model, type Profile } from './investigation.js';
import { openAIModel } from './openai-model.js';
import { openRouterModel } from './openrouter-model.js';
import { loadReview } from './snapshot.js';
import { buildRepositoryState } from './state-builder.js';
import { withTrace } from './trace.js';

export function readProfile(path: string): Profile {
  const bytes = readFileSync(path);
  if (bytes.length > 8000) throw new Error('Profile exceeds 8 KB');
  return parseProfile(JSON.parse(bytes.toString('utf8')));
}
function modelFor(profile: Profile, injectedModel?: Model): Model {
  if (profile.provider === 'codex-local' && !injectedModel) throw new Error('Local subscription experiments require the benchmark Codex adapter; hosted execution is not supported');
  return injectedModel ?? (profile.provider === 'openrouter' ? openRouterModel(profile) : openAIModel(profile));
}
function persistJson(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `${name}.pending`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
  renameSync(temporary, join(directory, name));
}
// Builds state for the snapshot's target commit into a new directory, so the
// build's trace and receipt never collide with a later review of the same snapshot.
export async function runStateBuild(directory: string, output: string, profile: Profile, injectedModel?: Model, signal?: AbortSignal) {
  const { packet } = loadReview(directory);
  const model = modelFor(profile, injectedModel);
  mkdirSync(output, { mode: 0o700 });
  return withTrace(output, () => buildRepositoryState(join(directory, 'source.git'), { repository: packet.repository, branch: packet.baseRef, commit: packet.baseSha },
    profile, model, (state, receipt) => { persistJson(output, 'repository-state.receipt.json', receipt); persistJson(output, 'repository-state.json', state); }, signal));
}
export async function runReview(directory: string, profile: Profile, injectedModel?: Model, signal?: AbortSignal) {
  // No rerun/resume that can accidentally reset the same run's budget after an uncertain request.
  const { packet, result } = loadReview(directory);
  if (result.status !== 'not-started') throw new Error('Investigation already started; prepare a new snapshot for another run');
  const model = modelFor(profile, injectedModel);
  const lock = join(directory, 'investigation.lock');
  const fd = openSync(lock, 'wx', 0o600);
  closeSync(fd);
  try {
    if (existsSync(join(directory, 'receipt.json')) || loadReview(directory).result.status !== 'not-started') {
      throw new Error('Run has existing investigation or spending evidence; prepare a new snapshot');
    }
    return await withTrace(directory, () => investigate(directory, packet, profile, model, (result, receipt) => {
      persistJson(directory, 'receipt.json', receipt); persistJson(directory, 'result.json', result);
    }, signal));
  } finally { unlinkSync(lock); }
}
