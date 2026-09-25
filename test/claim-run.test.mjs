import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, persist } from './helpers.mjs';
import { ablate, runClaimReview, MAX_GUIDANCE_BYTES } from '../dist/claim-run.js';
import { claimInstructions, failurePathInstruction } from '../dist/investigator.js';
import { capture } from '../dist/snapshot.js';
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

// The failure-path pass is a second investigation over the same change. A test that
// scripts only the main pass has it end at once with nothing recorded.
const failurePathPass = input => input.instructions.includes(failurePathInstruction);
function model(steps, failurePathSteps = []) {
  let index = 0, focusIndex = 0;
  return {
    async count() { return 1000; },
    async respond(input) {
      const step = failurePathPass(input)
        ? failurePathSteps[focusIndex++] ?? action('end_investigation', { complete: true, limitations: [] })
        : steps[index++];
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

// A fake that keeps what each turn was asked, so a test can see what the model was shown.
function recording(steps, failurePathSteps) {
  const inputs = [];
  const inner = model(steps, failurePathSteps);
  return { inputs, ...inner, async respond(input, ...rest) { inputs.push(input); return inner.respond(input, ...rest); } };
}

// The repository's own rules are what a reviewer that knows the codebase holds a change
// to: on mason-v1 #4590, 5 of CodeRabbit's 12 items came from its AGENTS.md. They are read
// from the target branch, because a PR that edits AGENTS.md must not get to rewrite the
// rules it is judged by, and a file that does not fit is named rather than lost quietly.
test('the claim pass is shown the target branch AGENTS.md files, not the change\'s own', async t => {
  const fixture = repository(t);
  fixture.run('checkout', '-q', '--detach', fixture.state.baseSha);
  fixture.write('AGENTS.md', 'Target rule: never swallow an error.\n');
  fixture.write('lib/AGENTS.md', 'x'.repeat(MAX_GUIDANCE_BYTES) + '\n');
  fixture.write('lib/util.ts', 'export const one = 1;\n');
  const baseSha = fixture.commit('target rules');
  fixture.write('AGENTS.md', 'Change rule: anything goes.\n');
  fixture.write('lib/util.ts', 'export const one = 2;\n');
  const headSha = fixture.commit('change edits the rules');
  const guided = { ...fixture, ...capture(fixture.source, { ...fixture.state, baseSha, headSha }) };
  const fake = recording([action('end_investigation', { complete: true, limitations: [] })]);

  const { investigation } = await runClaimReview(persist(guided), profile, fake);

  const context = JSON.parse(fake.inputs[0].context);
  assert.deepEqual(context.targetGuidance, [{ path: 'AGENTS.md', text: 'Target rule: never swallow an error.\n' }]);
  assert.match(fake.inputs[0].instructions, /targetGuidance holds the reviewed repository's own AGENTS\.md files/);
  assert.ok(investigation.limitations.some(line => /over 32 KB was left out.*lib\/AGENTS\.md/.test(line)));
});

// Every earlier number was measured on the bare instructions, so a change with no
// AGENTS.md and no call into unchanged code must be asked exactly that, or old and new
// runs stop being comparable.
test('without AGENTS.md files or called code the claim pass is asked exactly the measured instructions', async t => {
  const fixture = repository(t);
  const fake = recording([action('end_investigation', { complete: true, limitations: [] })]);

  await runClaimReview(persist(fixture), profile, fake);

  assert.equal(fake.inputs[0].instructions, claimInstructions);
  const context = JSON.parse(fake.inputs[0].context);
  assert.equal('targetGuidance' in context, false);
  assert.equal('calledCode' in context, false);
});

// On mason-v1 #4590 the defect was in an unchanged mapper the new code threw into, and
// the model never opened it; why it missed took a paid rerun, because telemetry held
// counts and not what was read. The mapper now arrives with the change, and the reads
// are on disk.
test('unchanged code the change calls is in the context, and what the model read is in telemetry', async t => {
  const fixture = repository(t);
  fixture.run('checkout', '-q', '--detach', fixture.state.baseSha);
  fixture.write('lib/errors.ts', 'export function mapError(e) {\n  return { kind: "VendorUnavailable", retryAfterMs: 5000 };\n}\n');
  const baseSha = fixture.commit('mapper');
  fixture.write('api.ts', 'export function run(e) {\n  throw mapError(e);\n}\n');
  const headSha = fixture.commit('new caller');
  const calling = { ...fixture, ...capture(fixture.source, { ...fixture.state, baseSha, headSha }) };
  const fake = recording([action('read_file', { side: 'head', path: 'lib/errors.ts', startLine: 1, count: 3 }),
    action('end_investigation', { complete: true, limitations: [] })]);
  const directory = persist(calling);

  await runClaimReview(directory, profile, fake);

  const context = JSON.parse(fake.inputs[0].context);
  assert.deepEqual(context.calledCode.map(c => [c.symbol, c.path, c.line]), [['mapError', 'lib/errors.ts', 1]]);
  assert.match(fake.inputs[0].instructions, /calledCode holds the current definitions/);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'telemetry.json'), 'utf8')).reads,
    [{ side: 'head', path: 'lib/errors.ts', startLine: 1, count: 3 }]);
});

// On mason-v1 #4590 the main pass never claimed a failure-path defect in ten runs, so
// failure paths get a pass of their own. What it records is verified with everything
// else, and a claim both passes record counts once.
test('the failure-path pass runs after the main pass and its claims are verified with the rest', async t => {
  const fixture = repository(t);
  const end = action('end_investigation', { complete: true, limitations: [] });
  const fake = recording([[action('record_claim', TRUE_CLAIM)], end],
    [[action('record_claim', TRUE_CLAIM), action('record_claim', FALSE_CLAIM)], end]);
  const directory = persist(fixture);

  const { claims, investigation, verification } = await runClaimReview(directory, profile, fake);

  const focused = fake.inputs.map(input => input.instructions.includes(failurePathInstruction));
  assert.deepEqual(focused, [false, false, true, true]);
  assert.equal(claims.length, 2);
  assert.deepEqual(verification.chains.map(chain => chain.verdict), ['confirmed', 'refuted']);
  assert.equal(investigation.complete, true);
  const telemetry = JSON.parse(readFileSync(join(directory, 'telemetry.json'), 'utf8'));
  assert.deepEqual(telemetry.failurePathClaimIds, claims.map(claim => claim.claimId));
  assert.equal(telemetry.turns, 4);
});
