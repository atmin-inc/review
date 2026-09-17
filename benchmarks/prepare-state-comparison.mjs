import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, loadReview } from '../dist/snapshot.js';
import { parseRepositoryState } from '../dist/repository-state.js';
import { validatePlan } from './paired-review.mjs';

// Freezes the paired repository-state experiment: one engine build in both
// arms, the 15 frozen development cases of a previous comparison, and one
// built state per case that only candidate trials receive. Reserved cases and
// their labels are never copied.
export function prepare(directory, source, states) {
  const review = fileURLToPath(new URL('../', import.meta.url));
  const split = JSON.parse(readFileSync(join(review, 'benchmarks/martian-development-split.json')));
  const previous = JSON.parse(readFileSync(join(source, 'comparison.json')));
  const development = new Set(split.cases.filter(c => c.split === 'development').map(c => c.id));
  const seed = 'atmin-repository-state-pairs-20260917-v1';
  const cases = previous.cases.filter(c => development.has(c.id)).sort((a, b) => hash(seed + a.id).localeCompare(hash(seed + b.id)));
  if (cases.length !== 15) throw Error('All 15 frozen development cases are required');
  const builds = JSON.parse(readFileSync(join(states, 'states.json')));
  const trials = [1, 2].flatMap(repeat => cases.flatMap(c => {
    const order = parseInt(hash(seed + c.id).slice(0, 2), 16) % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    if (repeat === 2) order.reverse();
    return order.map(arm => ({ id: `${c.id}-${arm}-r${repeat}`, caseId: c.id, arm, repeat, evaluationArm: `${arm}-r${repeat}` }));
  }));
  const manifest = { kind: 'frozen-repository-state-comparison', createdAt: new Date().toISOString(), seed,
    upstreamCommit: split.benchmarkCommit, model: 'gpt-5.6-sol', reasoning: 'medium',
    engines: { baseline: 'r02-28 without repository-state.json', candidate: 'r02-28 with repository-state.json' },
    concurrency: 3, repeats: 2, judge: { model: 'openai/gpt-5.2', maxUsd: 5, primaryProfile: 'core', beta: 2 },
    protocol: 'Paired source-only development comparison, three PR pairs at a time, opposite arm order on repeat two. All attempts retained, no silent retries. One engine build, adapter, model, profile, renderer and snapshot per case in both arms; the only difference is the frozen repository-state.json copied into candidate trials. State builds used the same model and profile and are retained with receipts. Reserved cases and labels are excluded.',
    stateBuilds: { profileHash: builds.profileHash, cases: {} }, cases, trials, states: {}, files: {} };
  mkdirSync(directory);
  for (const arm of ['engine', 'baseline']) {
    for (const part of ['package.json', 'package-lock.json', 'node_modules', 'src', 'dist', 'profiles']) cpSync(join(review, part), join(directory, arm, part), { recursive: true });
    for (const name of ['paired-review.mjs', 'prepare-state-comparison.mjs', 'build-states.mjs', 'paired-summary.mjs', 'codex-model.mjs', 'martian-grade.py', 'paired-review.md', 'repository-state-protocol.md']) {
      cpSync(join(review, 'benchmarks', name), join(directory, arm, 'benchmarks', name));
    }
  }
  for (const c of cases) {
    const path = join(source, 'cases', c.id), { result } = loadReview(path);
    if (result.status !== 'not-started' || hash(readFileSync(join(path, 'packet.json'))) !== c.packetHash || hash(readFileSync(join(path, 'change.diff'))) !== c.diffHash) throw Error('Frozen case changed');
    cpSync(path, join(directory, 'cases', c.id), { recursive: true });
    const build = builds.cases.find(b => b.id === c.id);
    const statePath = join(states, c.id, 'repository-state.json');
    if (!build || build.packetHash !== c.packetHash || !existsSync(statePath) || hash(readFileSync(statePath)) !== build.stateHash) throw Error('Every case needs its retained state build');
    const state = parseRepositoryState(JSON.parse(readFileSync(statePath, 'utf8')));
    for (const name of ['repository-state.json', 'repository-state.receipt.json']) cpSync(join(states, c.id, name), join(directory, 'states', c.id, name));
    manifest.states[c.id] = `states/${c.id}/repository-state.json`;
    manifest.stateBuilds.cases[c.id] = { status: build.status, complete: state.complete, sections: state.sections.length, commit: state.commit };
  }
  cpSync(join(states, 'states.json'), join(directory, 'states/states.json'));
  for (const part of ['code_review_benchmark', 'analysis']) cpSync(join(source, 'upstream/offline', part), join(directory, 'upstream/offline', part), { recursive: true, filter: p => !p.includes('__pycache__') });
  const urls = new Set(cases.map(c => c.url));
  mkdirSync(join(directory, 'upstream/offline/golden_comments'), { recursive: true });
  for (const name of readdirSync(join(source, 'upstream/offline/golden_comments')).filter(n => n.endsWith('.json'))) {
    const selected = JSON.parse(readFileSync(join(source, 'upstream/offline/golden_comments', name))).filter(c => urls.has(c.url));
    if (selected.length) writeFileSync(join(directory, 'upstream/offline/golden_comments', name), JSON.stringify(selected, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  function scan(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) scan(path); else if (e.isFile()) manifest.files[relative(directory, path)] = hash(readFileSync(path)); else throw Error('Unexpected link in frozen experiment');
    }
  }
  for (const name of ['engine', 'baseline', 'cases', 'states', 'upstream']) scan(join(directory, name));
  validatePlan(manifest);
  writeFileSync(join(directory, 'comparison.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, cases: cases.map(c => c.id), trials: trials.length, files: Object.keys(manifest.files).length, manifestHash: hash(readFileSync(join(directory, 'comparison.json'))) };
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  if (process.argv.length !== 5) throw Error('Usage: prepare-state-comparison.mjs <output> <previous-frozen-comparison> <state-builds-directory>');
  console.log(JSON.stringify(prepare(...process.argv.slice(2).map(p => resolve(p)))));
}
