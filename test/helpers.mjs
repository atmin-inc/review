import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capture, git } from '../dist/snapshot.js';
import { initialResult } from '../dist/contracts.js';

export function finalReport(overrides = {}) {
  return { complete: true, limitations: [],
    quality: { score: 3, rationale: 'Fixture has unresolved verification questions.', conventionRules: [],
      criteria: Object.fromEntries(['codebaseFit', 'simplicity', 'verification', 'documentedConventions'].map(key =>
        [key, { status: 'unknown', reason: 'Not assessed by this deterministic fixture.', evidenceIds: [] }])) }, ...overrides };
}

export function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'atmin-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'work');
  mkdirSync(source);
  const run = (...args) => git(source, args).toString('utf8').trim();
  run('init', '--initial-branch=main', '--template=');
  run('config', 'user.name', 'Review fixture');
  run('config', 'user.email', 'fixture@example.invalid');
  run('config', 'commit.gpgsign', 'false');
  const write = (path, contents) => {
    const full = join(source, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  };
  const commit = message => { run('add', '-A'); run('commit', '-qm', message); return run('rev-parse', 'HEAD'); };
  write('update.ts', 'export function update(owner, account) {\n  if (owner !== account) throw new Error("forbidden");\n  return "updated";\n}\n');
  // The default policy requires no CI; this fixture opts in so CI handling stays under test.
  write('.atmin/review.json', JSON.stringify({ schemaVersion: 1, rubricVersion: '1', includeOptional: false, requiredChecks: ['change-validation'] }));
  const baseSha = commit('fixture base');
  write('update.ts', 'export function update(owner, account) {\n  return "updated";\n}\n');
  const headSha = commit('fixture head');
  const state = { repository: 'test/review-fixture', pr: 1, baseRef: 'main', baseSha, headSha, state: 'open' };
  const captured = capture(source, state);
  return { root, source, run, write, commit, state, ...captured };
}

export function completed(packet) {
  const result = initialResult(packet);
  result.status = 'completed';
  result.reviewer = { name: 'Test fixture — not a real review', model: 'fixture', context: 'independent' };
  result.summary = 'Explicit deterministic fixture. No model was invoked.';
  result.limitations = ['Fixture evidence is not a live model or test result.'];
  result.coverage = packet.changedFiles.map((f, i) => ({ path: f.path, status: 'reviewed', evidenceIds: [`source-${i}`] }));
  result.evidence = packet.changedFiles.map((f, i) => ({ id: `source-${i}`, kind: 'source-reasoning', provenance: 'declared',
    summary: 'Fixture declares inspection of the changed source.', anchors: [{ path: f.path, side: f.change === 'deleted' ? 'base' : 'head', line: 1 }] }));
  result.validation = packet.policy.requiredChecks.map(name => ({ name, status: 'not-applicable', reason: 'Synthetic assessment fixture; no runtime check applies.', evidenceIds: [] }));
  return result;
}

export function finding(priority = 'P1') {
  return { id: 'missing-owner-guard', priority, kind: priority === 'P4' ? 'improvement' : 'defect', category: 'security',
    title: 'Account owner guard removed', trigger: 'A different account submits a known record ID.',
    consequence: 'The update reaches a record owned by another account.',
    priorityReason: 'Fixture priority; production priority requires concrete impact and reachability reasoning.',
    counterEvidence: 'The fixture has no caller-side authorization guard.', suggestion: 'Check record ownership before the update.',
    anchor: { path: 'update.ts', side: 'head', line: 2 }, evidenceIds: ['source-0'] };
}

export function persist(fixture, result = initialResult(fixture.packet)) {
  const directory = join(fixture.root, 'run');
  mkdirSync(directory, { mode: 0o700 });
  cpSync(join(fixture.source, '.git'), join(directory, 'source.git'), { recursive: true });
  git(join(directory, 'source.git'), ['config', 'core.bare', 'true']);
  writeFileSync(join(directory, 'packet.json'), JSON.stringify(fixture.packet));
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result));
  writeFileSync(join(directory, 'change.diff'), fixture.diff);
  return directory;
}
export const current = () => ({ status: 'current', reason: 'Fixture live check matched.', checkedAt: '2026-09-09T12:00:00.000Z' });

// A runner for worker tests: `run(job, signal, previous, to)` reviews where a runner would and
// returns a directory whose records are copied into the run directory the worker chose, or
// throws. It delivers before the worker's next step, unless `background`, when the worker finds
// the job still dispatched and collects on a later tick.
export function inline(run, { background = false, own = () => null } = {}) {
  const outcomes = new Map(), controllers = new Map(), closed = new Set(), offered = [];
  return {
    offered,
    ownRunner: own,
    async offer(job, to, directory, previous) {
      offered.push({ job: job.id, to });
      const controller = new AbortController();
      controllers.set(job.id, controller); outcomes.delete(job.id); closed.delete(job.id);
      const delivered = (async () => {
        try {
          const out = await run(job, controller.signal, previous, to);
          if (out !== directory) cpSync(out, directory, { recursive: true });
          if (!controller.signal.aborted) outcomes.set(job.id, 'done');
        } catch { if (!controller.signal.aborted) outcomes.set(job.id, 'failed'); }
      })();
      if (!background) await delivered;
    },
    poll: job => closed.has(job.id) ? 'cancelled' : outcomes.get(job.id) ?? null,
    close: job => { controllers.get(job.id)?.abort(); closed.add(job.id); },
    open: () => [...controllers.keys()].filter(id => !closed.has(id)),
  };
}
