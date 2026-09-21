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
  severity: 'P1',
  evidenceToCheck: [
    { proposition: 'No ownership comparison remains in the function body.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } },
    { proposition: 'No other module wraps update() with its own ownership check.',
      check: { assertion: 'referenced_outside', symbol: 'update', path: 'update.ts', expect: 'absent' } },
  ],
};
const FALSE_CLAIM = {
  type: 'contract_break', location: 'update.ts:1',
  description: 'update() is called from other modules that assume the old signature.',
  suspectedCondition: 'Another module calls update() and relies on the throw.',
  severity: 'P1',
  evidenceToCheck: [
    { proposition: 'update is referenced outside update.ts.',
      check: { assertion: 'referenced_outside', symbol: 'update', path: 'update.ts' } },
  ],
};

const revisionsOf = fixture => ({
  head: revisionFrom(fixture.source, fixture.packet.headSha),
  base: revisionFrom(fixture.source, fixture.packet.mergeBaseSha),
});
const run = (t, claims, crossFamily) => {
  const fixture = repository(t);
  const withIds = assignClaimIds(claims, path => sourceText(fixture.source, fixture.packet.headSha, path));
  return { ...verifyClaims(withIds, revisionsOf(fixture), BALANCED, crossFamily), claims: withIds };
};

// The whole architecture in one pass over a real Git revision: a wide investigator
// emits both claims, rung 1 settles each against the frozen source, and code composes
// the verdict from what survived.
test('a true claim survives verification and a false one dies on rung 1', t => {
  const { chains, decision, claims } = run(t, [TRUE_CLAIM, FALSE_CLAIM]);

  const [confirmed, refuted] = chains;
  assert.equal(confirmed.verdict, 'confirmed');
  assert.equal(confirmed.verifierConfidence, 'moderate', 'one rung alone never reaches high');
  assert.equal(confirmed.evidence.length, 2, 'every proposition is settled on its own');
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
  const agreeing = { settle: proposition => [{ rung: 'cross_family_llm', check: `jev noul: ${proposition}`, result: 0.94 }] };
  const { chains, decision } = run(t, [TRUE_CLAIM], agreeing);
  assert.equal(chains[0].verifierConfidence, 'high');
  assert.equal(decision.verdict, 'block');
  assert.equal(decision.rule, 'serious-defect-established');
});

// Rule 4 as it actually runs: the cross-family rung is never reached for a claim a
// symbolic check already refuted, so no model is invited to argue with the code.
test('a claim refuted on rung 1 never reaches the cross-family rung', t => {
  let asked = 0;
  const counting = { settle: () => { asked++; return [{ rung: 'cross_family_llm', check: 'jev', result: 0.99 }]; } };
  const { chains } = run(t, [FALSE_CLAIM], counting);
  assert.equal(asked, 0);
  assert.equal(chains[0].verdict, 'refuted');
});

// The architecture's load-bearing rule. A grep settles a syntactic fact: the guard
// text is gone. The claim is semantic: any account can update any record. Those are
// not the same statement, and the gap between them is the remaining propositions. A
// step no rung reached leaves the argument unfinished, so the claim does not ship.
test('an argument with a step no rung reached does not ship', t => {
  const partial = {
    ...TRUE_CLAIM,
    evidenceToCheck: [TRUE_CLAIM.evidenceToCheck[0],
      { proposition: 'The endpoint is reachable by an account that does not own the record.' }],
  };
  const { chains, decision } = run(t, [partial]);

  assert.equal(chains[0].verdict, 'inconclusive');
  assert.deepEqual(chains[0].suspectChecks, [], 'an unfinished argument accuses no check');
  assert.equal(chains[0].evidence.length, 1, 'what was established is still recorded');
  assert.match(chains[0].limitations[0], /1 of 2 propositions were not settled/);
  assert.match(chains[0].limitations[1], /reachable by an account/);
  assert.equal(decision.verdict, 'merge');
});

