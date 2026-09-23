import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, persist } from './helpers.mjs';
import { ablate, runClaimReview } from '../dist/claim-run.js';
import { renderClaimReview } from '../dist/render-claim.js';

const profile = { provider: 'openai', model: 'gpt-5.4-2026-03-05', maxUsd: 2, maxTurns: 6,
  maxToolCalls: 20, maxInputTokens: 50000, maxOutputTokens: 4096, deadlineMs: 600000 };
const action = (name, args) => ({ id: `${name}-${Math.random()}`, name, arguments: JSON.stringify(args) });

const TRUE_CLAIM = {
  type: 'auth_bypass', location: 'update.ts:2',
  description: 'update() returns without comparing owner to account.',
  suspectedCondition: 'A different account submits a known record id.',
  severity: 'P1',
  evidenceToCheck: [
    { proposition: 'No ownership comparison remains in the function body.',
      check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } },
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

function model(steps) {
  let index = 0;
  return {
    async count() { return 1000; },
    async respond() {
      const step = steps[index++];
      return { model: profile.model, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0,
        status: 'completed', continuation: [], calls: Array.isArray(step) ? step : step ? [step] : [] };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
}

// The product, end to end, over a real Git snapshot: a model emits two claims about a
// deleted ownership guard, one true and one not, and the verdict is composed from the
// one the revision supports. Nothing here decides that but the code.
test('a prepared snapshot goes in and a composed verdict comes out', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const fake = model([[action('record_claim', TRUE_CLAIM), action('record_claim', FALSE_CLAIM)],
    action('end_investigation', { complete: true, limitations: [] })]);

  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake);

  assert.equal(claims.length, 2);
  assert.equal(investigation.stopReason, 'finished');
  assert.deepEqual(verification.chains.map(chain => chain.verdict), ['confirmed', 'refuted']);
  assert.equal(verification.decision.verdict, 'security_review');

  // Both halves are written down, because a verdict nobody can reconstruct is not a
  // verdict. The claims file is what a rerun would be diffed against.
  const written = JSON.parse(readFileSync(join(directory, 'claims.json'), 'utf8'));
  assert.equal(written.length, 2);
  assert.equal(JSON.parse(readFileSync(join(directory, 'verification.json'), 'utf8')).decision.rule, 'security-surface');
});

// Wide emission is only trustworthy if the discarding is visible, so the report shows
// what died as well as what survived, and never claims a rung it did not run.
test('the report shows the surviving finding, the discarded claim and the missing rung', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const fake = model([[action('record_claim', TRUE_CLAIM), action('record_claim', FALSE_CLAIM)],
    action('end_investigation', { complete: true, limitations: [] })]);
  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake);

  const report = renderClaimReview(claims, verification, investigation);
  assert.match(report, /\*\*Security review\*\* — rule `security-surface`/);
  assert.match(report, /1 of 2 claim\(s\) survived/);
  assert.match(report, /P1 · auth\\_bypass · update\.ts:2/);
  assert.match(report, /No ownership comparison remains/);
  assert.match(report, /## Claims that did not survive/);
  assert.match(report, /contract\\_break \| refuted by the code/);
  assert.match(report, /cross-family rung did not run/);
  assert.match(report, /Nothing was executed/);
});

// The converse of the note above, and the reason it is conditional: once rung 3 really
// answers, a report that still says the rung did not run tells the reader the opposite
// of the `jev noul:` evidence printed a few lines earlier.
test('the report drops the missing-rung note once the cross-family rung has answered', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const fake = model([[action('record_claim', TRUE_CLAIM)],
    action('end_investigation', { complete: true, limitations: [] })]);
  const rung = { settle: proposition => [{ rung: 'cross_family_llm', check: `jev noul: ${proposition}`, result: 0.95 }] };
  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake, undefined, rung);

  assert.ok(verification.crossFamilyLog.length, 'the rung answered, so the run recorded it');
  const report = renderClaimReview(claims, verification, investigation);
  assert.match(report, /jev noul:/);
  assert.doesNotMatch(report, /cross-family rung did not run/);
});

