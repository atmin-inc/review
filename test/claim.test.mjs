import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignClaimIds, claimId, claimRejection, enclosingSymbol, normalizeLocation } from '../dist/claim.js';

const draft = over => ({
  type: 'injection_risk', location: 'orders.py:5', description: 'The query interpolates user_input.',
  suspectedCondition: 'A request reaches this query with a value containing a quote.',
  severity: 'P1', evidenceToCheck: [{ proposition: 'The interpolation is not sanitized upstream.' }], ...over,
});

const BEFORE = ['import db', '', 'def fetch_orders(user_input):', '    query = "..." + user_input',
  '    return db.run(query)', ''].join('\n');
// The same function, pushed down four lines by an unrelated import block above it.
const AFTER = ['import db', 'import json', 'import os', 'import sys', '', 'def fetch_orders(user_input):',
  '    query = "..." + user_input', '    return db.run(query)', ''].join('\n');

// This is the property the whole identity scheme exists for. If a rebase mints a new
// claim, the regression harness cannot diff findings across revisions, and every
// rebase reads as a wave of new findings and a wave of disappeared ones.
test('a rebase that shifts lines does not mint a new claim', () => {
  const before = claimId(draft({ location: 'orders.py:4' }), BEFORE);
  const after = claimId(draft({ location: 'orders.py:7' }), AFTER);
  assert.equal(before, after);
});

test('the same line in a different function is a different claim', () => {
  const source = ['def alpha():', '    run()', '', 'def beta():', '    run()'].join('\n');
  assert.notEqual(claimId(draft({ location: 'a.py:2' }), source), claimId(draft({ location: 'a.py:5' }), source));
});

// The id is a content hash, so the trigger is part of identity: a claim about a
// different condition at the same place is a different claim, not an update.
test('changing the suspected condition mints a new claim', () => {
  assert.notEqual(claimId(draft(), BEFORE),
    claimId(draft({ suspectedCondition: 'A scheduled job calls this with an empty value.' }), BEFORE));
});

test('identity ignores description, severity and confidence', () => {
  const base = claimId(draft(), BEFORE);
  assert.equal(claimId(draft({ description: 'Rewritten wording.' }), BEFORE), base);
  assert.equal(claimId(draft({ severity: 'P3', investigatorConfidence: 0.1 }), BEFORE), base);
});

test('colliding claims within one run get an appended ordinal', () => {
  const claims = assignClaimIds([draft(), draft(), draft({ type: 'data_loss' })], () => BEFORE);
  assert.equal(claims[1].claimId, `${claims[0].claimId}-1`);
  assert.notEqual(claims[2].claimId, claims[0].claimId);
  assert.equal(new Set(claims.map(c => c.claimId)).size, 3);
});

test('enclosing symbol resolves across the corpus languages', () => {
  assert.equal(enclosingSymbol('def fetch(x):\n    return x\n', 2), 'fetch');
  assert.equal(enclosingSymbol('export function build(a) {\n  return a;\n}\n', 2), 'build');
  assert.equal(enclosingSymbol('func (s *Store) Put(k string) {\n\treturn\n}\n', 2), 'Put');
  assert.equal(enclosingSymbol('class Foo {\n  public void doThing(int a) {\n    call();\n  }\n}\n', 3), 'doThing');
  assert.equal(enclosingSymbol('module Api\n  def self.call\n    run\n  end\nend\n', 3), 'call');
  assert.equal(enclosingSymbol('const handler = async (req) => {\n  return 1;\n};\n', 2), 'handler');
});

// File scope is a real answer, not a failure: the claim is then identified by path,
// which is still stable under a rebase.
test('a line at file scope normalizes to the path alone', () => {
  assert.equal(normalizeLocation('config.py:1', 'VALUE = 1\n'), 'config.py');
  assert.equal(normalizeLocation('config.py:1', null), 'config.py');
});

test('an unfalsifiable or malformed claim is rejected at emit time', () => {
  assert.equal(claimRejection(draft(), BEFORE), null);
  assert.match(claimRejection(draft({ evidenceToCheck: [] }), BEFORE), /at least one proposition/);
  assert.match(claimRejection(draft({ suspectedCondition: '  ' }), BEFORE), /not falsifiable/);
  assert.match(claimRejection(draft({ type: 'style_nit' }), BEFORE), /outside the claim vocabulary/);
  assert.match(claimRejection(draft({ severity: 'P9' }), BEFORE), /not a priority/);
  assert.match(claimRejection(draft({ location: 'orders.py:900' }), BEFORE), /does not resolve/);
});

// Wide emission is cheap; unfalsifiable emission is not. A condition that only
// echoes the description gives the verifier nothing to test.
test('a condition that restates the description is rejected', () => {
  assert.match(claimRejection(draft({ suspectedCondition: 'The query interpolates user_input!' }), BEFORE),
    /restates description/);
});

// Found by running the extractor over this repository's own source: `if (ready) {`
// matched the method pattern and anchored claims to a symbol named "if", which
// merges unrelated claims in unrelated files onto one normalized location.
test('a control-flow statement is never mistaken for a definition', () => {
  const source = ['function handle(job) {', '  if (job.ready) {', '    commit();', '  }', '}'].join('\n');
  assert.equal(enclosingSymbol(source, 3), 'handle');
  assert.equal(enclosingSymbol('function run() {\n  return new Promise(done => {\n    work();\n  });\n}', 3), 'run');
  for (const line of ['  for (const x of xs) {', '  while (going) {', '  } catch (error) {', '  switch (kind) {']) {
    assert.equal(enclosingSymbol(`function outer() {\n${line}\n    body();\n  }\n}`, 3), 'outer');
  }
});
