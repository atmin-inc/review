import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repository } from './helpers.mjs';
import { assignClaimIds } from '../dist/claim.js';
import { revisionFrom } from '../dist/symbolic.js';
import { verifyClaims } from '../dist/lifecycle.js';
import { contributionOfCrossFamily, recordedRung, tally } from '../dist/ablation.js';
import { BALANCED } from '../dist/policy.js';
import { sourceText } from '../dist/snapshot.js';

const revisionsOf = fixture => ({
  head: revisionFrom(fixture.source, fixture.packet.headSha),
  base: revisionFrom(fixture.source, fixture.packet.mergeBaseSha),
});

// One claim rung 1 settles on its own, one with a step only a model can reach. The
// second is where the cross-family rung either earns its place or does not.
const GREPPABLE = {
  type: 'auth_bypass', location: 'update.ts:2',
  description: 'update() returns without comparing owner to account.',
  suspectedCondition: 'A different account submits a known record id.',
  severity: 'P1',
  evidenceToCheck: [{ proposition: 'No ownership comparison remains in the function body.',
    check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } }],
};
const NEEDS_JUDGMENT = {
  ...GREPPABLE, type: 'race_condition', severity: 'P2',
  description: 'update() writes without holding the record lock.',
  suspectedCondition: 'Two requests for the same record arrive together.',
  evidenceToCheck: [
    { proposition: 'No ownership comparison remains in the function body.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } },
    { proposition: 'Concurrent callers can reach this write for the same record.' },
  ],
};

const setUp = (t, claims, answer) => {
  const fixture = repository(t);
  const revisions = revisionsOf(fixture);
  const withIds = assignClaimIds(claims, path => sourceText(fixture.source, fixture.packet.headSha, path));
  const rung = answer && { settle: (proposition, claim) => [{ rung: 'cross_family_llm',
    check: `jev noul: ${proposition}`, result: answer(proposition, claim) }] };
  return { revisions, claims: withIds, run: () => verifyClaims(withIds, revisions, BALANCED, rung) };
};

// The measurement has to be exact, not a second noisy sample. Emission is not repeated
// and the model is not re-asked: the recorded answers are replayed, so the only thing
// that differs between the two verifications is the rung itself.
test('a recorded run replays exactly, so the comparison isolates the rung', t => {
  const { revisions, claims, run } = setUp(t, [NEEDS_JUDGMENT], () => 0.92);
  const live = run();
  assert.equal(live.crossFamilyLog.length, 2, 'every question the rung was asked is recorded');

  const replayed = verifyClaims(claims, revisions, BALANCED, recordedRung(live.crossFamilyLog));
  assert.deepEqual(tally(replayed), tally(live));
});

// The question Lors asked, answered as a number rather than an opinion. Rung 1 alone
// ships the greppable claim and leaves the other one unfinished; the model settles the
// step no grep can express, and a second claim ships capped at moderate.
test('the rung earns its place on a claim with a step no check can express', t => {
  const { revisions, claims, run } = setUp(t, [GREPPABLE, NEEDS_JUDGMENT], () => 0.92);
  const contribution = contributionOfCrossFamily(claims, revisions, BALANCED, run().crossFamilyLog);

  assert.equal(contribution.without.verdicts.confirmed, 1, 'rung 1 alone ships only the greppable claim');
  assert.equal(contribution.without.propositions.unsettled, 1);
  assert.equal(contribution.with.verdicts.confirmed, 2);
  assert.equal(contribution.with.propositions.cross_family_llm, 1);
  assert.equal(contribution.with.propositions.unsettled, 0);
  assert.deepEqual(contribution.gained, [claims[1].claimId]);
  assert.deepEqual(contribution.lost, []);
});

// And the answer that would retire it. A rung whose answers land in the neutral band
// settles nothing, and the tally says so rather than the rung being kept on faith.
test('a rung that answers in the neutral band contributes nothing, and it shows', t => {
  const { revisions, claims, run } = setUp(t, [GREPPABLE, NEEDS_JUDGMENT], () => 0.47);
  const contribution = contributionOfCrossFamily(claims, revisions, BALANCED, run().crossFamilyLog);

  assert.deepEqual(contribution.gained, []);
  assert.deepEqual(contribution.lost, []);
  assert.deepEqual(contribution.raised, []);
  assert.equal(contribution.decisionChanged, false);
  assert.deepEqual(contribution.with.verdicts, contribution.without.verdicts);
});

// A rung that only takes findings away is still earning its place when those findings
// were wrong, so removal is counted separately from agreement rather than netted off.
test('claims the rung takes away are counted, not netted against what it adds', t => {
  const { revisions, claims, run } = setUp(t, [GREPPABLE, NEEDS_JUDGMENT],
    proposition => proposition.startsWith('Concurrent') ? 0.95 : 0.02);
  const contribution = contributionOfCrossFamily(claims, revisions, BALANCED, run().crossFamilyLog);

  assert.deepEqual(contribution.gained, []);
  assert.deepEqual(contribution.lost, [claims[0].claimId], 'the contradicted claim stops shipping');
  assert.equal(contribution.with.suspectChecks, 2, 'and the checks it contradicted are named');
});

// Raising a claim from moderate to high changes what the verdict rule fires on, so it
// is reported as its own movement rather than folded into the confirmed count.
test('a rung that only raises confidence is reported as raising it', t => {
  const { revisions, claims, run } = setUp(t, [GREPPABLE], () => 0.96);
  const contribution = contributionOfCrossFamily(claims, revisions, BALANCED, run().crossFamilyLog);

  assert.deepEqual(contribution.gained, []);
  assert.deepEqual(contribution.raised, [claims[0].claimId]);
  assert.equal(contribution.without.confidence.moderate, 1);
  assert.equal(contribution.with.confidence.high, 1);
  assert.equal(contribution.decisionChanged, true, 'high confidence on a P1 is what blocks');
});
