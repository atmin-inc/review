import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, persist, current } from './helpers.mjs';
import { previousReview, runClaimReviewAsResult } from '../dist/claim-result.js';
import { capture, loadReview } from '../dist/snapshot.js';
import { MAX_DIFF_BYTES } from '../dist/claim-run.js';
import { failurePathInstruction } from '../dist/investigator.js';
import { assess } from '../dist/assessment.js';
import { readVerification } from '../dist/verification.js';
import { runView } from '../dist/github/dashboard-view.js';
import { meteredCost, price, reservedCost } from '../dist/investigation.js';

// The GitHub worker and the `review` command publish from result.json. These tests hold
// the bridge to what the worker needs: a confirmed claim becomes a finding the existing
// publication path accepts, a refuted one does not, and nothing is spent twice.

const profile = { provider: 'openai', model: 'gpt-5.4-2026-03-05', maxUsd: 2, maxTurns: 6,
  maxToolCalls: 20, maxInputTokens: 50000, maxOutputTokens: 4096, deadlineMs: 600000 };
const action = (name, args) => ({ id: `${name}-${Math.random()}`, name, arguments: JSON.stringify(args) });
const claim = (severity, extra = {}) => ({
  type: 'auth_bypass', location: 'update.ts:2', severity,
  description: 'update() returns without comparing owner to account.',
  suspectedCondition: 'A different account submits a known record id.',
  evidenceToCheck: [{ proposition: 'No ownership comparison remains in the function body.',
    check: { assertion: 'body_contains', symbol: 'update', pattern: 'owner !== account', expect: 'absent' } }], ...extra });
const REFUTED = { type: 'contract_break', location: 'update.ts:1', severity: 'P1',
  description: 'update() is called from other modules that assume the old signature.',
  suspectedCondition: 'Another module calls update() and relies on the throw.',
  evidenceToCheck: [{ proposition: 'update is referenced outside update.ts.',
    check: { assertion: 'referenced_outside', symbol: 'update', path: 'update.ts' } }] };
// The failure-path pass is a second investigation over the same change. A test that
// scripts only the main pass has it end at once with nothing recorded.
function model(steps) {
  let index = 0;
  return {
    async count() { return 1000; },
    async respond(input) {
      const next = input.instructions.includes(failurePathInstruction)
        ? { id: `end-${Math.random()}`, name: 'end_investigation', arguments: JSON.stringify({ complete: true, limitations: [] }) }
        : steps[index++];
      const step = typeof next === 'function' ? next(input) : next;
      return { model: profile.model, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0,
        status: 'completed', continuation: [], calls: Array.isArray(step) ? step : step ? [step] : [] };
    },
    toolOutput: (id, value) => ({ id, value }),
  };
}
// The titling call's reply: a short title for every finding it was sent.
const titled = input => action('record_titles', { titles: JSON.parse(input.context).findings
  .map(finding => ({ claimId: finding.claimId, title: 'Update skips the ownership check' })) });
// Tests must never reach the live rung-3 API, whatever the environment holds.
function withoutJev(t) {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved; });
}

