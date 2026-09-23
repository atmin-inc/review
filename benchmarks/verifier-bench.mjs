// The verifier bench: re-verifies every labelled claim on disk with the current build and
// reports what ships, by label. Verification is deterministic and rung 3 is replayed from
// its recorded answers, so a verifier change is scored in about 90 seconds for $0 with no
// variance, instead of by a set of 8-minute end-to-end runs whose spread is mostly the
// emitter's.
//
// Usage: node benchmarks/verifier-bench.mjs <bench-dir> [--save out.json] [--against old.json]
//   <bench-dir> holds claims.json and snapshots/case-<id>/{packet.json,source.git.tar};
//   the frozen copy is /mnt/project-files/verifier-bench. --save writes each claim's
//   verdict; --against lists the claims whose verdict differs from a saved run, with labels.
//
// Labels (rubric in /mnt/project-files/labelled-claims-2026-09-22/rubric.md): G golden,
// R real, P plausible, S restatement, X speculation, O overstated. Harmful = X + O.
//
// The replay trap applies: a change that sends rung 3 a question it was never asked gets
// no recorded answer, so the bench cannot see it. `unanswered` counts those questions; a
// change that raises it must be measured live.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyClaims } from '../dist/lifecycle.js';
import { recordedRung } from '../dist/ablation.js';
import { revisionFrom } from '../dist/symbolic.js';
import { BALANCED } from '../dist/policy.js';

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? '');
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const claims = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));

// Snapshots are archived; unpack each once into a cache outside the bench directory.
const cache = join(tmpdir(), 'atmin-verifier-bench');
const revisionsFor = {};
function revisions(id) {
  if (revisionsFor[id]) return revisionsFor[id];
  const target = join(cache, `case-${id}`);
  if (!existsSync(join(target, 'source.git'))) {
    mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xf', join(dir, 'snapshots', `case-${id}`, 'source.git.tar'), '-C', target]);
  }
  const packet = JSON.parse(readFileSync(join(dir, 'snapshots', `case-${id}`, 'packet.json'), 'utf8'));
  const repository = join(target, 'source.git');
  return revisionsFor[id] = { head: memo(revisionFrom(repository, packet.headSha)), base: memo(revisionFrom(repository, packet.mergeBaseSha)) };
}
// Every check is a git subprocess, and 657 claims ask many of the same questions of the
// same frozen revision. The answers cannot change, so each is asked once.
function memo(revision) {
  const seen = new Map();
  const once = name => (...a) => { const k = `${name}\u0000${JSON.stringify(a)}`; if (!seen.has(k)) seen.set(k, revision[name](...a)); return seen.get(k); };
  return { search: once('search'), lineAt: once('lineAt'), slice: once('slice') };
}

// Each claim is verified alone, with only its own recorded answers: a chain does not depend
// on its run's other claims, and one claim per call keeps a thrown check to one claim.
const verdicts = {};
let unanswered = 0, errors = 0;
for (const entry of claims) {
  const asked = new Set(entry.crossFamily.map(answer => answer.proposition));
  const rung = recordedRung(entry.crossFamily);
  const counting = { settle: (proposition, claim, ...rest) => {
    if (!asked.has(proposition)) unanswered++;
    return rung.settle(proposition, claim, ...rest);
  } };
  try {
    verdicts[entry.origin] = verifyClaims([entry.claim], revisions(entry.case), BALANCED, counting).chains[0].verdict;
  } catch { verdicts[entry.origin] = 'error'; errors++; }
}

const LABELS = ['G', 'R', 'P', 'S', 'X', 'O'];
const rows = LABELS.map(label => {
  const of = claims.filter(c => c.label === label);
  const shipped = of.filter(c => verdicts[c.origin] === 'confirmed').length;
  return { label, claims: of.length, shipped, rate: of.length ? +(shipped / of.length).toFixed(2) : 0 };
});
const sum = labels => rows.filter(r => labels.includes(r.label)).reduce((a, r) => a + r.shipped, 0);
const replayed = claims.filter(c => c.recordedVerdict !== null && c.origin.startsWith('exp-0923/'));
const reproduced = replayed.filter(c => verdicts[c.origin] === c.recordedVerdict).length;
console.log(JSON.stringify({
  byLabel: rows,
  shipped: { harmful: sum(['X', 'O']), acceptable: sum(['G', 'R', 'P']), wasteful: sum(['S']) },
  // The 2026-09-23 runs were verified by nearly this build; their recorded verdicts are the
  // check that the bench replays faithfully. Older runs used older verifiers on purpose.
  reproducesRecent: `${reproduced} of ${replayed.length}`,
  unanswered, errors,
}, null, 1));

if (flag('--save')) writeFileSync(flag('--save'), JSON.stringify(verdicts));
if (flag('--against')) {
  const old = JSON.parse(readFileSync(flag('--against'), 'utf8'));
  const changed = claims.filter(c => old[c.origin] !== verdicts[c.origin]);
  const moved = {};
  for (const c of changed) { const k = `${c.label}: ${old[c.origin]} -> ${verdicts[c.origin]}`; moved[k] = (moved[k] ?? 0) + 1; }
  console.log(JSON.stringify({ changed: changed.length, moved }, null, 1));
}
