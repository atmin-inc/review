import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture, loadReview, parsePullUrl, readPull, compareCurrent, prepare, sourceText } from '../dist/snapshot.js';
import { defaultPolicy } from '../dist/contracts.js';
import { repository, completed, finding, persist } from './helpers.mjs';

test('prepared snapshots can read unchanged guidance and callers with the remote removed', t => {
  const f = repository(t);
  f.write('AGENTS.md', 'Review source without executing repository commands.\n');
  f.write('caller.ts', 'export const caller = "unchanged caller";\n');
  const baseSha = f.commit('unchanged context');
  f.write('update.ts', 'export const changed = true;\n');
  const headSha = f.commit('reviewed change');
  f.run('config', 'uploadpack.allowFilter', 'true');
  const realGit = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  // Replace only GitHub's transport with a local Git server fixture. All
  // production capture/fetch arguments still run through the real Git binary.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2).map(a => a === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : a === 'https://github.com/test/review-fixture.git' ? ${JSON.stringify('file://' + f.source)} : a);
const r = spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
process.exit(r.status ?? 1);
`, { mode: 0o700 });
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
console.log(JSON.stringify(process.argv.at(-1).includes('/pulls/')
  ? {number: 1, state: 'open', head: {sha: ${JSON.stringify(headSha)}}, base: {ref: 'main', repo: {full_name: 'test/review-fixture'}}}
  : {object: {type: 'commit', sha: ${JSON.stringify(baseSha)}}}));
`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const { directory, packet } = prepare('https://github.com/test/review-fixture/pull/1', join(f.root, 'prepared'));
  const source = join(directory, 'source.git');
  const removed = spawnSync(realGit, ['-C', source, 'remote', 'remove', 'origin'], { encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(sourceText(source, packet.baseSha, 'AGENTS.md'), 'Review source without executing repository commands.\n');
  assert.equal(sourceText(source, packet.headSha, 'caller.ts'), 'export const caller = "unchanged caller";\n');
  assert.equal(loadReview(directory).packet.headSha, headSha);
});

test('capture reads immutable objects despite a dirty checkout', t => {
  const f = repository(t);
  f.write('update.ts', 'dirty unrelated local work\n');
  const actual = capture(f.source, f.state);
  assert.equal(actual.packet.headSha, f.state.headSha);
  assert.equal(actual.packet.mergeBaseSha, f.state.baseSha);
  assert.ok(actual.diff.toString().includes('-  if (owner !== account)'));
  assert.ok(!actual.diff.toString().includes('dirty unrelated'));
  assert.equal(readFileSync(join(f.source, 'update.ts'), 'utf8'), 'dirty unrelated local work\n');
});

test('the target policy wins over a PR that relaxes it', t => {
  const f = repository(t);
  f.run('checkout', '-q', f.state.baseSha);
  f.write('.atmin/review.json', JSON.stringify({ ...defaultPolicy(), requiredChecks: ['tenant-tests'] }));
  const baseSha = f.commit('trusted policy');
  f.write('.atmin/review.json', JSON.stringify({ ...defaultPolicy(), includeOptional: true, requiredChecks: ['nothing-important'] }));
  const headSha = f.commit('proposed policy relaxation');
  const { packet } = capture(f.source, { ...f.state, baseSha, headSha });
  assert.equal(packet.policy.includeOptional, false);
  assert.deepEqual(packet.policy.requiredChecks, ['tenant-tests']);
  assert.deepEqual(packet.changedFiles.map(f => f.path), ['.atmin/review.json']);
});

test('deletions, renames, binary paths and symlinks are explicitly inventoried', t => {
  const f = repository(t);
  f.write('remove.txt', 'old\n');
  f.write('old-name.txt', 'rename\n');
  f.write('binary.dat', Buffer.from([0, 1]));
  const baseSha = f.commit('extended base');
  unlinkSync(join(f.source, 'remove.txt'));
  renameSync(join(f.source, 'old-name.txt'), join(f.source, 'new-name.txt'));
  f.write('binary.dat', Buffer.from([0, 2]));
  symlinkSync('/etc/passwd', join(f.source, 'link'));
  const headSha = f.commit('extended head');
  const { packet } = capture(f.source, { ...f.state, baseSha, headSha });
  const byPath = Object.fromEntries(packet.changedFiles.map(v => [v.path, v]));
  assert.equal(byPath['remove.txt'].change, 'deleted');
  assert.equal(byPath['old-name.txt'].change, 'deleted');
  assert.equal(byPath['new-name.txt'].change, 'added');
  assert.equal(byPath['binary.dat'].kind, 'binary');
  assert.equal(byPath.link.kind, 'symlink');
});

test('filenames are literal, including newlines and pathspec syntax', t => {
  const f = repository(t);
  f.write(':(glob)*.txt', 'literal\n');
  f.write('line\nbreak.txt', 'literal\n');
  const headSha = f.commit('unusual paths');
  const { packet } = capture(f.source, { ...f.state, headSha });
  assert.ok(packet.changedFiles.some(f => f.path === ':(glob)*.txt'));
  assert.ok(packet.changedFiles.some(f => f.path === 'line\nbreak.txt'));
});

test('submodules are recorded without fetching or executing them', t => {
  const f = repository(t);
  f.run('update-index', '--add', '--cacheinfo', `160000,${f.state.baseSha},vendor`);
  f.run('commit', '-qm', 'gitlink fixture');
  const headSha = f.run('rev-parse', 'HEAD');
  const { packet } = capture(f.source, { ...f.state, headSha });
  assert.equal(packet.changedFiles.find(f => f.path === 'vendor').kind, 'submodule');
});

test('external diff and textconv programs never execute during capture', t => {
  const f = repository(t);
  const sentinel = join(f.root, 'executed');
  f.run('config', 'diff.evil.command', `touch ${sentinel}`);
  f.run('config', 'diff.evil.textconv', `touch ${sentinel}`);
  f.write('.gitattributes', '*.ts diff=evil\n');
  const headSha = f.commit('hostile attributes');
  capture(f.source, { ...f.state, headSha });
  assert.equal(existsSync(sentinel), false);
});

test('current target ref is fetched separately from stale PR base metadata', t => {
  const f = repository(t);
  const requests = [];
  const state = readPull('test/review-fixture', 1, endpoint => {
    requests.push(endpoint);
    return endpoint.includes('/pulls/')
      ? { number: 1, state: 'open', head: { sha: f.state.headSha }, base: { sha: 'a'.repeat(40), ref: 'release/next', repo: { full_name: 'test/review-fixture' } } }
      : { object: { type: 'commit', sha: f.state.baseSha } };
  });
  assert.equal(state.baseSha, f.state.baseSha);
  assert.equal(requests[1], 'repos/test/review-fixture/git/ref/heads/release%2Fnext');
});

test('head movement, target movement, retargeting and closed PR all supersede', t => {
  const f = repository(t);
  assert.equal(compareCurrent(f.packet, f.state).status, 'current');
  for (const change of [{ headSha: 'a'.repeat(40) }, { baseSha: 'a'.repeat(40) }, { baseRef: 'different' }, { state: 'closed' }, { pr: 2 }]) {
    assert.equal(compareCurrent(f.packet, { ...f.state, ...change }).status, 'superseded');
  }
});

test('malformed PR destinations are rejected before access', () => {
  for (const url of ['https://evil.invalid/o/r/pull/1', 'http://github.com/o/r/pull/1', 'https://user:secret@github.com/o/r/pull/1',
    'https://github.com/o/r/pull/1?redirect=1', 'https://github.com/o/r/pull/0', 'https://github.com/o/r/pull/9007199254740992']) {
    assert.throws(() => parsePullUrl(url));
  }
  assert.deepEqual(parsePullUrl('https://github.com/test/review-fixture/pull/1'), { repository: 'test/review-fixture', pr: 1 });
});

test('render loading verifies immutable anchors, inventory and policy', t => {
  const f = repository(t);
  const result = completed(f.packet);
  result.findings = [finding()];
  const directory = persist(f, result);
  assert.equal(loadReview(directory).result.findings.length, 1);
  // JSON member order is not part of the public contract.
  writeFileSync(join(directory, 'packet.json'), JSON.stringify(Object.fromEntries(Object.entries(f.packet).reverse())));
  assert.equal(loadReview(directory).result.findings.length, 1);
  result.findings[0].anchor.line = 1000;
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result));
  assert.throws(() => loadReview(directory), /outside its immutable source/);
  result.findings[0].anchor.line = 2;
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result));
  f.packet.changedFiles = [];
  writeFileSync(join(directory, 'packet.json'), JSON.stringify(f.packet));
  assert.throws(() => loadReview(directory), /Packet differs/);
});