test('a confirmed claim is published as a finding and a refuted one is not', async t => {
  withoutJev(t);
  const directory = persist(repository(t));
  await runClaimReviewAsResult(directory, profile, undefined, model([
    [action('record_claim', claim('P1')), action('record_claim', REFUTED)],
    action('end_investigation', { complete: true, limitations: [] })]));

  // loadReview re-validates every anchor against the frozen Git objects, which is what
  // the worker does before it publishes.
  const { packet, result } = loadReview(directory);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.findings.map(f => [f.priority, f.category, f.anchor.path, f.anchor.line]), [['P1', 'security', 'update.ts', 2]]);
  assert.ok(result.coverage.every(c => c.status === 'reviewed'));
  const assessment = assess(packet, result, current());
  assert.equal(assessment.outcome, 'Changes needed');
  assert.match(result.limitations.join(' '), /cross-family rung was off/);

  // The claim record is kept under its own name, so the worker's local fix checks, which
  // write verification.json, can neither overwrite it nor misread it.
  assert.equal(existsSync(join(directory, 'verification.json')), false);
  assert.equal(JSON.parse(readFileSync(join(directory, 'claim-verification.json'), 'utf8')).chains.length, 2);
  assert.deepEqual(readVerification(directory, packet, result.findings).checks, []);

  // The dashboard reads spend from receipt.json; a finished run's spend is metered.
  const view = runView({ repository: 'o/r' }, { id: 'j', pr: 1, state: 'completed', created: 0, started: 1, report: null, artifact: directory });
  assert.equal(view.usage.model, profile.model);
  assert.ok(view.usage.totalUsd > 0);

  // One run per snapshot: a second call must refuse before any model is asked.
  let asked = false;
  await assert.rejects(runClaimReviewAsResult(directory, profile, undefined, { ...model([]), async respond() { asked = true; } }),
    /existing investigation/);
  assert.equal(asked, false);
});

test('a withheld minor finding is listed, not published, and a run that stops claims no coverage', async t => {
  withoutJev(t);
  const minor = persist(repository(t));
  await runClaimReviewAsResult(minor, profile, undefined, model([
    action('record_claim', claim('P3')), action('end_investigation', { complete: true, limitations: [] })]));
  const withheld = loadReview(minor).result;
  assert.equal(withheld.findings.length, 0);
  assert.match(withheld.limitations.join(' '), /1 confirmed minor \(P3\) finding\(s\) withheld: update\.ts:2/);

  // No end_investigation: the turn limit stops the run with its claim recorded.
  const stopped = persist(repository(t));
  await runClaimReviewAsResult(stopped, { ...profile, maxTurns: 2 }, undefined, model([action('record_claim', claim('P1')), action('record_claim', REFUTED)]));
  const { packet, result } = loadReview(stopped);
  assert.equal(result.status, 'partial');
  assert.ok(result.coverage.every(c => c.status === 'unreviewed'));
  assert.equal(result.findings.length, 1);
  assert.equal(assess(packet, result, current()).scope, 'partial');
  // A run that stopped with every request answered has a known cost; one whose request went
  // unanswered holds a reservation, which is not shown as metered.
  const receipt = JSON.parse(readFileSync(join(stopped, 'receipt.json'), 'utf8'));
  assert.ok(receipt.calls[0].meteredUsd > 0); assert.equal(receipt.calls[0].meteredUsd, receipt.calls[0].reservedUsd);
  const cut = persist(repository(t)), script = model([action('record_claim', claim('P1'))]);
  let calls = 0;
  await runClaimReviewAsResult(cut, profile, undefined, { ...script, async respond(input) { if (++calls === 2) throw new Error('socket hang up'); return script.respond(input); } });
  assert.equal(JSON.parse(readFileSync(join(cut, 'receipt.json'), 'utf8')).calls[0].meteredUsd, null);
});

