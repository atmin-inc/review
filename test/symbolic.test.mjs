import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, runChecks } from '../dist/symbolic.js';
import { composeChain } from '../dist/evidence.js';

// A revision backed by literal source, searched the way git grep searches frozen
// blobs: whole revision, literal query, capped result set.
const revisionOf = (files, cap = 50) => ({
  search(query) {
    const matches = [];
    for (const [path, text] of Object.entries(files)) {
      text.split('\n').forEach((line, index) => { if (line.includes(query)) matches.push({ path, line: index + 1 }); });
    }
    return { matches: matches.slice(0, cap), truncated: matches.length > cap };
  },
  lineAt(path, line) { return files[path]?.split('\n')[line - 1] ?? null; },
  slice(path, startLine, count) {
    const lines = files[path]?.split('\n');
    return lines ? lines.slice(startLine - 1, startLine - 1 + count).join('\n') : null;
  },
});

// The audited gap from case-042: all four reviews missed a reachable optional-member
// dereference because the declaration sat at model.py:346, below a prefix read that
// ended at line 200. Rung 1 does not read prefixes, so the prefix cannot hide it.
test('a declaration below the read prefix is still found', () => {
  const model = [...Array(345).fill('# padding'), '    member: Optional[RpcOrganizationMember] = None', ''].join('\n');
  const outcome = runCheck(revisionOf({ 'model.py': model }), { assertion: 'declaration_contains', symbol: 'member', pattern: 'Optional' });
  assert.equal(outcome.evidence[0].result, 'hit');
  assert.match(outcome.evidence[0].check, /model\.py:346/);
  assert.deepEqual(outcome.limitations, []);
});

// The audited gap from case-015: a review claimed an enum starts at zero and proposed
// changing a correct migration. The repository starts it at one, and that is a
// deterministic fact, so the claim should die on rung 1 rather than reach a user.
test('a wrong framework assumption is refuted, not argued with', () => {
  const revision = revisionOf({ 'enums.rb': 'class Status\n  FIRST = 1\n  SECOND = 2\nend\n' });
  const outcome = runCheck(revision, { assertion: 'declaration_contains', symbol: 'FIRST', pattern: '= 0' });
  assert.equal(outcome.evidence[0].result, 'miss');
  const chain = composeChain('c-1', 'P2', outcome.evidence);
  assert.equal(chain.verdict, 'refuted');
  assert.equal(chain.verifierConfidence, 'high');
});

