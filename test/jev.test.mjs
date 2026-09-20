import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repository } from './helpers.mjs';
import { assignClaimIds } from '../dist/claim.js';
import { revisionFrom } from '../dist/symbolic.js';
import { verifyClaims } from '../dist/lifecycle.js';
import { recordedRung } from '../dist/ablation.js';
import { askJev, jevAnswers, jevRequest, jevState, questionsAsked } from '../dist/jev.js';
import { BALANCED } from '../dist/policy.js';
import { sourceText } from '../dist/snapshot.js';

const revisionsOf = fixture => ({
  head: revisionFrom(fixture.source, fixture.packet.headSha),
  base: revisionFrom(fixture.source, fixture.packet.mergeBaseSha),
});

// The fixture head removes update()'s ownership guard. SURVIVES has one step a grep
// settles and one only a model can reach; DIES asserts something the revision shows
// false, so rung 1 refutes it outright.
const SURVIVES = {
  type: 'race_condition', location: 'update.ts:2', severity: 'P2',
  description: 'update() writes without holding the record lock.',
  suspectedCondition: 'Two requests for the same record arrive together.',
  evidenceToCheck: [
    { proposition: 'No ownership comparison remains in the function body.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } },
    { proposition: 'Concurrent callers can reach this write for the same record.' },
  ],
};
const DIES = {
  type: 'contract_break', location: 'update.ts:1', severity: 'P1',
  description: 'update() is called from other modules that assume the old signature.',
  suspectedCondition: 'Another module calls update() and relies on the throw.',
  evidenceToCheck: [{ proposition: 'update is referenced outside update.ts.',
    check: { assertion: 'referenced_outside', symbol: 'update', path: 'update.ts' } }],
};

const setUp = (t, drafts) => {
  const fixture = repository(t);
  const claims = assignClaimIds(drafts, path => sourceText(fixture.source, fixture.packet.headSha, path));
  return { fixture, claims, revisions: revisionsOf(fixture) };
};
const transportReturning = (handler, calls = []) => {
  const transport = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return handler(calls.length - 1);
  };
  transport.calls = calls;
  return transport;
};
const ok = body => new Response(JSON.stringify(body), { status: 200 });

// Money and correctness both ride on this. A claim rung 1 already refuted never reaches
// a later rung, and asking anyway would both spend on a settled question and put a
// model's opinion where a deterministic miss already answered.
test('the questions asked are exactly the ones the verifier would put to the rung', t => {
  const { claims, revisions } = setUp(t, [SURVIVES, DIES]);
  const asked = questionsAsked(claims, revisions, BALANCED);
  assert.deepEqual([...new Set(asked.map(entry => entry.claimId))], [claims[0].claimId]);
  assert.deepEqual(asked.map(entry => entry.proposition).sort(),
    SURVIVES.evidenceToCheck.map(item => item.proposition).sort());
});

// Rung 3 settles a step of an argument, so it must not be told what the argument
// concluded. Handing it the investigator's description and suspected condition invites
// it to agree with the claim rather than judge the code.
test('the state carries the location and the code, never the investigator conclusion', t => {
  const { claims, revisions } = setUp(t, [SURVIVES]);
  const state = jevState(claims[0], revisions, 'diff text');
  const serialized = JSON.stringify(state);
  assert.match(serialized, /update\.ts/);
  assert.match(serialized, /owner !== account/); // the base side still has the guard
  assert.doesNotMatch(serialized, /record lock/);
  assert.doesNotMatch(serialized, /requests for the same record/);
});

// A question about a statement is not a request for an opinion of the change, and the
// criteria are what say so.
test('each proposition becomes one noul question', t => {
  const body = JSON.parse(jevRequest({}, [{ key: 'p0', proposition: 'A holds.' }, { key: 'p1', proposition: 'B holds.' }]));
  assert.deepEqual(Object.keys(body.questions), ['p0', 'p1']);
  assert.equal(body.questions.p0.type, 'noul');
  assert.equal(body.questions.p0.question, 'A holds.');
  assert.match(body.questions.p1.criteria, /Judge the code/);
});