test('OpenRouter spend is what OpenRouter billed for each call, and an unconfirmed charge is never shown as a cost', async t => {
  // Customers are billed from this figure. OpenRouter charges uncached input at its
  // cache-write price, 25% over the listed rate, so the rate card undercounted by 15-20%.
  withoutJev(t);
  const luna = { ...profile, provider: 'openrouter', model: 'openai/gpt-6-luna' };
  const billed = (cost) => {
    const script = model([action('record_claim', claim('P1')), done(), titled]);
    const made = { calls: 0 };
    return { made, model: { ...script, async respond(input) { made.calls++; return { ...(await script.respond(input)), model: luna.model, reportedCostUsd: cost }; } } };
  };
  // What Luna bills for 1000 uncached input and 50 output tokens, above its listed 0.000125.
  const paid = persist(repository(t)), run = billed(0.00015);
  await runClaimReviewAsResult(paid, luna, undefined, run.model);
  const receipt = JSON.parse(readFileSync(join(paid, 'receipt.json'), 'utf8'));
  assert.equal(receipt.calls.at(-1).purpose, 'titles'); assert.equal(receipt.calls.at(-1).meteredUsd, 0.00015);
  assert.ok(Math.abs(receipt.calls[0].meteredUsd - 0.00015 * (run.made.calls - 1)) < 1e-12);
  const view = runView({ repository: 'o/r' }, { id: 'j', pr: 1, state: 'completed', created: 0, started: 1, report: null, artifact: paid });
  assert.ok(Math.abs(view.usage.totalUsd - 0.00015 * run.made.calls) < 1e-12);
  // No reported charge: the spend is unknown, so the dashboard and billing count it as unsettled.
  const unknown = persist(repository(t));
  await runClaimReviewAsResult(unknown, luna, undefined, billed(undefined).model);
  const unconfirmed = JSON.parse(readFileSync(join(unknown, 'receipt.json'), 'utf8'));
  assert.deepEqual(unconfirmed.calls.map(call => call.meteredUsd), [null, null]);
  assert.equal(runView({ repository: 'o/r' }, { id: 'j', pr: 1, state: 'completed', created: 0, started: 1, report: null, artifact: unknown }).usage.totalUsd, null);
});

test('Luna direct from OpenAI is priced with its cache writes and long-prompt rate, and usage without cache writes is never shown as a cost', async t => {
  // Customers are billed from this figure. OpenAI bills prompt tokens written to its cache at
  // 1.25x input, and a prompt over 272K tokens at 2x input and cache rates and 1.5x output.
  // Pricing either at the plain input rate undercounts, as the OpenRouter rate card did.
  withoutJev(t);
  const direct = { ...profile, model: 'gpt-6-luna' };
  const replying = (usage) => {
    const script = model([action('record_claim', claim('P1')), done(), titled]);
    return { ...script, async respond(input) { return { ...(await script.respond(input)), model: direct.model, ...usage }; } };
  };
  const paid = persist(repository(t));
  await runClaimReviewAsResult(paid, direct, undefined, replying({ cachedInputTokens: 600, cacheWriteTokens: 300 }));
  // 1,000 prompt tokens: 600 read from the cache, 300 written to it, 100 plain; 50 output.
  assert.ok(Math.abs(JSON.parse(readFileSync(join(paid, 'receipt.json'), 'utf8')).calls.at(-1).meteredUsd
    - (100 * 0.1 + 600 * 0.01 + 300 * 0.125 + 50 * 0.5) / 1e6) < 1e-15);
  assert.ok(Math.abs(price(300_000, 1000, 100_000, 'gpt-6-luna', 50_000) - ((150_000 * 0.1 + 100_000 * 0.01 + 50_000 * 0.125) * 2 + 1000 * 0.75) / 1e6) < 1e-15);
  assert.equal(price(272_000, 0, 0, 'gpt-6-luna'), 272_000 * 0.1 / 1e6);
  // The budget reserves the dearest case, every prompt token written to the cache.
  assert.equal(reservedCost(direct, 1000, 8192), (1000 * 0.125 + 8192 * 0.5) / 1e6);
  const unknown = persist(repository(t));
  await runClaimReviewAsResult(unknown, direct, undefined, replying({}));
  assert.deepEqual(JSON.parse(readFileSync(join(unknown, 'receipt.json'), 'utf8')).calls.map(call => call.meteredUsd), [null, null]);
  assert.equal(meteredCost(direct, { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800, cacheWriteTokens: 300 }), null);
});

