import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repository } from './helpers.mjs';
import { assignClaimIds } from '../dist/claim.js';
import { revisionFrom } from '../dist/symbolic.js';
import { verifyClaims } from '../dist/lifecycle.js';
import { BALANCED } from '../dist/policy.js';
import { sourceText } from '../dist/snapshot.js';

// The fixture's head removes an ownership guard: update(owner, account) no longer
// compares them. One claim about it is true, one is not, and neither the investigator
// nor a model gets to decide which — the revision does.
const TRUE_CLAIM = {
  type: 'auth_bypass', location: 'update.ts:2',
  description: 'update() returns without comparing owner to account.',
  suspectedCondition: 'A different account submits a known record id.',
  severity: 'P1', evidenceToCheck: ['No ownership comparison remains in the function body.'],
  symbolicChecks: [{ assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' }],
};
const FALSE_CLAIM = {
  type: 'contract_break', location: 'update.ts:1',
  description: 'update() is called from other modules that assume the old signature.',
  suspectedCondition: 'Another module calls update() and relies on the throw.',
  severity: 'P1', evidenceToCheck: ['update is referenced outside update.ts.'],
  symbolicChecks: [{ assertion: 'referenced_outside', symbol: 'update', path: 'update.ts' }],
};

const run = (t, claims, crossFamily) => {
  const fixture = repository(t);
  const revision = revisionFrom(fixture.source, fixture.packet.headSha);
  const withIds = assignClaimIds(claims, path => sourceText(fixture.source, fixture.packet.headSha, path));
  return { ...verifyClaims(withIds, revision, BALANCED, crossFamily), claims: withIds };
};

// The whole architecture in one pass over a real Git revision: a wide investigator
// emits both claims, rung 1 settles each against the frozen source, and code composes
// the verdict from what survived.
test('a true claim survives verification and a false one dies on rung 1', t => {
  const { chains, decision, claims } = run(t, [TRUE_CLAIM, FALSE_CLAIM]);

  const [confirmed, refuted] = chains;
  assert.equal(confirmed.verdict, 'confirmed');
  assert.equal(confirmed.verifierConfidence, 'moderate', 'one rung alone never reaches high');
  assert.match(confirmed.evidence[0].check, /body of `update` lacks/);

  assert.equal(refuted.verdict, 'refuted');
  assert.equal(refuted.verifierConfidence, 'high', 'nothing references update outside its own file');

  assert.equal(decision.verdict, 'security_review');
  assert.equal(decision.rule, 'security-surface');
  assert.deepEqual(decision.matched, [claims[0].claimId], 'only the surviving claim reaches the verdict');
});

// The claim the reviewer got wrong never becomes a finding, and its chain is still
// kept. That is what makes wide investigation safe rather than noisy.
test('a refuted claim keeps its chain but reaches no user', t => {
  const { chains, decision } = run(t, [FALSE_CLAIM]);
  assert.equal(chains[0].verdict, 'refuted');
  assert.ok(chains[0].evidence.length, 'a refuted claim still ships a chain');
  assert.equal(decision.verdict, 'merge');
  assert.equal(decision.rule, 'nothing-survived-verification');
});

test('cross-family agreement raises a deterministic hit to high, and blocks', t => {
  const agreeing = { check: () => [{ rung: 'cross_family_llm', check: 'jev noul touches_auth', result: 0.94 }] };
  const { chains, decision } = run(t, [TRUE_CLAIM], agreeing);
  assert.equal(chains[0].verifierConfidence, 'high');
  assert.equal(decision.verdict, 'block');
  assert.equal(decision.rule, 'serious-defect-established');
});

// Rule 4 as it actually runs: the cross-family rung is never reached for a claim a
// symbolic check already refuted, so no model is invited to argue with the code.
test('a claim refuted on rung 1 never reaches the cross-family rung', t => {
  let asked = 0;
  const counting = { check: () => { asked++; return [{ rung: 'cross_family_llm', check: 'jev', result: 0.99 }]; } };
  const { chains } = run(t, [FALSE_CLAIM], counting);
  assert.equal(asked, 0);
  assert.equal(chains[0].verdict, 'refuted');
});

test('a claim no rung can touch is inconclusive, not quietly confirmed', t => {
  const { chains, decision } = run(t, [{ ...TRUE_CLAIM, symbolicChecks: [] }]);
  assert.equal(chains[0].verdict, 'inconclusive');
  assert.equal(chains[0].verifierConfidence, 'low');
  assert.match(chains[0].limitations[0], /No rung produced evidence/);
  assert.equal(decision.verdict, 'merge');
});

test('an unusable policy fails loudly rather than producing a verdict', t => {
  const fixture = repository(t);
  const revision = revisionFrom(fixture.source, fixture.packet.headSha);
  assert.throws(() => verifyClaims([], revision, { name: 'no-fallback', rules: [] }), /is unusable/);
});
