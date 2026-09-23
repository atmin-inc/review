import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repository } from './helpers.mjs';
import { investigateClaims } from '../dist/investigator.js';
import { revisionFrom } from '../dist/symbolic.js';
import { verifyClaims } from '../dist/lifecycle.js';
import { BALANCED } from '../dist/policy.js';
import { sourceText } from '../dist/snapshot.js';
import { ProviderRequestError } from '../dist/provider-error.js';

const LIMITS = { maxTurns: 6, maxToolCalls: 20, maxInputTokens: 50000, maxOutputTokens: 4096,
  maxUsd: 1, costOf: (input, output) => (input * 2.5 + output * 15) / 1_000_000 };
const action = (name, args) => ({ id: `${name}-${Math.random()}`, name, arguments: JSON.stringify(args) });
const end = (complete = true, limitations = []) => action('end_investigation', { complete, limitations });

// A model is a script of tool calls here. The point of these tests is the controller
// around it: what it accepts, what it refuses, and what it hands to verification.
function model(steps, options = {}) {
  let index = 0;
  const inputs = [];
  return {
    inputs,
    async count() { return 1000; },
    async respond(input) {
      inputs.push(structuredClone(input));
      const step = steps[index++];
      return { model: 'stub', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0,
        status: 'completed', continuation: [], calls: Array.isArray(step) ? step : step ? [step] : [], ...options.reply };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
}

const corpus = t => {
  const fixture = repository(t);
  return {
    revisions: { head: revisionFrom(fixture.source, fixture.packet.headSha), base: revisionFrom(fixture.source, fixture.packet.mergeBaseSha) },
    sourceOf: path => sourceText(fixture.source, fixture.packet.headSha, path),
  };
};

// The fixture's head deletes an ownership guard from update(owner, account).
const GUARD_CLAIM = {
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

// The join this milestone exists for. A model emits a claim, the controller gives it
// an id, and verification settles it against the same revision with none of the
// model's reasoning in scope. Emission and verdict are now one path.
test('an emitted claim is verified against the revision, not against the model', async t => {
  const { revisions, sourceOf } = corpus(t);
  const emitted = await investigateClaims(revisions, sourceOf, {},
    model([action('record_claim', GUARD_CLAIM), end()]), LIMITS);

  assert.equal(emitted.complete, true);
  assert.equal(emitted.claims.length, 1);
  assert.match(emitted.claims[0].claimId, /^c-[0-9a-f]{12}$/);

  const { chains, decision } = verifyClaims(emitted.claims, revisions, BALANCED);
  assert.equal(chains[0].verdict, 'confirmed');
  assert.equal(decision.verdict, 'security_review');
});

// Rule 5 of the claim schema, enforced rather than requested. A claim with no trigger
// cannot be settled by any rung, so the verifier would carry it to the end and report
// it as inconclusive. Refusing it at emit time is what keeps wide emission cheap.
test('an unfalsifiable claim is refused at emit time and the model is told why', async t => {
  const { revisions, sourceOf } = corpus(t);
  const fake = model([action('record_claim', { ...GUARD_CLAIM, suspectedCondition: GUARD_CLAIM.description }), end()]);
  const emitted = await investigateClaims(revisions, sourceOf, {}, fake, LIMITS);

  assert.equal(emitted.claims.length, 0);
  assert.match(emitted.toolErrors[0].reason, /restates description/);
  assert.match(JSON.stringify(fake.inputs[1].transcript), /restates description/,
    'the rejection reaches the model, which can correct and re-emit');
});

test('a claim about a line that does not exist is refused', async t => {
  const { revisions, sourceOf } = corpus(t);
  const emitted = await investigateClaims(revisions, sourceOf, {},
    model([action('record_claim', { ...GUARD_CLAIM, location: 'update.ts:900' }), end()]), LIMITS);
  assert.equal(emitted.claims.length, 0);
  assert.match(emitted.toolErrors[0].reason, /does not resolve/);
});

test('re-recording the same claim is refused rather than counted twice', async t => {
  const { revisions, sourceOf } = corpus(t);
  const emitted = await investigateClaims(revisions, sourceOf, {},
    model([action('record_claim', GUARD_CLAIM), action('record_claim', GUARD_CLAIM), end()]), LIMITS);
  assert.equal(emitted.claims.length, 1);
  assert.match(emitted.toolErrors[0].reason, /already recorded/);
});

// A claim is the assertion it makes, so the same defect recorded again with different
// checks is the same claim. Fingerprinting the whole draft missed that: measured
// 2026-09-21 on Martian case-005, the same `error_handling_gap` was recorded seven
// times, differing only in its checks and twice carrying none at all, which spent the
// turn budget the investigation then ran out of.
test('the same claim with different checks is still the same claim', async t => {
  const { revisions, sourceOf } = corpus(t);
  const variant = { ...GUARD_CLAIM, evidenceToCheck: [{ proposition: GUARD_CLAIM.evidenceToCheck[0].proposition }] };
  const emitted = await investigateClaims(revisions, sourceOf, {},
    model([action('record_claim', GUARD_CLAIM), action('record_claim', variant), end()]), LIMITS);
  assert.equal(emitted.claims.length, 1);
  assert.match(emitted.toolErrors[0].reason, /already recorded/);
  // The first record keeps its checks rather than being replaced by a barer one.
  assert.equal(emitted.claims[0].evidenceToCheck.length, GUARD_CLAIM.evidenceToCheck.length);
});

// A different defect at the same place is a different claim, so the key must not be so
// loose that it swallows one.
test('a different defect at the same location is still recorded', async t => {
  const { revisions, sourceOf } = corpus(t);
  const other = { ...GUARD_CLAIM, description: 'A second, unrelated defect at the same line.' };
  const emitted = await investigateClaims(revisions, sourceOf, {},
    model([action('record_claim', GUARD_CLAIM), action('record_claim', other), end()]), LIMITS);
  assert.equal(emitted.claims.length, 2);
  assert.deepEqual(emitted.toolErrors, []);
});

// The investigator must never be cut off mid-read with nothing recorded. On its last
// turn the source tools are withdrawn, so the only move left is to close out and say
// what was left unresolved.
test('the closing turn withdraws the source tools so the pass always ends honestly', async t => {
  const { revisions, sourceOf } = corpus(t);
  const fake = model([
    action('read_file', { side: 'head', path: 'update.ts', startLine: 1, count: 10 }),
    action('record_claim', GUARD_CLAIM),
    end(false, ['Callers outside this repository were not inspected.']),
  ]);
  const emitted = await investigateClaims(revisions, sourceOf, {}, fake, { ...LIMITS, maxTurns: 3 });

  assert.deepEqual(fake.inputs[2].tools.map(tool => tool.name), ['end_investigation']);
  assert.equal(emitted.complete, false);
  assert.deepEqual(emitted.limitations, ['Callers outside this repository were not inspected.']);
  assert.equal(emitted.claims.length, 1, 'claims recorded before the close are kept');
});

test('an incomplete close with no limitations is refused', async t => {
  const { revisions, sourceOf } = corpus(t);
  const emitted = await investigateClaims(revisions, sourceOf, {}, model([end(false), end(false, ['Ran out of budget.'])]), LIMITS);
  assert.match(emitted.toolErrors[0].reason, /explain unresolved work/);
  assert.deepEqual(emitted.limitations, ['Ran out of budget.']);
});

// A claim is cheap to verify and this pass is not the one that decides what it is
// worth, so a run that dies partway still hands over what it already emitted. The
// truncated response itself is discarded whole: its tool calls may be half-written.
test('claims emitted before a failure survive it, and the truncated turn does not', async t => {
  const { revisions, sourceOf } = corpus(t);
  let turn = 0;
  const flaky = {
    async count() { return 1000; },
    async respond() {
      const failing = turn++ === 1;
      return { model: 'stub', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0,
        status: failing ? 'incomplete' : 'completed', continuation: [],
        calls: [action('record_claim', failing ? { ...GUARD_CLAIM, location: 'update.ts:1' } : GUARD_CLAIM)] };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
  const emitted = await investigateClaims(revisions, sourceOf, {}, flaky, LIMITS);
  assert.equal(emitted.claims.length, 1, 'the claim from the completed turn is kept');
  assert.equal(emitted.complete, false);
  assert.match(emitted.stopReason, /Provider response incomplete/);
});

// The two cut-reply cases have different fixes -- an interrupted stream is worth
// retrying, an output-cap truncation needs a larger budget or a shorter answer -- so
// reporting them as one message leaves the operator guessing. On 2026-09-22 three runs
// in six stopped here and nothing on disk said which it had been.
test('a cut reply says whether it was interrupted or truncated', async t => {
  const { revisions, sourceOf } = corpus(t);
  const cut = status => ({
    async count() { return 1000; },
    async respond() {
      return { model: 'stub', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0,
        status, continuation: [], calls: [] };
    },
    toolOutput: (id, value) => ({ id, value }),
  });
  const interrupted = await investigateClaims(revisions, sourceOf, {}, cut('interrupted'), LIMITS);
  assert.match(interrupted.stopReason, /Provider response interrupted/);
  assert.equal(interrupted.telemetry.finishReason, 'interrupted');
  const truncated = await investigateClaims(revisions, sourceOf, {}, cut('incomplete'), LIMITS);
  assert.match(truncated.stopReason, /Provider response incomplete/);
  assert.equal(truncated.telemetry.finishReason, 'incomplete');
});

// A run that records nothing is the one most in need of an explanation and the one that
// leaves the least behind. These counts are what say whether it was reading and finding
// nothing, or failing every tool call, or never getting a turn at all.
test('a run that emits no claim still reports what it spent its turns on', async t => {
  const { revisions, sourceOf } = corpus(t);
  const busy = model([
    action('read_file', { side: 'head', path: 'update.ts', startLine: 1, count: 5 }),
    action('read_file', { side: 'head', path: 'update.ts', startLine: 1, count: 5 }),
    action('search_repository', { side: 'head', query: 'owner' }),
    end(false, ['nothing found']),
  ]);
  const emitted = await investigateClaims(revisions, sourceOf, {}, busy, LIMITS);
  assert.equal(emitted.claims.length, 0);
  assert.equal(emitted.telemetry.toolCalls, 4);
  assert.equal(emitted.telemetry.toolCallsByName.read_file, 2);
  assert.equal(emitted.telemetry.toolCallsByName.search_repository, 1);
  assert.equal(emitted.telemetry.turns, 4);
  assert.ok(emitted.telemetry.outputTokens > 0, 'tokens spent are recorded even with nothing to show for them');
});

// Provider and SDK failures can carry repository text, so only controlled messages
// cross back out of the loop.
test('an unexpected failure is reported without its message', async t => {
  const { revisions, sourceOf } = corpus(t);
  const exploding = { async count() { return 1; }, async respond() { throw new Error('secret token abc123 leaked here'); }, toolOutput: () => ({}) };
  const emitted = await investigateClaims(revisions, sourceOf, {}, exploding, LIMITS);
  assert.equal(emitted.stopReason, 'Investigation failed; provider or source operation unavailable');
  assert.doesNotMatch(JSON.stringify(emitted), /abc123/);
  assert.equal(emitted.telemetry.failure, null);
});

// The one exception to the rule above, and the reason ProviderRequestError exists: its
// message is written in this repository and its `failure` is an allowlisted shape, so
// nothing provider-authored crosses out. Collapsing it into the generic message cost two
// measurement rounds on 2026-09-21, where "Investigation failed" was an empty account.
test('a provider failure keeps its kind instead of becoming the generic message', async t => {
  const { revisions, sourceOf } = corpus(t);
  const broke = {
    async count() { return 1000; },
    async respond() { throw new ProviderRequestError('inference', 402, 'insufficient_quota'); },
    toolOutput: () => ({}),
  };
  const emitted = await investigateClaims(revisions, sourceOf, {}, broke, LIMITS);
  assert.match(emitted.stopReason, /funding/i);
  assert.deepEqual(emitted.telemetry.failure, { kind: 'funding', stage: 'inference', status: 402, code: 'insufficient_quota' });
});

test('a claim carrying a check outside the catalogue is rejected by the schema', async t => {
  const { revisions, sourceOf } = corpus(t);
  const invented = { ...GUARD_CLAIM, evidenceToCheck: [{ proposition: 'The guard is gone.',
    check: { assertion: 'run_shell', symbol: 'update', pattern: 'rm -rf /' } }] };
  const emitted = await investigateClaims(revisions, sourceOf, {}, model([action('record_claim', invented), end()]), LIMITS);
  assert.equal(emitted.claims.length, 0);
  assert.match(emitted.toolErrors[0].reason, /Invalid or unavailable tool name or arguments/);
});

// A command that can spend without a ceiling is not one to hand anybody. Each request
// is priced before it is made, and a request that cannot be reserved is not made.
test('a request that cannot be reserved is never made', async t => {
  const { revisions, sourceOf } = corpus(t);
  const fake = model([action('record_claim', GUARD_CLAIM), end()]);
  const emitted = await investigateClaims(revisions, sourceOf, {}, fake,
    { ...LIMITS, maxUsd: 0.00001 });
  assert.equal(fake.inputs.length, 0, 'no request is sent once the budget cannot cover it');
  assert.equal(emitted.stopReason, 'Budget cannot reserve the next request');
  assert.equal(emitted.claims.length, 0);
});

test('spending is settled against what the provider actually reported', async t => {
  const { revisions, sourceOf } = corpus(t);
  const emitted = await investigateClaims(revisions, sourceOf, {}, model([end()]), LIMITS);
  // Reserved at maxOutputTokens, settled at the 50 the reply reported.
  assert.equal(emitted.spentUsd, (1000 * 2.5 + 50 * 15) / 1_000_000);
  assert.ok(emitted.spentUsd < LIMITS.costOf(1000, LIMITS.maxOutputTokens), 'the reservation is released, not kept');
});

// A long investigation on a real PR outgrows the context window, and the controller used
// to treat that as fatal: measured 2026-09-21 over 45 runs on the Martian cases, between
// a third and a half of runs on the larger cases stopped here, throwing away whatever the
// remaining turns would have found. Recorded claims live outside the transcript, so the
// oldest turns can go instead.
test('a transcript that outgrows the window is trimmed, not fatal', async t => {
  const { revisions, sourceOf } = corpus(t);
  // Each turn adds one continuation entry and one tool result, and the count is charged
  // per transcript entry, so the window is exceeded from the third turn on.
  let turns = 0;
  const counting = {
    async count(input) { return 100 + input.transcript.length * 1000; },
    async respond() {
      const step = ++turns >= 5 ? end() : action('search_repository', { side: 'head', query: 'update' });
      return { model: 'stub', inputTokens: 100, outputTokens: 50, cachedInputTokens: 0,
        status: 'completed', continuation: [{ role: 'assistant', content: 'looking' }], calls: [step] };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
  const outcome = await investigateClaims(revisions, sourceOf, {}, counting,
    { ...LIMITS, maxTurns: 12, maxInputTokens: 4000 });
  // The run reaches its own ending rather than dying on the cap.
  assert.equal(outcome.stopReason, 'finished');
  // And it says what it cost, because a later turn genuinely did not see those reads.
  assert.equal(outcome.limitations.filter(note => note.includes('dropped to fit the context window')).length, 1);
});

// The emission bench records one run's reading and later re-asks only the claim-writing
// step over it. Both hooks are off in the product, so the record must be complete even
// when the live transcript was trimmed, and a prior transcript must reach the first request.
test('a recorded transcript survives trimming, and a prior one is sent first', async t => {
  const { revisions, sourceOf } = corpus(t);
  let turns = 0;
  const counting = {
    async count(input) { return 100 + input.transcript.length * 1000; },
    async respond() {
      const step = ++turns >= 5 ? end() : action('search_repository', { side: 'head', query: 'update' });
      return { model: 'stub', inputTokens: 100, outputTokens: 50, cachedInputTokens: 0,
        status: 'completed', continuation: [{ role: 'assistant', content: `turn ${turns}` }], calls: [step] };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
  const recorded = await investigateClaims(revisions, sourceOf, {}, counting,
    { ...LIMITS, maxTurns: 12, maxInputTokens: 4000, recordTranscript: true });
  assert.ok(recorded.limitations.some(note => note.includes('dropped to fit the context window')), 'the live transcript was trimmed');
  assert.deepEqual(recorded.transcript.filter(entry => entry.role === 'assistant').map(entry => entry.content),
    ['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5'], 'yet the record keeps every turn');

  const plain = await investigateClaims(revisions, sourceOf, {}, model([end()]), LIMITS);
  assert.equal(plain.transcript, undefined, 'nothing is recorded unless asked');

  const prior = [{ role: 'assistant', content: 'read before' }];
  const resumed = model([end()]);
  await investigateClaims(revisions, sourceOf, {}, resumed, { ...LIMITS, priorTranscript: prior });
  assert.deepEqual(resumed.inputs[0].transcript, prior);
});

// The cap still stops a single turn that cannot fit, since there is no older turn to drop
// and sending it would fail at the provider instead.
test('a first turn over the window still stops the run', async t => {
  const { revisions, sourceOf } = corpus(t);
  const huge = { async count() { return 999999; }, async respond() { throw new Error('should not be reached'); },
    toolOutput: (id, value) => ({ id, value }) };
  const outcome = await investigateClaims(revisions, sourceOf, {}, huge, LIMITS);
  assert.match(outcome.stopReason, /Input token count unavailable or exceeds the configured limit/);
});
