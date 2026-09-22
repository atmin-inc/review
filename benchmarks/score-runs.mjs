// Scores a directory of claim-review runs against the golden comments, deterministically.
// Each run is a <case>-r<n> folder holding claims.json and verification.json, as written by
// runClaimReview. Usage: node benchmarks/score-runs.mjs <run-set-directory> [maxRepeat]
//
// Reports per-run golden comments found rather than only "found at least once", because
// the per-run mean has a measurable spread and the at-least-once count does not: on
// 2026-09-22 the baseline measured 0.73 golden per run with SD 0.70, which is what sizes
// an experiment. See /mnt/project-files/method-2026-09-22.md.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { matches } from './golden-matcher.mjs';

const [root, maxRepeat = '99'] = process.argv.slice(2);
const runs = readdirSync(root).filter(name => /^case-\d+-r\d+$/.test(name))
  .filter(name => Number(name.split('-r')[1]) <= Number(maxRepeat)).sort();
const perRun = [], found = new Set(), shippedFound = new Set();
let emitted = 0, shipped = 0, matchingShipped = 0;
for (const run of runs) {
  if (!existsSync(join(root, run, 'claims.json'))) continue;
  const claims = JSON.parse(readFileSync(join(root, run, 'claims.json'), 'utf8'));
  const chains = JSON.parse(readFileSync(join(root, run, 'verification.json'), 'utf8')).chains ?? [];
  const here = new Set();
  for (const claim of claims.claims ?? claims) {
    emitted++;
    const ship = chains.find(chain => chain.claimId === claim.claimId)?.verdict === 'confirmed';
    const ids = matches(claim);
    if (ship) { shipped++; if (ids.length) matchingShipped++; }
    for (const id of ids) { found.add(id); if (ship) { shippedFound.add(id); here.add(id); } }
  }
  perRun.push(here.size);
}
const mean = perRun.reduce((a, b) => a + b, 0) / (perRun.length || 1);
const sd = Math.sqrt(perRun.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, perRun.length - 1));
console.log(JSON.stringify({ runs: perRun.length, emitted, shipped, matchingShipped,
  goldenShippedAtLeastOnce: shippedFound.size, goldenEmittedAtLeastOnce: found.size,
  goldenShippedPerRun: { mean: +mean.toFixed(2), sd: +sd.toFixed(2) }, shippedIds: [...shippedFound].sort() }, null, 1));