test('a symlink policy is rejected without following its destination', t => {
  const f = repository(t);
  f.write('.atmin/placeholder', 'fixture');
  symlinkSync('/etc/passwd', join(f.source, '.atmin/review.json'));
  const baseSha = f.commit('invalid policy');
  f.write('update.ts', 'changed\n');
  const headSha = f.commit('later change');
  assert.throws(() => capture(f.source, { ...f.state, baseSha, headSha }), /policy must be a regular file/);
});

test('current target advancement does not add target-only changes to the PR diff', t => {
  const f = repository(t);
  f.run('checkout', '-q', f.state.baseSha);
  f.write('target-only.txt', 'target branch change\n');
  const baseSha = f.commit('advance target');
  const { packet } = capture(f.source, { ...f.state, baseSha });
  assert.equal(packet.mergeBaseSha, f.state.baseSha);
  assert.equal(packet.baseSha, baseSha);
  assert.deepEqual(packet.changedFiles.map(f => f.path), ['update.ts']);
});

test('saved diff corruption is rejected', t => {
  const f = repository(t);
  const directory = persist(f);
  writeFileSync(join(directory, 'change.diff'), 'edited diff');
  assert.throws(() => loadReview(directory), /Saved diff differs/);
});

test('file-level evidence covers an empty file without inventing a source line', t => {
  const f = repository(t);
  f.write('empty.ts', '');
  f.state.headSha = f.commit('empty source file');
  Object.assign(f, capture(f.source, f.state));
  const result = completed(f.packet);
  const emptyEvidence = result.evidence.find(e => e.anchors[0].path === 'empty.ts');
  emptyEvidence.anchors[0].line = null;
  const directory = persist(f, result);
  assert.equal(loadReview(directory).result.status, 'completed');
  emptyEvidence.anchors[0].line = 1;
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result));
  assert.throws(() => loadReview(directory), /outside its immutable source/);
});

test('binary file coverage cannot be silently declared complete', t => {
  const f = repository(t);
  f.write('bytes.bin', Buffer.from([0, 255]));
  f.state.headSha = f.commit('binary addition');
  Object.assign(f, capture(f.source, f.state));
  const directory = persist(f, completed(f.packet));
  assert.throws(() => loadReview(directory), /non-text paths/);
});

test('CLI renders the initial packet honestly and refuses to overwrite artifacts', t => {
  const f = repository(t);
  const directory = persist(f);
  const cli = new URL('../dist/cli.js', import.meta.url);
  const invoke = args => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
  const rendered = invoke(['render', directory, '--format', 'json']);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(JSON.parse(rendered.stdout).assessment.outcome, 'Review incomplete');
  assert.equal(JSON.parse(rendered.stdout).assessment.freshness.status, 'unverified');
  assert.equal(invoke(['render', directory, '--out', join(directory, 'packet.json')]).status, 1);
  assert.equal(invoke(['review', 'https://github.com/test/review-fixture/pull/1']).status, 1);
  assert.equal(invoke(['render', directory, '--publish']).status, 1);
});