// A miss refutes outright, so a check that merely failed to look far enough must
// never report one. This is the difference between "I established the negative" and
// "I ran out of budget", and conflating them turns a cap into a false refutation.
test('a truncated search is inconclusive, never a refutation', () => {
  const noisy = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.py`, 'call(member)']));
  const outcome = runCheck(revisionOf(noisy, 50), { assertion: 'declaration_contains', symbol: 'member', pattern: 'Optional' });
  assert.deepEqual(outcome.evidence, []);
  assert.match(outcome.limitations[0], /truncated/);
});

test('a symbol absent from the revision is inconclusive, not a refutation', () => {
  const outcome = runCheck(revisionOf({ 'a.py': 'x = 1\n' }), { assertion: 'declaration_contains', symbol: 'missing', pattern: 'Optional' });
  assert.deepEqual(outcome.evidence, []);
  assert.match(outcome.limitations[0], /no declaration/);
});

test('a declaration found but not matching reports where it looked', () => {
  const outcome = runCheck(revisionOf({ 'a.py': 'value = 1\n' }), { assertion: 'declaration_contains', symbol: 'value', pattern: '= 9' });
  assert.equal(outcome.evidence[0].result, 'miss');
  assert.match(outcome.evidence[0].check, /a\.py:1/);
});

test('external references are established or ruled out', () => {
  const files = { 'api.ts': 'export function send(x) {}\n', 'caller.ts': 'send(1);\n' };
  assert.equal(runCheck(revisionOf(files), { assertion: 'referenced_outside', symbol: 'send', path: 'api.ts' }).evidence[0].result, 'hit');
  assert.equal(runCheck(revisionOf({ 'api.ts': files['api.ts'] }), { assertion: 'referenced_outside', symbol: 'send', path: 'api.ts' }).evidence[0].result, 'miss');
});

test('a truncated reference search cannot rule out external callers', () => {
  const noisy = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`api.ts`, 'send(1);\n'.repeat(60)]));
  const outcome = runCheck(revisionOf(noisy, 50), { assertion: 'referenced_outside', symbol: 'send', path: 'api.ts' });
  assert.deepEqual(outcome.evidence, []);
  assert.match(outcome.limitations[0], /truncated/);
});

test('checks compose into one outcome', () => {
  const revision = revisionOf({ 'a.py': 'value = 1\n', 'b.py': 'print(value)\n' });
  const outcome = runChecks(revision, [
    { assertion: 'declaration_contains', symbol: 'value', pattern: '= 1' },
    { assertion: 'referenced_outside', symbol: 'value', path: 'a.py' },
  ]);
  assert.deepEqual(outcome.evidence.map(e => e.result), ['hit', 'hit']);
});

// Most review claims are about absence: a guard removed, a null check missing, a
// bound never applied. Without an expectation the check can only support claims
// about what IS there, so every true absence claim would read as refuted.
test('an absence claim is supported by absence, not refuted by it', () => {
  const guarded = revisionOf({ 'a.ts': 'function update(owner, account) {\n  if (owner !== account) throw new Error("no");\n}\n' });
  const unguarded = revisionOf({ 'a.ts': 'function update(owner, account) {\n  return "updated";\n}\n' });
  const check = { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' };
  assert.equal(runCheck(unguarded, check).evidence[0].result, 'hit', 'the guard really is gone');
  assert.equal(runCheck(guarded, check).evidence[0].result, 'miss', 'the guard is there, so the claim is wrong');
  assert.match(runCheck(unguarded, check).evidence[0].check, /lacks/);
});

test('an unreferenced expectation reads the other way too', () => {
  const files = { 'api.ts': 'export function send(x) {}\n', 'caller.ts': 'send(1);\n' };
  const dead = { assertion: 'referenced_outside', symbol: 'send', path: 'api.ts', expect: 'absent' };
  assert.equal(runCheck(revisionOf(files), dead).evidence[0].result, 'miss', 'it has a caller, so it is not dead');
  assert.equal(runCheck(revisionOf({ 'api.ts': files['api.ts'] }), dead).evidence[0].result, 'hit');
});

// The first false-positive mechanism from the 2026-09-14 audit, in the one place this
// rung could still commit it. A symbol can be declared more than once, and inspecting
// whichever declaration turned up first would let one body stand in for all of them —
// the same error as reading a module to line 180 and concluding that an initialization
// at 218 does not exist.
test('absence must hold across every declaration, not the first one found', () => {
  const files = {
    'iface.ts': 'function update(owner, account) {\n  return null;\n}\n',
    'impl.ts': 'function update(owner, account) {\n  if (owner !== account) throw new Error("no");\n  return "ok";\n}\n',
  };
  const check = { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' };
  const outcome = runCheck(revisionOf(files), check);
  assert.equal(outcome.evidence[0].result, 'miss', 'the guard exists in one of the two bodies, so it is not gone');
  assert.match(outcome.evidence[0].check, /2 declarations/);

  const present = runCheck(revisionOf(files), { ...check, expect: 'present' });
  assert.equal(present.evidence[0].result, 'hit');
  assert.match(present.evidence[0].check, /impl\.ts:1/, 'the evidence points at the body that actually contains it');
});

// A body that ran past the cap is not a body that lacks the pattern. Absence stays
// unestablished rather than becoming a refutation of whatever the claim needed.
test('a declaration body cut off at the cap cannot establish absence for the set', () => {
  const long = ['function update() {', ...Array(250).fill('  step();'), '}'].join('\n');
  const files = { 'short.ts': 'function update() {\n  return 1;\n}\n', 'long.ts': long };
  const outcome = runCheck(revisionOf(files), { assertion: 'body_contains', symbol: 'update', pattern: 'guard', expect: 'absent' });
  assert.deepEqual(outcome.evidence, []);
  assert.match(outcome.limitations[0], /could not be inspected in full/);
});