// 128 KB refused 29% of mason-v1's merged PRs. A diff up to 512 KB is reviewed; past that
// the run refuses before any model is asked, so nothing is spent on a review that cannot fit.
test('a 300 KB diff is reviewed and a diff over 512 KB is refused before spending', async t => {
  withoutJev(t);
  const sized = (bytes) => {
    const fixture = repository(t);
    fixture.write('generated.ts', `export const rows = [\n${'  "0123456789abcdef0123456789abcdef",\n'.repeat(Math.ceil(bytes / 40))}];\n`);
    const headSha = fixture.commit('large change');
    const captured = capture(fixture.source, { ...fixture.state, headSha });
    return persist({ ...fixture, ...captured });
  };
  const large = sized(300 * 1024);
  assert.ok(readFileSync(join(large, 'change.diff')).length > 128 * 1024);
  await runClaimReviewAsResult(large, { ...profile, maxInputTokens: 1000000 }, undefined, model([
    action('end_investigation', { complete: true, limitations: [] })]));
  assert.equal(loadReview(large).result.status, 'completed');

  const huge = sized(MAX_DIFF_BYTES + 64 * 1024);
  assert.ok(readFileSync(join(huge, 'change.diff')).length > MAX_DIFF_BYTES);
  let asked = false;
  await assert.rejects(runClaimReviewAsResult(huge, { ...profile, maxInputTokens: 1000000 }, undefined,
    { ...model([]), async respond() { asked = true; } }), /Diff exceeds 512 KB/);
  assert.equal(asked, false);
});

// A push after a completed review: the model reads only the commits since, and the earlier
// review's surviving claims are re-verified at the new head instead of being found again.
function secondPush(t, fixture, write = true) {
  if (write) fixture.write('notes.ts', 'export const note = "added later";\n');
  const headSha = write ? fixture.commit('second push') : fixture.state.headSha;
  return persist({ ...fixture, root: mkdtempSync(join(fixture.root, 'push-')), ...capture(fixture.source, { ...fixture.state, headSha }) });
}
function watching(steps) {
  const inner = model(steps); const seen = [];
  return { seen, model: { ...inner, async respond(input, ...rest) { seen.push(JSON.parse(input.context)); return inner.respond(input, ...rest); } } };
}
const done = () => action('end_investigation', { complete: true, limitations: [] });

test('a push is reviewed incrementally and earlier findings are re-checked, not re-found', async t => {
  withoutJev(t);
  const fixture = repository(t);
  const first = persist(fixture);
  await runClaimReviewAsResult(first, profile, undefined, model([action('record_claim', claim('P1')), done()]));
  const second = secondPush(t, fixture);
  writeFileSync(join(second, 'previous.json'), JSON.stringify(previousReview(first)));
  const run = watching([done()]);
  await runClaimReviewAsResult(second, profile, undefined, run.model);

  const context = run.seen[0];
  assert.equal(context.incrementalSince, fixture.state.headSha);
  assert.match(context.diff, /notes\.ts/);
  assert.doesNotMatch(context.diff, /owner !== account/);
  const { result } = loadReview(second);
  assert.deepEqual(result.findings.map(f => [f.priority, f.anchor.path, f.anchor.line]), [['P1', 'update.ts', 2]]);
  assert.match(result.summary, /^Incremental review since/);
  assert.match(result.limitations.join(' '), /Incremental review: new claims were sought only in the commits since/);
  assert.equal(JSON.parse(readFileSync(join(second, 'carried-claims.json'), 'utf8')).length, 1);
  // A third push carries the finding again, from the carried record this time.
  assert.equal(previousReview(second).claims.length, 1);
});

// The worker deletes a run's repository copy once the run ends, so a push review must be
// able to build on the earlier run from its JSON records alone.
test('a push review builds on an earlier run whose repository copy was deleted', async t => {
  withoutJev(t);
  const fixture = repository(t);
  const first = persist(fixture);
  await runClaimReviewAsResult(first, profile, undefined, model([action('record_claim', claim('P1')), done()]));
  rmSync(join(first, 'source.git'), { recursive: true });
  const second = secondPush(t, fixture);
  writeFileSync(join(second, 'previous.json'), JSON.stringify(previousReview(first)));
  await runClaimReviewAsResult(second, profile, undefined, model([done()]));
  const { result } = loadReview(second);
  assert.deepEqual(result.findings.map(f => [f.priority, f.anchor.path, f.anchor.line]), [['P1', 'update.ts', 2]]);
});

