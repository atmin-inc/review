import { test } from 'node:test';
import assert from 'node:assert/strict';
import { climb, composeChain, DEFAULT_THRESHOLDS } from '../dist/evidence.js';

const symbolic = (result, check = 'AST: interpolation with no bind parameter') => ({ rung: 'symbolic', check, result });
const ci = result => ({ rung: 'ci_output', check: 'existing CI run: test_orders fails on head', result });
const jev = result => ({ rung: 'cross_family_llm', check: 'jev noul sql_injection over the changed hunk', result });
const compose = (evidence, ...rest) => composeChain('c-0142', 'P1', evidence, ...rest);

// The cap is the reason the ladder exists. Without it a confident model produces a
// confident finding, which is exactly the failure the design is built to prevent.
test('LLM-only evidence caps at moderate whatever the probability', () => {
  const chain = compose([jev(0.99)]);
  assert.equal(chain.verdict, 'confirmed');
  assert.equal(chain.verifierConfidence, 'moderate');
});

test('high confidence needs a deterministic hit and the model agreeing', () => {
  assert.equal(compose([symbolic('hit'), jev(0.94)]).verifierConfidence, 'high');
  assert.equal(compose([ci('hit'), jev(0.94)]).verifierConfidence, 'high');
  // One rung alone never reaches high, however strong it is on its own.
  assert.equal(compose([symbolic('hit')]).verifierConfidence, 'moderate');
  assert.equal(compose([symbolic('hit'), symbolic('hit', 'call graph: reachable from a route')]).verifierConfidence, 'moderate');
});

// A deterministic fact outvoted by a model is the failure mode this rule exists for.
// Two agreeing rungs against one symbolic hit must not silently confirm or refute.
test('a symbolic hit the model contradicts goes to a person, not to a majority', () => {
  const chain = compose([symbolic('hit'), jev(0.05)]);
  assert.equal(chain.verdict, 'inconclusive');
  assert.equal(chain.verifierConfidence, 'low');
  assert.equal(chain.routeToHuman, true);
});

test('a symbolic refutation ends the claim at high confidence', () => {
  const chain = compose([symbolic('miss', 'AST: value is a module-level literal, never caller-supplied')]);
  assert.equal(chain.verdict, 'refuted');
  assert.equal(chain.verifierConfidence, 'high');
  assert.equal(chain.finalSeverity, undefined, 'a refuted claim carries no severity');
});

// A model that likes the claim does not rescue it from a deterministic refutation.
test('a refutation is not weakened by a model that disagrees with it', () => {
  assert.equal(compose([symbolic('miss'), jev(0.97)]).verdict, 'refuted');
  assert.equal(compose([symbolic('miss'), jev(0.97)]).verifierConfidence, 'high');
});

// The smoke test found merge_ready at 0.49, 0.41 and 0.27 and called it almost no
// information. A probability in that band must not count as agreement or denial.
test('a probability in the neutral band is neither agreement nor disagreement', () => {
  for (const probability of [0.49, 0.41, 0.31, 0.69]) {
    assert.equal(compose([symbolic('hit'), jev(probability)]).verifierConfidence, 'moderate',
      `${probability} should neither raise to high nor route to a human`);
    assert.equal(compose([jev(probability)]).verdict, 'inconclusive');
  }
});

test('thresholds are configurable and the defaults are only a starting point', () => {
  assert.equal(compose([symbolic('hit'), jev(0.6)]).verifierConfidence, 'moderate');
  assert.equal(compose([symbolic('hit'), jev(0.6)], { agreeAtOrAbove: 0.55, disagreeAtOrBelow: 0.2 }).verifierConfidence, 'high');
  assert.equal(DEFAULT_THRESHOLDS.agreeAtOrAbove, 0.7);
});

// Rung 2 being unavailable is recorded, not silently skipped: on a corpus with no CI
// output the ladder is genuinely shorter, and a reader has to be able to see that.
test('a missing rung 2 is recorded as a limitation rather than passed over', () => {
  assert.match(compose([symbolic('hit'), jev(0.94)]).limitations[0], /Rung 2 did not fire/);
  assert.deepEqual(compose([symbolic('hit'), ci('hit'), jev(0.94)]).limitations, []);
});

test('a confirmed claim carries a severity the verifier may have changed', () => {
  assert.equal(compose([symbolic('hit')]).finalSeverity, 'P1');
  assert.equal(compose([symbolic('hit')], DEFAULT_THRESHOLDS, 'P3').finalSeverity, 'P3');
});

test('a claim with no evidence at all is a programming error, not an inconclusive', () => {
  assert.throws(() => compose([]), /needs a chain even when refuted/);
});

// Spending rung 2 or rung 3 on a settled claim buys nothing and invites a model to
// argue with a deterministic fact.
test('climbing stops at a symbolic refutation', () => {
  const run = [];
  const runner = (rung, evidence) => ({ rung, run: () => { run.push(rung); return evidence; } });
  const evidence = climb([
    runner('symbolic', [symbolic('miss')]),
    runner('ci_output', [ci('hit')]),
    runner('cross_family_llm', [jev(0.9)]),
  ]);
  assert.deepEqual(run, ['symbolic']);
  assert.equal(evidence.length, 1);
});

test('climbing continues past a symbolic hit', () => {
  const run = [];
  const runner = (rung, evidence) => ({ rung, run: () => { run.push(rung); return evidence; } });
  climb([runner('symbolic', [symbolic('hit')]), runner('ci_output', []), runner('cross_family_llm', [jev(0.9)])]);
  assert.deepEqual(run, ['symbolic', 'ci_output', 'cross_family_llm']);
});
