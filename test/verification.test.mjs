import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxArguments, sandboxCheck, verifyReview, readVerification } from '../dist/verification.js';
import { capture, sourceSlice, hash } from '../dist/snapshot.js';
import { repository, completed, finding, persist } from './helpers.mjs';

function fixture(t) {
  const f = repository(t);
  f.run('checkout', '--detach', f.packet.baseSha);
  f.write('check.mjs', `import assert from 'node:assert/strict';\nimport {update} from './update.ts';\nassert.equal(update('alice','alice'),'updated');\nassert.throws(()=>update('alice','bob'), /forbidden/);\n`);
  const baseSha = f.commit('trusted test fixture');
  f.write('update.ts', 'export function update(owner, account) {\n  return "updated";\n}\n');
  const headSha = f.commit('remove guard');
  Object.assign(f, capture(f.source, { ...f.state, baseSha, headSha }));
  const result = completed(f.packet), { text, ...range } = sourceSlice(f.source, headSha, 'update.ts', 1, 3);
  result.evidence = [{ id: 'source-0', kind: 'source-read', provenance: 'controller-captured', summary: 'Captured fixture source',
    anchors: [{ path: 'update.ts', side: 'head', line: 1 }], capture: range }];
  result.findings = [{ ...finding(), fix: { startLine: 2, endLine: 2, original: '  return "updated";',
    replacement: '  if (owner !== account) throw new Error("forbidden");\n  return "updated";' } }];
  return { ...f, result, directory: persist(f, result) };
}
const check = { repositoryId: 42, name: 'ownership', argv: ['node', 'check.mjs'] };

test('isolated worker mounts only runtime/source, clears credentials and disables network', () => {
  const args = sandboxArguments('/private/snapshot', check.argv, '/opt/node/bin/node');
  assert.ok(args.includes('--unshare-all')); assert.ok(args.includes('--clearenv'));
  assert.ok(args.includes('--new-session')); assert.ok(args.includes('--die-with-parent'));
  assert.ok(args.includes('--size')); assert.ok(args.includes('67108864'));
  assert.ok(!args.includes('--bind')); assert.ok(!args.includes('/etc')); assert.ok(!args.includes('/home'));
  assert.deepEqual(args.slice(-3), ['--', '/opt/node/bin/node', 'check.mjs']);
});

test('execution observations cannot follow a different commit or modified patch', t => {
  const f = fixture(t), checks = [{ name: 'ownership', status: 'pass', reason: 'Synthetic check observation.' }];
  const digest = hash(JSON.stringify({ path: 'update.ts', fix: f.result.findings[0].fix }));
  const report = { schemaVersion: 1, headSha: f.packet.headSha, baseSha: f.packet.baseSha, checks,
    fixes: [{ findingId: f.result.findings[0].id, digest, checks }] };
  writeFileSync(join(f.directory, 'verification.json'), JSON.stringify(report));
  assert.equal(readVerification(f.directory, f.packet, f.result.findings).fixes.length, 1);
  const changed = structuredClone(f.result.findings); changed[0].fix.replacement += '\n// changed';
  assert.equal(readVerification(f.directory, f.packet, changed).fixes.length, 0);
  assert.equal(readVerification(f.directory, { ...f.packet, headSha: 'a'.repeat(40) }, f.result.findings).checks.length, 0);
  report.checks[0].status = 'invented'; writeFileSync(join(f.directory, 'verification.json'), JSON.stringify(report));
  assert.equal(readVerification(f.directory, f.packet, f.result.findings).checks.length, 0);
});

test('Linux worker reproduces the defect and verifies its exact patch in separate isolated executions', { skip: process.env.ATMIN_REVIEW_VERIFY_LINUX !== '1' }, async t => {
  const f = fixture(t), signal = new AbortController().signal;
  const result = await verifyReview(f.directory, [check], signal);
  assert.equal(result.checks[0].status, 'fail');
  assert.equal(result.fixes[0].checks[0].status, 'pass');
  assert.equal(readVerification(f.directory, f.packet, f.result.findings).fixes[0].checks[0].status, 'pass');
  assert.ok(!readdirSync(f.directory).some(name => name.startsWith('check-workspace-')));
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'result.json'))).findings[0].fix.replacement, f.result.findings[0].fix.replacement);
  const isolation = { ...check, argv: ['node', '-e', `const fs=require('node:fs'),assert=require('node:assert/strict');
    assert.equal(fs.existsSync('/etc/atmin-review/service.env'),false);
    assert.equal(fs.existsSync('/home'),false); assert.equal(fs.existsSync('/proc'),false); assert.equal(process.env.OPENROUTER_API_KEY,undefined);
    assert.throws(()=>fs.writeFileSync('escaped','no'), /EROFS/);
    const socket=require('node:net').connect(8787,'127.0.0.1');
    socket.on('connect',()=>process.exit(1));socket.on('error',()=>process.exit(0));`] };
  assert.equal((await sandboxCheck(f.source, isolation, signal)).status, 'pass');
  assert.equal((await sandboxCheck(f.source, { ...check, argv: ['node', '-e', 'setInterval(()=>{},1000)'] }, signal, 200)).status, 'fail');
  assert.equal((await sandboxCheck(f.source, check, AbortSignal.abort())).status, 'not-run');
});
