import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assess } from '../dist/assessment.js';
import { parsePolicy, defaultPolicy, QUALITY_CRITERIA } from '../dist/contracts.js';
import { resolveRatingPolicy } from '../dist/rating.js';
import { capture, sourceSlice, loadReview, validateConventionRules } from '../dist/snapshot.js';
import { investigate } from '../dist/investigation.js';
import { renderMarkdown } from '../dist/render.js';
import { repository, completed, finding, current, persist } from './helpers.mjs';

const quality = (score = 5, id = 'source-0') => ({ score, rationale: 'Synthetic judgment: the change improves the intended workflow.',
  criteria: Object.fromEntries(QUALITY_CRITERIA.map(key => [key, { status: 'satisfied', reason: 'Synthetic source assessment; no commands were executed.', evidenceIds: [id] }])),
  conventionRules: [],
});
function fixture(t, preset = 'balanced', perfectRequires = {}) {
  const f = repository(t);
  f.packet.policy.rating = { preset, perfectRequires };
  const result = completed(f.packet);
  const { text: _text, ...range } = sourceSlice(f.source, f.packet.headSha, 'update.ts', 1, 200);
  result.evidence[0] = { id: 'source-0', kind: 'source-read', provenance: 'controller-captured', summary: 'Synthetic captured source.',
    anchors: [{ path: 'update.ts', side: 'head', line: 1 }], capture: range };
  result.quality = quality();
  return { ...f, result, rating: (freshness = current(), ci = []) => assess(f.packet, result, freshness, ci).rating };
}