// The wire format is documented only in prose, so a response that does not match it
// must stop the run. Coercing an unexpected shape into a number would let a made-up
// probability decide whether a claim ships.
test('a response that does not match the assumed shape fails rather than being coerced', () => {
  const questions = [{ key: 'p0', proposition: 'A holds.' }];
  assert.equal(jevAnswers({ answers: { p0: { probability: 0.9 } } }, questions).get('p0'), 0.9);
  for (const body of [{}, { answers: {} }, { answers: { p0: {} } }, { answers: { p0: { probability: '0.9' } } },
    { answers: { p0: { probability: 1.4 } } }, { answers: { p0: { probability: Number.NaN } } },
    { answers: { p1: { probability: 0.9 } } }]) {
    assert.throws(() => jevAnswers(body, questions), /Provider/);
  }
});

// One call per claim, because Jev evaluates many questions against one state, and the
// answers come back as a log the verifier replays rather than as a live call inside it.
test('one call answers every proposition of a claim, and the log verifies', async t => {
  const { claims, revisions } = setUp(t, [SURVIVES, DIES]);
  const transport = transportReturning(() => ok({ answers: { p0: { probability: 0.94 }, p1: { probability: 0.91 } } }));
  const { log, calls, skippedClaims } = await askJev(claims, revisions, 'diff text',
    { apiKey: 'test-key', transport });
  assert.equal(calls, 1);
  assert.deepEqual(skippedClaims, []);
  assert.equal(log.length, 2);
  assert.equal(transport.calls[0].body.questions.p0.type, 'noul');

  const verification = verifyClaims(claims, revisions, BALANCED, recordedRung(log));
  const chain = verification.chains.find(item => item.claimId === claims[0].claimId);
  assert.equal(chain.verdict, 'confirmed');
  // A step no rung but a model could reach caps the claim at moderate, however
  // confidently the model answered.
  assert.equal(chain.verifierConfidence, 'moderate');
  assert.equal(chain.propositions.filter(record => record.settledBy === 'cross_family_llm').length, 1);
});

// A call that fails has not answered. Recording nothing leaves the proposition
// unsettled, which is what the lifecycle already does with a rung that cannot reach it;
// anything else would turn an outage into evidence.
test('a failed call leaves the proposition unsettled instead of answering it', async t => {
  const { claims, revisions } = setUp(t, [SURVIVES]);
  const { log, skippedClaims } = await askJev(claims, revisions, 'diff text',
    { apiKey: 'test-key', transport: transportReturning(() => new Response('upstream down', { status: 503 })) });
  assert.deepEqual(log, []);
  assert.deepEqual(skippedClaims, [claims[0].claimId]);
  const chain = verifyClaims(claims, revisions, BALANCED, recordedRung(log)).chains[0];
  assert.equal(chain.verdict, 'inconclusive');
});

// SMOKE_TEST_JEV.md, gotcha 1: an unauthenticated POST returns 403 where the docs
// promise 401. A bad key must stop the run rather than quietly producing a review with
// every rung-3 question unanswered.
test('a rejected key stops the run rather than silently emptying rung 3', async t => {
  const { claims, revisions } = setUp(t, [SURVIVES]);
  for (const status of [401, 403]) {
    await assert.rejects(() => askJev(claims, revisions, 'diff text',
      { apiKey: 'wrong-key', transport: transportReturning(() => new Response('denied', { status })) }),
    /authentication or access denied/);
  }
});

// The cap is on calls, not on claims, so a wide pass cannot turn into unbounded spend.
test('the call cap skips claims rather than exceeding it', async t => {
  const { claims, revisions } = setUp(t, [SURVIVES, { ...SURVIVES, location: 'update.ts:3', severity: 'P3' }]);
  const transport = transportReturning(() => ok({ answers: { p0: { probability: 0.8 }, p1: { probability: 0.8 } } }));
  const { calls, skippedClaims } = await askJev(claims, revisions, 'diff text',
    { apiKey: 'test-key', transport, limits: { maxCalls: 1, timeoutMs: 1000 } });
  assert.equal(calls, 1);
  assert.equal(skippedClaims.length, 1);
});
