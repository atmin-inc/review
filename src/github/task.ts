// Controlled child entry point: source credentials and inference credentials never coexist.
import { prepare, loadReview, withGitDeadline } from '../snapshot.js';
import { runReview, readProfile } from '../run.js';

const [phase, input, output] = process.argv.slice(2);
const abort = new AbortController();
const parent = process.ppid;
const parentMonitor = setInterval(() => { if (process.ppid !== parent) abort.abort(); }, 1000);
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
try {
  if (!input || !output) throw new Error('Invalid child arguments');
  if (phase === 'capture') withGitDeadline(120_000, () => prepare(input, output));
  else if (phase === 'investigate') {
    await runReview(input, readProfile(output), undefined, abort.signal);
    withGitDeadline(30_000, () => loadReview(input));
  } else throw new Error('Invalid child phase');
} catch {
  // The supervisor records phase failure; model/provider bodies and source stay in private artifacts.
  process.exitCode = 1;
} finally { clearInterval(parentMonitor); }