test('presets are closed, customizable and hash in canonical property order', () => {
  const a = parsePolicy({ ...defaultPolicy(), rating: { preset: 'strict-conventions', perfectRequires: { noP3: true, passingChecks: false } } });
  const b = parsePolicy({ ...defaultPolicy(), rating: { perfectRequires: { passingChecks: false, noP3: true }, preset: 'strict-conventions' } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(resolveRatingPolicy().label, 'Balanced');
  assert.equal(resolveRatingPolicy(a.rating).perfectRequires.noP3, true);
  for (const rating of [{ preset: 'unknown' }, { preset: 'balanced', weights: {} }, { preset: 'balanced', perfectRequires: { noP3: 'yes' } },
    { preset: 'balanced', perfectRequires: { noP0: false } }]) assert.throws(() => parsePolicy({ ...defaultPolicy(), rating }), /Invalid policy/);
});

test('balanced uses quality evidence when there is some, and otherwise always scores by findings', t => {
  const f = fixture(t);
  assert.equal(f.rating().score, 5);
  f.result.findings = [finding('P4')];
  assert.equal(f.rating().score, 5);
  assert.equal(f.result.findings[0].fix, undefined);
  // The claim pipeline makes no quality assessment; its reviews must still get a score
  // (Lors, 2026-09-24), and a clean one earns 5/5 while defects keep their caps.
  delete f.result.quality;
  assert.equal(f.rating().score, 5);
  assert.match(f.rating().reasons.join(' '), /rated by its findings alone/);
  f.result.findings = [finding('P1')];
  assert.equal(f.rating().score, 1);
  f.result.findings = [finding('P2')];
  assert.equal(f.rating().score, 3);
});

test('serious defects cap subjective scores and remain visible under every preset', t => {
  for (const preset of ['balanced', 'correctness-first', 'strict-conventions']) {
    const f = fixture(t, preset);
    for (const [priority, maximum] of [['P0', 1], ['P1', 1], ['P2', 3]]) {
      f.result.findings = [finding(priority), { ...finding('P4'), id: 'optional' }];
      const a = assess(f.packet, f.result, current());
      assert.equal(a.rating.score, maximum);
      assert.equal(a.findings[0].priority, priority);
      assert.equal(a.outcome, 'Changes needed');
    }
  }
});

test('correctness first can earn 5 with P3/P4; explicit noP3 and quality overrides apply', t => {
  const f = fixture(t, 'correctness-first');
  delete f.result.quality;
  f.result.findings = [finding('P3')];
  assert.equal(f.rating().score, 5);
  f.packet.policy.rating.perfectRequires.noP3 = true;
  assert.equal(f.rating().score, 4);
  f.packet.policy.rating.perfectRequires.verification = true;
  assert.equal(f.rating().score, 4, 'a required criterion nothing assessed does not withhold the score');
  f.result.quality = quality(2);
  f.result.quality.criteria.verification.status = 'concern';
  assert.equal(f.rating().score, 4, 'this preset ignores the subjective score but enforces requested gates');
});

test('conventions use explicit rule evidence; unknown required criteria are unrated, concerns cap at four', t => {
  const f = fixture(t, 'strict-conventions');
  f.result.quality.criteria.documentedConventions.status = 'concern';
  assert.throws(() => f.rating(), /explicit target-branch rule/);
  f.result.quality.conventionRules = [{ path: 'AGENTS.md', quote: 'Always use the shared error type.' }];
  assert.equal(f.rating().score, 4);
  f.result.quality.criteria.verification.status = 'unknown';
  assert.equal(f.rating().score, null);
  f.result.quality.criteria.verification.status = 'satisfied';
  f.result.quality.criteria.verification.evidenceIds = ['invented'];
  assert.throws(() => f.rating(), /Unknown evidence/);
  f.result.quality.criteria.verification.evidenceIds = [];
  assert.throws(() => f.rating(), /captured source reads/);
});

test('incomplete or stale reviews never get a score; missing checks do not withhold one', t => {
  const f = fixture(t);
  for (const preset of ['balanced', 'correctness-first', 'strict-conventions']) {
    f.packet.policy.rating.preset = preset;
    f.result.status = 'partial';
    assert.equal(f.rating().score, null);
    f.result.status = 'completed';
    assert.equal(f.rating({ ...current(), status: 'superseded' }).score, null);
    assert.equal(f.rating({ ...current(), status: 'unverified' }).score, null);
  }
  const check = status => [{ name: 'change-validation', status, reason: 'Synthetic check.' }];
  assert.equal(f.rating(current(), check('not-run')).score, 5);
  assert.match(f.rating(current(), check('not-run')).reasons.join(' '), /Required check results are missing/);
  assert.equal(f.rating(current(), check('fail')).score, 4);
  assert.equal(f.rating(current(), check('pass')).score, 5);
  f.packet.policy.rating.perfectRequires.passingChecks = false;
  assert.equal(f.rating(current(), check('not-run')).score, 5);
  assert.equal(assess(f.packet, f.result, current(), check('not-run')).outcome, 'Validation needed');
});

test('repositories can explicitly require no CI without inventing a test-count rule', t => {
  const f = fixture(t);
  f.packet.policy = parsePolicy({ ...f.packet.policy, requiredChecks: [] });
  f.result.validation = [];
  const a = assess(f.packet, f.result, current());
  assert.equal(a.validation, 'not-applicable');
  assert.equal(a.rating.score, 5);
  f.result.quality.criteria.verification.status = 'unknown';
  assert.equal(f.rating().score, null, 'no CI requirement does not fabricate appropriate verification');
});

test('PR policy edits cannot relax their own score requirements', t => {
  const f = repository(t);
  f.write('AGENTS.md', 'Always use the shared error type.\n');
  f.write('.atmin/review.json', JSON.stringify({ ...defaultPolicy(), rating: { preset: 'strict-conventions' } }));
  const baseSha = f.commit('strict target policy');
  f.write('.atmin/review.json', JSON.stringify({ ...defaultPolicy(), rating: { preset: 'correctness-first' } }));
  f.write('AGENTS.md', 'Any error type is acceptable.\n');
  const headSha = f.commit('PR attempts relaxed policy');
  const { packet } = capture(f.source, { ...f.state, baseSha, headSha });
  assert.equal(packet.policy.rating.preset, 'strict-conventions');
  const judged = quality();
  judged.conventionRules = [{ path: 'AGENTS.md', quote: 'Always use the shared error type.' }];
  assert.doesNotThrow(() => validateConventionRules(f.source, packet, judged));
  judged.conventionRules[0].quote = 'Any error type is acceptable.';
  assert.throws(() => validateConventionRules(f.source, packet, judged), /target branch/);
});

test('model checkpoints quality with captured citations and rejects invented convention rules', async t => {
  const f = repository(t), dir = persist(f);
  const proposed = quality(5, 'read-1');
  const forged = structuredClone(proposed);
  forged.criteria.documentedConventions.status = 'concern';
  forged.conventionRules = [{ path: 'AGENTS.md', quote: 'An invented target-branch rule.' }];
  const steps = [
    ['read_file', { side: 'head', path: 'update.ts', startLine: 1, count: 200 }],
    ['read_file', { side: 'base', path: 'update.ts', startLine: 1, count: 200 }],
    ['end_investigation', { complete: true, limitations: [] }],
    ['record_quality', forged], ['record_quality', proposed], ['finish', { quality: proposed, complete: true, limitations: [] }],
  ];
  const profile = JSON.parse(readFileSync(new URL('../profiles/smoke-openai.json', import.meta.url)));
  let index = 0;
  const model = {
    async count() { return 1000; },
    async respond(input) {
      assert.equal(JSON.parse(input.context).ratingPolicy.preset, 'balanced');
      const [name, args] = steps[index++];
      return { model: profile.model, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0, status: 'completed', continuation: [],
        calls: [{ id: String(index), name, arguments: JSON.stringify(args) }] };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
  const { result, receipt } = await investigate(dir, f.packet, profile, model);
  assert.equal(receipt.toolErrors.length, 1);
  assert.deepEqual(result.quality, proposed);
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
  assert.deepEqual(loadReview(dir).result.quality, proposed);
  result.quality = forged;
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
  assert.throws(() => loadReview(dir), /Convention rule/);
});

test('report shows policy and unrated rationale, escaping model text', t => {
  const f = fixture(t);
  f.result.quality.rationale = '<script> @everyone [link](https://bad.invalid)';
  let text = renderMarkdown(f.packet, f.result, assess(f.packet, f.result, current()));
  assert.match(text, /^## <img[^>]+> 5\/5/);
  assert.match(text, /Balanced/);
  assert.ok(!text.includes('<script>') && !text.includes('@everyone'));
  f.result.status = 'partial';
  text = renderMarkdown(f.packet, f.result, assess(f.packet, f.result, current()));
  assert.match(text, /^## <img[^>]+> Not rated/);
});
