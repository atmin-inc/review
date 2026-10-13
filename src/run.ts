import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { investigate, parseProfile, type Model, type Profile } from './investigation.js';
import { modelFor } from './claim-run.js';
import { loadReview, persistJson } from './snapshot.js';
import { withTrace } from './trace.js';

export function readProfile(path: string): Profile {
  const bytes = readFileSync(path);
  if (bytes.length > 8000) throw new Error('Profile exceeds 8 KB');
  return parseProfile(JSON.parse(bytes.toString('utf8')));
}
export async function runReview(directory: string, profile: Profile, injectedModel?: Model, signal?: AbortSignal) {
  // One run per snapshot: a rerun or resume could reset the budget after a request whose charge is unknown.
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
