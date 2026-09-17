import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { investigate, parseProfile, type Model, type Profile } from './investigation.js';
import { openAIModel } from './openai-model.js';
import { openRouterModel } from './openrouter-model.js';
import { loadReview } from './snapshot.js';
import { withTrace } from './trace.js';

export function readProfile(path: string): Profile {
  const bytes = readFileSync(path);
  if (bytes.length > 8000) throw new Error('Profile exceeds 8 KB');
  return parseProfile(JSON.parse(bytes.toString('utf8')));
}
export async function runReview(directory: string, profile: Profile, injectedModel?: Model, signal?: AbortSignal) {
  // No rerun/resume that can accidentally reset the same run's budget after an uncertain request.
  const { packet, result } = loadReview(directory);
  if (result.status !== 'not-started') throw new Error('Investigation already started; prepare a new snapshot for another run');
  if (profile.provider === 'codex-local' && !injectedModel) throw new Error('Local subscription experiments require the benchmark Codex adapter; hosted execution is not supported');
  const model = injectedModel ?? (profile.provider === 'openrouter' ? openRouterModel(profile) : openAIModel(profile));
  const lock = join(directory, 'investigation.lock');
  const fd = openSync(lock, 'wx', 0o600);
  closeSync(fd);
  const persist = (name: string, value: unknown) => {
    const temporary = join(directory, `${name}.pending`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, join(directory, name));
  };
  try {
    if (existsSync(join(directory, 'receipt.json')) || loadReview(directory).result.status !== 'not-started') {
      throw new Error('Run has existing investigation or spending evidence; prepare a new snapshot');
    }
    return await withTrace(directory, () => investigate(directory, packet, profile, model, (result, receipt) => {
      persist('receipt.json', receipt); persist('result.json', result);
    }, signal));
  } finally { unlinkSync(lock); }
}