// The recall path, and the reason rung 3 asks about a proposition rather than a claim.
// "Is this an auth bypass?" is the composite judgment the smoke test found mushy.
// "Is the endpoint reachable by an account that does not own the record?" is a factual
// question, and it is exactly the step no grep can express. Settling it that way ships
// the claim, capped at moderate: an argument is only as strong as its weakest step.
test('a step only a model can reach is settled by one, and caps the claim at moderate', t => {
  const asked = [];
  const narrow = { settle: proposition => {
    asked.push(proposition);
    return [{ rung: 'cross_family_llm', check: `jev noul: ${proposition}`, result: 0.91 }];
  } };
  const partial = {
    ...TRUE_CLAIM,
    evidenceToCheck: [TRUE_CLAIM.evidenceToCheck[0],
      { proposition: 'The endpoint is reachable by an account that does not own the record.' }],
  };
  const { chains, decision } = run(t, [partial], narrow);

  assert.equal(chains[0].verdict, 'confirmed');
  assert.equal(chains[0].verifierConfidence, 'moderate', 'a step resting on a model alone caps the claim');
  assert.equal(asked.length, 2, 'the model is asked about each proposition, never about the claim');
  assert.match(asked[1], /reachable by an account/);
  assert.equal(decision.verdict, 'security_review');
});

// The same narrow question, answered the other way. A proposition the model denies is
// a claim that does not hold, and it dies at moderate rather than high: a model is not
// a deterministic refutation.
test('a step the model denies refutes the claim at moderate confidence', t => {
  const denying = { settle: proposition => [{ rung: 'cross_family_llm', check: `jev noul: ${proposition}`,
    result: proposition.startsWith('The endpoint') ? 0.04 : 0.88 }] };
  const partial = {
    ...TRUE_CLAIM,
    evidenceToCheck: [TRUE_CLAIM.evidenceToCheck[0],
      { proposition: 'The endpoint is reachable by an account that does not own the record.' }],
  };
  const { chains, decision } = run(t, [partial], denying);

  assert.equal(chains[0].verdict, 'refuted');
  assert.equal(chains[0].verifierConfidence, 'moderate');
  assert.match(chains[0].limitations[0], /does not hold/);
  assert.equal(decision.verdict, 'merge');
});

// The contradiction case, now sharp enough to name the check. The model is not voting
// against the code; it is reporting that this particular text proxy does not mean what
// its proposition says.
test('a model that contradicts a check accuses that check, and the claim does not ship', t => {
  const contradicting = { settle: () => [{ rung: 'cross_family_llm', check: 'jev noul', result: 0.03 }] };
  const { chains, decision } = run(t, [TRUE_CLAIM], contradicting);

  assert.equal(chains[0].verdict, 'inconclusive');
  assert.equal(chains[0].verifierConfidence, 'low');
  assert.equal(chains[0].suspectChecks.length, 2);
  assert.match(chains[0].suspectChecks[0], /body of `update` lacks/);
  assert.equal(decision.verdict, 'merge');
});

test('a claim no rung can touch is inconclusive, not quietly confirmed', t => {
  const bare = { ...TRUE_CLAIM, evidenceToCheck: [{ proposition: 'Any account can update any record.' }] };
  const { chains, decision } = run(t, [bare]);
  assert.equal(chains[0].verdict, 'inconclusive');
  assert.equal(chains[0].verifierConfidence, 'low');
  assert.match(chains[0].limitations[0], /No rung produced evidence/);
  assert.equal(decision.verdict, 'merge');
});

test('an unusable policy fails loudly rather than producing a verdict', t => {
  assert.throws(() => verifyClaims([], revisionsOf(repository(t)), { name: 'no-fallback', rules: [] }), /is unusable/);
});

