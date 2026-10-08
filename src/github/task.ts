// Controlled child entry point: source credentials and inference credentials never coexist.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyReview } from '../verification.js';
import { prepare, loadReview, withGitDeadline } from '../snapshot.js';
import { readProfile } from '../run.js';
import { runClaimReviewAsResult } from '../claim-result.js';

const [phase, input, output, cache] = process.argv.slice(2);
// Failure messages this code writes about the review's input or limits (snapshot.ts, claim-run.ts).
const ownReason = /^(Diff exceeds \d+ KB|Review deadline reached|Invalid inventory or more than 1000 changed paths|File exceeds the 16 MiB capture limit|PR changed during capture|Only open pull requests can be prepared|No valid common ancestor|Unsupported change type|Review JSON exceeds the 16 MiB limit|(git|gh) [a-z-]+ failed or exceeded its time\/output limit)/;
const abort = new AbortController();
const parent = process.ppid;
const parentMonitor = setInterval(() => { if (process.ppid !== parent) abort.abort(); }, 1000);
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
try {
  if (!input || !output) throw new Error('Invalid child arguments');
  if (phase === 'capture') withGitDeadline(120_000, () => prepare(input, output, cache));
  else if (phase === 'investigate') {
    // The claim pipeline, as measured on the Martian development cases (2026-09-24).
    await runClaimReviewAsResult(input, readProfile(output), abort.signal);
    withGitDeadline(30_000, () => loadReview(input));
  } else if (phase === 'verify') await verifyReview(input, JSON.parse(readFileSync(output, 'utf8')), abort.signal);
  else throw new Error('Invalid child phase');
} catch (error) {
  // The supervisor records phase failure; model/provider bodies and source stay in private artifacts.
  // The run's failure.json says which phase failed and why, in this code's own words only: a
  // message on the list below, which carries no source or provider text, or else the error's kind.
  const message = error instanceof Error ? error.message : '';
  const reason = ownReason.test(message) ? message.slice(0, 200) : error instanceof Error ? error.name : 'non-error';
  try { writeFileSync(join(phase === 'capture' ? output! : input!, 'failure.json'), JSON.stringify({ phase, reason }), { mode: 0o600 }); } catch { /* The run directory may not exist yet. */ }
  process.exitCode = 1;
} finally { clearInterval(parentMonitor); }