// The claims and the spend are what a failed run costs, so a verification that throws must
// not take them with it. Seen 2026-09-23: a grep overflow threw out of verification on a
// live run and left no record of the claims it had paid for.
test('a verification that throws still leaves the claims and the telemetry behind', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const fake = model([[action('record_claim', TRUE_CLAIM)],
    action('end_investigation', { complete: true, limitations: [] })]);
  const rung = { settle() { throw new Error('rung exploded'); } };
  await assert.rejects(runClaimReview(directory, profile, fake, undefined, rung), /rung exploded/);

  assert.equal(JSON.parse(readFileSync(join(directory, 'claims.json'), 'utf8')).length, 1);
  const telemetry = JSON.parse(readFileSync(join(directory, 'telemetry.json'), 'utf8'));
  assert.equal(telemetry.claims, 1); assert.equal(telemetry.stopReason, 'finished');
  assert.equal(existsSync(join(directory, 'verification.json')), false);
});

// A model that emits nothing is a merge, not a crash, and the report says so plainly
// rather than reading as a clean bill of health.
test('a pass that emits no claim returns merge and says the pass was incomplete', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const fake = model([action('end_investigation', { complete: false, limitations: ['Ran out of reads.'] })]);
  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake);

  assert.equal(claims.length, 0);
  assert.equal(verification.decision.verdict, 'merge');
  const report = renderClaimReview(claims, verification, investigation);
  assert.match(report, /0 of 0 claim\(s\)/);
  assert.match(report, /Ran out of reads\./);
  assert.match(report, /Emission did not finish/);
});

// Model-authored text reaches a pull request comment, so it is escaped like any other
// untrusted string rather than trusted because a model wrote it.
test('model-authored claim text cannot inject markup into the report', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const injected = { ...TRUE_CLAIM, description: 'Ping <img src=x> @everyone [link](javascript:alert(1))' };
  const fake = model([action('record_claim', injected), action('end_investigation', { complete: true, limitations: [] })]);
  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake);

  const report = renderClaimReview(claims, verification, investigation);
  assert.doesNotMatch(report, /<img/);
  assert.match(report, /&lt;img/);
  assert.doesNotMatch(report, /\[link\]\(/);
  assert.doesNotMatch(report, /(^|[^​])@everyone/);
});

// A check label is shown as code, and the model chose part of it. Markdown escapes
// would render literally inside a code span, so the span is kept safe by stripping
// what could close it rather than by escaping.
test('a model-chosen pattern cannot break out of the code span it is shown in', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const sneaky = { ...TRUE_CLAIM, evidenceToCheck: [{ proposition: 'The guard is gone.',
    check: { assertion: 'body_contains', symbol: 'update', pattern: '`](http://evil) `', expect: 'absent' } }] };
  const fake = model([action('record_claim', sneaky), action('end_investigation', { complete: true, limitations: [] })]);
  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake);

  const report = renderClaimReview(claims, verification, investigation);
  const span = report.split('\n').find(line => line.startsWith('- `grep:'));
  assert.equal((span.match(/`/g) ?? []).length, 2, 'the label stays inside exactly one code span');
  assert.ok(span.endsWith('` → hit'), 'the span closes where the renderer closes it, not where the model does');
});

// A finished run can be re-verified with the cross-family rung switched off, from what
// it wrote down. No model is asked again, so the difference between the two is the
// rung and nothing else — which is what lets a benchmark say whether it earns its keep.
test('a finished run can be measured for what the cross-family rung contributed', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const fake = model([action('record_claim', TRUE_CLAIM), action('end_investigation', { complete: true, limitations: [] })]);
  await runClaimReview(directory, profile, fake);

  const contribution = ablate(directory);
  assert.equal(contribution.rung, 'cross_family_llm');
  assert.deepEqual(contribution.gained, [], 'no rung 3 is configured, so it contributed nothing here');
  assert.equal(contribution.with.verdicts.confirmed, contribution.without.verdicts.confirmed);
  assert.equal(contribution.with.propositions.symbolic, 1);
});

// A withheld finding is listed by location so the withholding is visible, and its text
// is not, because the text is what three in four of those findings got wrong.
test('the report lists a withheld P3 finding by location and keeps its text out', async t => {
  const fixture = repository(t);
  const directory = persist(fixture);
  const minor = { ...TRUE_CLAIM, type: 'contract_break', severity: 'P3', description: 'A minor-only sentence.' };
  const fake = model([[action('record_claim', minor)], action('end_investigation', { complete: true, limitations: [] })]);
  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake);
  const report = renderClaimReview(claims, verification, investigation);
  assert.match(report, /\*\*No changes requested\*\*/);
  assert.match(report, /## Withheld: 1 minor finding\(s\)/);
  assert.match(report, /- update\.ts:2 · contract\\_break/);
  assert.doesNotMatch(report, /minor-only sentence/);
  assert.doesNotMatch(report, /## Claims that did not survive/);
});