// The third false-positive mechanism the 2026-09-14 audit recorded: a claim attributed
// to a pull request because related lines changed, when its whole trigger already
// existed at the merge base. `sms-retry-non-idempotent` was reported as a new defect
// although every step of it predated the change. A base-side proposition settles that
// deterministically, so the misattribution dies on rung 1 rather than reaching a user.
const ATTRIBUTED = {
  type: 'auth_bypass', location: 'update.ts:2',
  description: 'update() no longer compares owner to account.',
  suspectedCondition: 'A different account submits a known record id.',
  severity: 'P1',
  evidenceToCheck: [
    { proposition: 'The ownership comparison is gone at head.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } },
    { proposition: 'It was there before this change, so this change removed it.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'present', revision: 'base' } },
  ],
};
const MISATTRIBUTED = {
  type: 'contract_break', location: 'update.ts:2',
  description: 'update() returns a bare string rather than the saved record.',
  suspectedCondition: 'A caller reads the returned value expecting a record.',
  severity: 'P2',
  evidenceToCheck: [
    { proposition: 'update() returns the bare string at head.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'return "updated"' } },
    { proposition: 'This change introduced it: the bare return is absent at the merge base.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'return "updated"', expect: 'absent', revision: 'base' } },
  ],
};

test('a correctly attributed regression is confirmed on both sides of the change', t => {
  const { chains } = run(t, [ATTRIBUTED]);
  assert.equal(chains[0].verdict, 'confirmed');
  assert.equal(chains[0].evidence.length, 2);
  assert.match(chains[0].evidence[1].check, /at the merge base/);
});

test('a claim whose trigger already existed at the merge base is refuted, not reported', t => {
  const { chains, decision } = run(t, [MISATTRIBUTED]);
  assert.equal(chains[0].verdict, 'refuted');
  assert.equal(chains[0].verifierConfidence, 'high');
  assert.equal(decision.verdict, 'merge', 'a pre-existing condition is not this change to answer for');
});

// Measured on PR #2 of this repository, 2026-09-20. The model wrote the proposition
// "the account object has an ownerId property" and checked it with
// body_contains(renameAccount, "ownerId") at head — inside the very function whose
// deleted guard was the only mention of ownerId. The grep missed because the defect
// removed it, and a miss on rung 1 refutes, so a correct auth_bypass came back as a
// confident denial. Absence of a string is not absence of a property, and a claim about
// a change cannot be refuted by that change.
test('a miss that the change itself caused does not refute the claim about it', t => {
  const circular = {
    type: 'auth_bypass', location: 'update.ts:2',
    description: 'update() no longer compares owner to account.',
    suspectedCondition: 'A different account submits a known record id.',
    severity: 'P1',
    evidenceToCheck: [
      // True of the code, and checked in the one place the deletion guarantees a miss.
      { proposition: 'The comparison operands are owner and account.',
        check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account' } },
    ],
  };
  const { chains } = run(t, [circular]);
  assert.notEqual(chains[0].verdict, 'refuted', 'the change cannot refute a claim about the change');
  assert.equal(chains[0].propositions[0].status, 'unsettled');
  assert.equal(chains[0].propositions[0].settledBy, null, 'it is handed on, not settled');
});

// The other half of the rule, and the reason it is narrow. A miss still refutes when it
// is not the change that caused it: the pattern is absent on both sides, so the model
// was simply wrong about the code. Keeping this conclusive is what stops the fix above
// from turning every failed lookup into a shrug.
test('a miss the change did not cause still refutes', t => {
  const wrong = {
    type: 'auth_bypass', location: 'update.ts:2',
    description: 'update() delegates to a permissions service.',
    suspectedCondition: 'A different account submits a known record id.',
    severity: 'P1',
    evidenceToCheck: [
      { proposition: 'update() calls the permissions service.',
        check: { assertion: 'body_contains', symbol: 'update', pattern: 'permissions.check(' } },
    ],
  };
  const { chains } = run(t, [wrong]);
  assert.equal(chains[0].verdict, 'refuted');
  assert.equal(chains[0].propositions[0].status, 'refuted');
});

// An `expect: absent` miss rests on having FOUND the pattern, which is positive
// evidence and contradicts the proposition outright. It must keep refuting whether or
// not the other side also has it, or the rule above would swallow the legitimate
// refutations this repository's audit cases were written for.
test('a miss that rests on finding the pattern still refutes', t => {
  const found = {
    type: 'contract_break', location: 'update.ts:1',
    description: 'update() takes no owner argument.',
    suspectedCondition: 'A caller passes an owner and it is ignored.',
    severity: 'P2',
    evidenceToCheck: [
      { proposition: 'update() does not mention owner at all.',
        check: { assertion: 'declaration_contains', symbol: 'update', pattern: 'owner', expect: 'absent' } },
    ],
  };
  const { chains } = run(t, [found]);
  assert.equal(chains[0].verdict, 'refuted');
});

// A refutation is the strongest verdict available and, until --question-refutations,
// the least protected: verifyClaim returned before rung 3, so suspectChecks only ever
// guarded propositions a check ESTABLISHED. Measured 2026-09-20 on PR #2 — "there is no
// other function or middleware that enforces ownership" checked with
// referenced_outside(expect: absent), which asks whether the function is called at all.
// The test file calls it, the check missed, and a correct auth_bypass died.
const MISMATCHED = {
  type: 'auth_bypass', location: 'update.ts:2',
  description: 'update() no longer compares owner to account.',
  suspectedCondition: 'A different account submits a known record id.',
  severity: 'P1',
  evidenceToCheck: [
    // The proposition is about whether the function enforces ownership. The check asks
    // whether the word "owner" appears in its declaration — which it does, as a
    // parameter name. Two different statements, and the parameter survives the change
    // that removed the guard, so the check refutes a claim that is true.
    { proposition: 'update() takes no notion of an owner into account.',
      check: { assertion: 'declaration_contains', symbol: 'update', pattern: 'owner', expect: 'absent' } },
  ],
};
const answering = probability => ({ settle: proposition => [{ rung: 'cross_family_llm', check: `jev noul: ${proposition}`, result: probability }] });
const withOptions = (t, claims, crossFamily, options) => {
  const fixture = repository(t);
  const withIds = assignClaimIds(claims, path => sourceText(fixture.source, fixture.packet.headSha, path));
  return verifyClaims(withIds, revisionsOf(fixture), BALANCED, crossFamily, undefined, options);
};

test('a lone refuting check is not questioned unless asked to be', t => {
  const { chains, crossFamilyLog } = withOptions(t, [MISMATCHED], answering(0.95), {});
  assert.equal(chains[0].verdict, 'refuted', 'the default keeps the rule that no rung argues with a refutation');
  assert.deepEqual(crossFamilyLog, [], 'and spends nothing doing it');
});

test('a model that contradicts a lone refuting check holds the claim back instead', t => {
  const { chains, crossFamilyLog } = withOptions(t, [MISMATCHED], answering(0.95), { questionRefutations: true });
  assert.equal(chains[0].verdict, 'inconclusive', 'a contradicted check does not get to assert the claim is false');
  assert.equal(chains[0].propositions[0].status, 'unsettled');
  assert.equal(chains[0].suspectChecks.length, 1, 'the check is recorded for tightening');
  assert.equal(crossFamilyLog.length, 1, 'exactly one extra question, on the claim that turned on it');
});

test('a model that agrees with a lone refuting check leaves the refutation standing', t => {
  const { chains } = withOptions(t, [MISMATCHED], answering(0.02), { questionRefutations: true });
  assert.equal(chains[0].verdict, 'refuted', 'corroborated, so nothing changes');
});

test('a neutral answer leaves the refutation standing too', t => {
  const { chains } = withOptions(t, [MISMATCHED], answering(0.5), { questionRefutations: true });
  assert.equal(chains[0].verdict, 'refuted', 'an answer that settles nothing does not reverse a check');
});

// Narrow on purpose. With several propositions refuted there is no single point of
// failure to question, and paying for a call on every dying claim is the cost the flag
// exists to bound.
test('only a lone refuting check is questioned, not a claim refuted several ways', t => {
  const twoWays = { ...MISMATCHED, evidenceToCheck: [
    MISMATCHED.evidenceToCheck[0],
    { proposition: 'update() calls a permissions service.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'permissions.check(' } },
  ] };
  const { chains, crossFamilyLog } = withOptions(t, [twoWays], answering(0.95), { questionRefutations: true });
  assert.equal(chains[0].verdict, 'refuted');
  assert.deepEqual(crossFamilyLog, [], 'no question asked, so no call paid for');
});

// The invariant the revision field exists for: whatever side rung 1 ran against, rung 3
// is asked about that same side. Measured 2026-09-20 on a live run — rung 1 checked at
// head and missed, correctly; rung 3 got the bare sentence with a state carrying both
// revisions and answered for base; `suspectChecks` held back a correct auth_bypass.
// Neither rung was wrong. They were answering different questions.
test('rung 3 is asked at the revision rung 1 ran against', t => {
  const asked = [];
  const recording = { settle: (proposition, claim, revision) => { asked.push({ proposition, revision }); return []; } };
  const claim = {
    ...TRUE_CLAIM,
    evidenceToCheck: [
      // Named on the check, which is what rung 1 runs against.
      { proposition: 'The guard ran before the change.',
        check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', revision: 'base' } },
      // Named on the proposition, with the check silent. It used to default to head
      // here, so rung 1 looked at the wrong revision with nothing recording that it had.
      { proposition: 'The guard is stated in the declaration before the change.', revision: 'base',
        check: { assertion: 'declaration_contains', symbol: 'update', pattern: 'owner' } },
      // Neither names a side, so both rungs take head.
      { proposition: 'No ownership comparison remains in the function body.',
        check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } },
    ],
  };
  const { chains } = run(t, [claim], recording);

  assert.deepEqual(asked.map(one => one.revision), ['base', 'base', 'head']);
  // And rung 1 says so in its own labels, so a reader of the report can check it too.
  const labels = chains[0].evidence.filter(one => one.rung === 'symbolic').map(one => one.check);
  assert.equal(labels.filter(label => label.includes('at the merge base')).length, 2);
});

// A proposition that names base makes the check inherit it. Before, the check ran at
// head and quietly answered about the wrong code.
test('a check with no side inherits the propositions own', t => {
  const claim = {
    ...TRUE_CLAIM,
    evidenceToCheck: [{ proposition: 'The guard was present before the change.', revision: 'base',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account' } }],
  };
  const { chains } = run(t, [claim]);
  assert.equal(chains[0].verdict, 'confirmed', 'the guard is there at base; checking head would refute it');
  assert.match(chains[0].evidence[0].check, /at the merge base/);
});

// A miss the circularity rule downgraded must not come back as a refutation. composeChain
// reads any symbolic miss as `refuted` at high confidence, before it looks at the
// proposition records at all, so leaving the evidence in place overruled the rule one
// line after it fired. Measured 2026-09-20 over ten live runs: two claims had every
// proposition established and rung 3 agreeing at 0.97, and still came out `refuted` —
// one of them cost its run the finding.
test('a miss that cannot refute does not refute the chain', t => {
  const claim = {
    ...TRUE_CLAIM,
    evidenceToCheck: [
      // Present at base, gone at head because the change removed it: the miss IS the
      // change, so it cannot refute a claim about the change.
      { proposition: 'The guard is gone from the body.',
        check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account' } },
    ],
  };
  const agreeing = { settle: proposition => [{ rung: 'cross_family_llm', check: `jev noul: ${proposition}`, result: 0.97 }] };
  const { chains, limitations } = run(t, [claim], agreeing);

  assert.equal(chains[0].propositions[0].status, 'established');
  assert.equal(chains[0].propositions[0].settledBy, 'cross_family_llm');
  assert.equal(chains[0].verdict, 'confirmed', 'the rule downgraded the miss, so nothing refutes this');
  // The check is still reported, as a limitation rather than as live evidence, which is
  // where every other check that ran and settled nothing goes.
  assert.ok(limitations.some(one => /cannot refute a claim about it/.test(one)));
  assert.equal(chains[0].evidence.filter(one => one.result === 'miss').length, 0);
});

// Every proposition holding is not the same as the claim holding, and until now nothing
// asked the difference. Measured 2026-09-21 over 45 runs on the Martian cases: the noisy
// claims and the real ones are confirmed for the same reason, because their propositions
// restate the diff. "It had margin-top at base" and "it does not at head" are both true;
// "therefore the layout breaks" was never put to anything.
test('a claim whose premises hold still has to have its conclusion affirmed', t => {
  // The model is asked the claim's own assertion and will not affirm it. Neutral, not
  // negative — which is exactly what a hedged claim draws, and why the gate is agreement
  // rather than the absence of disagreement.
  const unconvinced = { settle: proposition => [{ rung: 'cross_family_llm',
    check: `jev noul: ${proposition}`, result: proposition === TRUE_CLAIM.description ? 0.5 : 0.95 }] };
  const gated = withOptions(t, [TRUE_CLAIM], unconvinced, { questionConclusion: true });
  assert.equal(gated.chains[0].verdict, 'inconclusive');
  assert.match(gated.chains[0].limitations.join(' '), /does not follow from the premises/);
  // Off by default, so the same claim and the same model ship as before.
  assert.equal(withOptions(t, [TRUE_CLAIM], unconvinced, {}).chains[0].verdict, 'confirmed');
  // And the gate only withholds: a model that affirms the claim changes nothing.
  assert.equal(withOptions(t, [TRUE_CLAIM], answering(0.95), { questionConclusion: true }).chains[0].verdict, 'confirmed');
});

// A rung that could not be reached must not become a requirement for shipping, or an
// outage turns every claim inconclusive. Seen for real on 2026-09-21, when one run's Jev
// calls all failed and seven claims died without the report saying why.
test('a silent rung does not withhold the conclusion', t => {
  const silent = { settle: () => [] };
  const { chains } = withOptions(t, [TRUE_CLAIM], silent, { questionConclusion: true });
  assert.equal(chains[0].verdict, 'confirmed');
});