// Measured 2026-09-24 on a real push: the fix added a guard that none of the claim's recorded
// propositions mention, so re-verifying them confirmed the fixed defect again. Here the fix
// calls a helper instead of writing `owner !== account`, so the recorded check (that text is
// absent) still holds at the new head. A claim in a file the push changed is shown to the
// model and survives only if the model records it again.
function snapshotAt(fixture, headSha) {
  return persist({ ...fixture, root: mkdtempSync(join(fixture.root, 'push-')), ...capture(fixture.source, { ...fixture.state, headSha }) });
}
function fixCommit(fixture) {
  fixture.write('update.ts', 'export function update(owner, account) {\n  assertOwner(owner, account);\n  return "updated";\n}\n');
  return fixture.commit('fix ownership');
}

test('a finding in a file the push changed is re-asked, not carried, so a fix outside its checks drops it', async t => {
  withoutJev(t);
  const fixture = repository(t);
  const first = persist(fixture);
  await runClaimReviewAsResult(first, profile, undefined, model([action('record_claim', claim('P1')), done()]));
  const earlier = previousReview(first);

  const fixHead = fixCommit(fixture);
  const fixed = snapshotAt(fixture, fixHead);
  writeFileSync(join(fixed, 'previous.json'), JSON.stringify(earlier));
  const run = watching([done()]);
  await runClaimReviewAsResult(fixed, profile, undefined, run.model);
  assert.deepEqual(run.seen[0].earlierFindings.map(f => f.location), ['update.ts:2']);
  assert.match(run.seen[0].scope, /record again/);
  const { result } = loadReview(fixed);
  assert.deepEqual(result.findings, [], 'the fixed finding is not carried on its own');
  assert.deepEqual(JSON.parse(readFileSync(join(fixed, 'carried-claims.json'), 'utf8')), []);
  assert.match(result.limitations.join(' '), /1 earlier finding\(s\) were in files this push changed, so they were re-asked rather than carried; 0 were recorded again/);
  // The fixed finding does not come back on the push after this one.
  assert.equal(previousReview(fixed).claims.length, 0);

  // When the model finds it still holds and records it again, it is verified and kept.
  const still = snapshotAt(fixture, fixHead);
  writeFileSync(join(still, 'previous.json'), JSON.stringify(earlier));
  await runClaimReviewAsResult(still, profile, undefined, model([action('record_claim', claim('P1')), done()]));
  const kept = loadReview(still).result;
  assert.deepEqual(kept.findings.map(f => [f.priority, f.anchor.path]), [['P1', 'update.ts']]);
  assert.match(kept.limitations.join(' '), /1 were recorded again/);
});

test('nothing new to read asks no model; a moved merge base or a rewritten head gets a full review', async t => {
  withoutJev(t);
  const fixture = repository(t);
  const first = persist(fixture);
  await runClaimReviewAsResult(first, profile, undefined, model([action('record_claim', claim('P1')), done(), titled]));
  const earlier = previousReview(first);
  assert.deepEqual(Object.values(earlier.titles), ['Update skips the ownership check']);

  const same = secondPush(t, fixture, false);
  writeFileSync(join(same, 'previous.json'), JSON.stringify(earlier));
  let asked = false;
  await runClaimReviewAsResult(same, profile, undefined, { ...model([]), async respond() { asked = true; } });
  assert.equal(asked, false, 'the carried finding keeps its title, so nothing is asked');
  assert.equal(loadReview(same).result.findings.length, 1);
  assert.equal(loadReview(same).result.findings[0].title, 'Update skips the ownership check');
  assert.equal(loadReview(same).result.status, 'completed');

  for (const [previous, reason] of [[{ ...earlier, mergeBaseSha: 'e'.repeat(40) }, /merge base moved/],
    [{ ...earlier, headSha: 'f'.repeat(40) }, /not an ancestor/]]) {
    const full = secondPush(t, fixture, false);
    writeFileSync(join(full, 'previous.json'), JSON.stringify(previous));
    const run = watching([done()]);
    await runClaimReviewAsResult(full, profile, undefined, run.model);
    assert.equal(run.seen[0].incrementalSince, undefined);
    assert.match(run.seen[0].diff, /owner !== account/);
    assert.match(loadReview(full).result.limitations.join(' '), reason);
  }
});

