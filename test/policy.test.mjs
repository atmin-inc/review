import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALANCED, decide, findingsFrom, policyRejection } from '../dist/policy.js';
import { composeChain } from '../dist/evidence.js';

const finding = over => ({ claimId: 'c-1', type: 'contract_break', severity: 'P2', confidence: 'moderate', routedToHuman: false, ...over });

test('an empty review merges, and the fallback is named like any other rule', () => {
  const decision = decide([], BALANCED);
  assert.equal(decision.verdict, 'merge');
  assert.equal(decision.rule, 'nothing-survived-verification');
});

// Rule order is the policy. A P0 and a nit in the same review must not resolve to
// nits because the nit rule happens to match too.
test('the first matching rule wins, not the last or the most specific', () => {
  const decision = decide([finding({ claimId: 'c-nit', severity: 'P3' }),
    finding({ claimId: 'c-bad', severity: 'P0', confidence: 'high' })], BALANCED);
  assert.equal(decision.verdict, 'block');
  assert.equal(decision.rule, 'catastrophic-defect');
  assert.deepEqual(decision.matched, ['c-bad']);
});

// The confidence cap has teeth only if the policy reads it. A P1 the ladder could
// not raise above moderate must not block on its own.
test('a serious defect blocks only once the evidence is there', () => {
  assert.equal(decide([finding({ severity: 'P1', confidence: 'high' })], BALANCED).verdict, 'block');
  assert.equal(decide([finding({ severity: 'P1', confidence: 'moderate' })], BALANCED).verdict, 'security_review');
  assert.equal(decide([finding({ severity: 'P1', confidence: 'low' })], BALANCED).verdict, 'nits');
});

test('a P0 blocks from moderate confidence, unlike a P1', () => {
  assert.equal(decide([finding({ severity: 'P0', confidence: 'moderate' })], BALANCED).verdict, 'block');
  assert.equal(decide([finding({ severity: 'P0', confidence: 'low' })], BALANCED).verdict, 'nits');
});

test('a security surface routes to review whatever its severity', () => {
  const decision = decide([finding({ type: 'injection_risk', severity: 'P3', confidence: 'low' })], BALANCED);
  assert.equal(decision.verdict, 'security_review');
  assert.equal(decision.rule, 'security-surface');
});

test('counting rules need their quorum', () => {
  assert.equal(decide([finding({ severity: 'P2' })], BALANCED).rule, 'any-remaining-finding');
  const two = decide([finding({ claimId: 'a', severity: 'P2' }), finding({ claimId: 'b', severity: 'P2' })], BALANCED);
  assert.equal(two.rule, 'several-localized-defects');
  assert.deepEqual(two.matched, ['a', 'b']);
});

// Only what survived verification drives the verdict. A wide investigator is only
// safe if refuted and inconclusive claims cannot reach a user as findings.
test('refuted and inconclusive claims never become findings', () => {
  const chains = [
    composeChain('c-confirmed', 'P1', [{ rung: 'symbolic', check: 'ast', result: 'hit' }]),
    composeChain('c-refuted', 'P0', [{ rung: 'symbolic', check: 'ast', result: 'miss' }]),
    composeChain('c-unresolved', 'P0', [{ rung: 'cross_family_llm', check: 'jev', result: 0.5 }]),
  ];
  const findings = findingsFrom(chains, () => 'contract_break');
  assert.deepEqual(findings.map(f => f.claimId), ['c-confirmed']);
  assert.equal(decide(findings, BALANCED).verdict, 'security_review');
});

// Replayability is the reason composition is code: a threshold change has to
// recompute verdicts over stored evidence without re-running any inference.
test('a policy change recomputes the verdict from the same stored evidence', () => {
  const stored = [finding({ severity: 'P1', confidence: 'moderate' })];
  assert.equal(decide(stored, BALANCED).verdict, 'security_review');
  const stricter = { name: 'correctness-first',
    rules: [{ name: 'any-serious-defect', verdict: 'block', any: { severityIn: ['P0', 'P1'] } },
      { name: 'clean', verdict: 'merge', otherwise: true }] };
  assert.equal(decide(stored, stricter).verdict, 'block');
  assert.deepEqual(stored, [finding({ severity: 'P1', confidence: 'moderate' })], 'deciding must not mutate stored evidence');
});

test('a policy that could answer nothing is rejected rather than defaulted', () => {
  assert.equal(policyRejection(BALANCED), null);
  assert.match(policyRejection({ name: 'x', rules: [] }), /at least one rule/);
  assert.match(policyRejection({ name: 'x', rules: [{ name: 'a', verdict: 'nits', any: {} }] }), /needs a fallback/);
  assert.match(policyRejection({ name: 'x', rules: [{ name: 'a', verdict: 'merge', otherwise: true },
    { name: 'b', verdict: 'nits', any: {} }] }), /must be last/);
  assert.match(policyRejection({ name: 'x', rules: [{ name: 'a', verdict: 'nits', any: {} },
    { name: 'a', verdict: 'merge', otherwise: true }] }), /unique/);
  assert.throws(() => decide([], { name: 'partial', rules: [{ name: 'a', verdict: 'nits', any: { severityIn: ['P0'] } }] }), /not total/);
});
