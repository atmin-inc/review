// Controlled child entry point: source credentials and inference credentials never coexist.
import { readFileSync } from 'node:fs';
import { verifyReview } from '../verification.js';
import { prepare, loadReview, withGitDeadline } from '../snapshot.js';
import { readProfile } from '../run.js';
import { runClaimReviewAsResult } from '../claim-result.js';

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
    // The claim pipeline, as measured on the Martian development cases (2026-09-24).
    await runClaimReviewAsResult(input, readProfile(output), abort.signal);
    withGitDeadline(30_000, () => loadReview(input));
  } else if (phase === 'verify') await verifyReview(input, JSON.parse(readFileSync(output, 'utf8')), abort.signal);
  else throw new Error('Invalid child phase');
} catch {
  // The supervisor records phase failure; model/provider bodies and source stay in private artifacts.
  process.exitCode = 1;
} finally { clearInterval(parentMonitor); }