test('a partial earlier review is not built on', async t => {
  withoutJev(t);
  const stopped = persist(repository(t));
  await runClaimReviewAsResult(stopped, { ...profile, maxTurns: 2 }, undefined, model([action('record_claim', claim('P1')), action('record_claim', REFUTED)]));
  assert.equal(previousReview(stopped), null);
});

// A change can break a caller it never touched. That caller is where the defect is, so it
// must be published as a finding, not hidden in the limitations under a clean verdict.
test('a confirmed claim on an unchanged caller is a finding and the verdict says so', async t => {
  withoutJev(t);
  const fixture = repository(t);
  // Put a caller at the merge base, then change only update.ts on the branch.
  fixture.run('checkout', '-q', fixture.state.baseSha);
  fixture.write('caller.ts', 'import { update } from "./update";\nexport const run = (a, b) => update(a, b);\n');
  const baseSha = fixture.commit('base with caller');
  fixture.write('update.ts', 'export function update(owner, account) {\n  return "updated";\n}\n');
  const headSha = fixture.commit('drop the guard');
  const state = { ...fixture.state, baseSha, headSha };
  const directory = persist({ ...fixture, root: mkdtempSync(join(fixture.root, 'caller-')), ...capture(fixture.source, state) });
  const onCaller = claim('P1', { type: 'contract_break', location: 'caller.ts:2',
    description: 'run() still relies on update() refusing a mismatched owner.',
    evidenceToCheck: [{ proposition: 'caller.ts calls update.', check: { assertion: 'file_contains', path: 'caller.ts', pattern: 'update(a, b)' } }] });
  await runClaimReviewAsResult(directory, profile, undefined, model([action('record_claim', onCaller), done()]));
  const { packet, result } = loadReview(directory);
  assert.deepEqual(packet.changedFiles.map(f => f.path), ['update.ts']);
  assert.deepEqual(result.findings.map(f => [f.anchor.path, f.anchor.line]), [['caller.ts', 2]]);
  assert.equal(assess(packet, result, current()).outcome, 'Changes needed');
});

test('confirmed findings get a short title and no placeholder fix; a failed titling call falls back and says why', async t => {
  withoutJev(t);
  const steps = [action('record_claim', claim('P1')), done()];
  const titledRun = persist(repository(t));
  let sent;
  await runClaimReviewAsResult(titledRun, profile, undefined, model([...steps, input => { sent = JSON.parse(input.context); return titled(input); }]));
  // Only the confirmed claim is sent to be titled, so titling cannot reach a refuted one.
  assert.equal(sent.findings.length, 1);
  const { packet, result } = loadReview(titledRun);
  assert.equal(result.findings[0].title, 'Update skips the ownership check');
  assert.equal(result.findings[0].suggestion, undefined);
  const { renderMarkdown } = await import('../dist/render.js');
  const report = renderMarkdown(packet, result, assess(packet, result, current()));
  assert.ok(!report.includes('did not propose a specific change'));
  assert.equal(report.split('without comparing owner to account').length - 1, 1, 'the description appears once');
  const receipt = JSON.parse(readFileSync(join(titledRun, 'receipt.json'), 'utf8'));
  assert.equal(receipt.calls.at(-1).purpose, 'titles');
  assert.ok(receipt.calls.at(-1).meteredUsd > 0);

  const failed = persist(repository(t));
  await runClaimReviewAsResult(failed, profile, undefined, model([...steps, action('record_titles', { titles: [{ claimId: 'x', title: 'Line one\nline two' }] })]));
  const fallback = loadReview(failed).result;
  assert.equal(fallback.findings[0].title, 'update() returns without comparing owner to account.');
  assert.match(fallback.limitations.join(' '), /titles were not written \(invalid-reply\)/);
});
