import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, reviewSummary } from '../dist/assessment.js';
import { initialResult, defaultPolicy, parsePolicy, parseResult } from '../dist/contracts.js';
import { renderMarkdown } from '../dist/render.js';
import { repository, completed, finding, current } from './helpers.mjs';

test('not-started capture cannot be a clean review', t => {
  const { packet } = repository(t);
  const result = initialResult(packet);
  const a = assess(packet, result, current());
  assert.equal(a.outcome, 'Review incomplete');
  assert.equal(a.scope, 'unavailable');
  assert.equal(a.validation, 'missing');
  const forged = completed(packet);
  forged.status = 'not-started';
  assert.throws(() => assess(packet, forged, current()), /not-started investigation/);
});

for (const priority of ['P0', 'P1', 'P2', 'P3', 'P4']) {
  test(`${priority} follows the deterministic severity policy`, t => {
    const { packet } = repository(t);
    packet.policy.includeOptional = true;
    const result = completed(packet);
    result.findings = [finding(priority)];
    const a = assess(packet, result, current());
    assert.equal(a.outcome, ['P0', 'P1', 'P2'].includes(priority) ? 'Changes needed' : 'Suggestions');
    assert.equal(a.findings[0].priority, priority);
  });
}

test('a P0 cannot be averaged away by optional suggestions', t => {
  const { packet } = repository(t);
  packet.policy.includeOptional = true;
  const result = completed(packet);
  result.findings = [finding('P0'), ...Array.from({ length: 10 }, (_, i) => ({ ...finding('P4'), id: `optional-${i}` }))];
  assert.equal(assess(packet, result, current()).outcome, 'Changes needed');
});

test('optional P4 is hidden by default and cannot become a defect', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  result.findings = [finding('P4')];
  const a = assess(packet, result, current());
  assert.equal(a.outcome, 'No issues found');
  assert.equal(a.hiddenOptionalCount, 1);
  result.findings[0].kind = 'defect';
  assert.throws(() => assess(packet, result, current()), /P4 is an optional improvement/);
});

test('no findings requires complete coverage, required validation and freshness', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  assert.equal(assess(packet, result, current()).outcome, 'No issues found');
  assert.equal(assess(packet, result).outcome, 'Unverified');
  result.coverage[0].status = 'unreviewed';
  assert.equal(assess(packet, result, current()).outcome, 'Review incomplete');
  result.coverage[0].status = 'reviewed';
  result.validation = [];
  assert.equal(assess(packet, result, current()).outcome, 'Validation needed');
});

test('required check failure is not a pass; source reasoning cannot claim execution', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  result.validation[0] = { name: 'change-validation', status: 'fail', reason: 'Declared fixture failure.', evidenceIds: ['source-0'] };
  assert.throws(() => assess(packet, result, current()), /reproduction or CI/);
  result.evidence[0].kind = 'reproduction';
  let a = assess(packet, result, current());
  assert.equal(a.validation, 'failed');
  assert.equal(a.outcome, 'Validation needed');
  result.validation[0].status = 'pass';
  a = assess(packet, result, current());
  assert.equal(a.validation, 'passed');
  assert.equal(a.outcome, 'No issues found');
});

test('a clean headline is impossible across incomplete, failing and stale combinations', t => {
  const { packet } = repository(t);
  for (const status of ['completed', 'partial']) {
    for (const checkStatus of ['pass', 'fail', 'not-run']) {
      for (const freshness of ['current', 'unverified', 'superseded']) {
        const result = completed(packet);
        result.status = status;
        result.evidence[0].kind = 'reproduction';
        result.validation[0] = { name: 'change-validation', status: checkStatus, reason: 'Matrix fixture.', evidenceIds: ['source-0'] };
        const a = assess(packet, result, { ...current(), status: freshness });
        assert.equal(a.outcome === 'No issues found', status === 'completed' && checkStatus === 'pass' && freshness === 'current');
      }
    }
  }
});

test('found defects remain visible on partial and superseded results', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  result.status = 'partial';
  result.findings = [finding('P1')];
  assert.equal(assess(packet, result, current()).outcome, 'Changes needed');
  const a = assess(packet, result, { ...current(), status: 'superseded' });
  assert.equal(a.outcome, 'Superseded');
  assert.equal(a.findingsVerdict, 'Changes needed');
  assert.equal(a.findings.length, 1);
});

test('strict schema rejects extra score, empty reasoning and false attestation', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  assert.throws(() => parseResult({ ...result, score: 5 }), /Invalid result/);
  assert.throws(() => parseResult({ ...result, summary: '   ' }), /Invalid result/);
  result.evidence[0].provenance = 'controller-captured';
  assert.throws(() => parseResult(result), /Invalid result/);
  assert.deepEqual(parsePolicy({ ...defaultPolicy(), requiredChecks: [] }).requiredChecks, []);
  assert.throws(() => parsePolicy({ ...defaultPolicy(), blockThrough: 'P0' }), /Invalid policy/);
});

test('duplicate, missing and disconnected evidence is rejected', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  result.findings = [finding(), finding()];
  assert.throws(() => assess(packet, result), /Duplicate finding/);
  result.findings = [finding()];
  result.findings[0].evidenceIds = ['absent'];
  assert.throws(() => assess(packet, result), /Unknown evidence/);
  result.findings = [];
  result.coverage[0].evidenceIds = [];
  assert.throws(() => assess(packet, result), /Reviewed coverage needs evidence/);
  result.coverage = [];
  assert.throws(() => assess(packet, result), /every changed path/);
});

test('evidence cannot be relabeled as belonging to another snapshot', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  result.headSha = 'a'.repeat(40);
  assert.throws(() => assess(packet, result), /does not match snapshot/);
});

test('Markdown escapes PR content and explicitly discloses declared evidence', t => {
  const { packet } = repository(t);
  const result = completed(packet);
  result.summary = '<script>alert(1)</script> @everyone [click](https://bad.invalid)';
  result.findings = [finding()];
  result.findings[0].trigger = result.summary;
  const text = renderMarkdown(packet, result, assess(packet, result, current()));
  assert.ok(!text.includes('<script>'));
  assert.ok(!text.includes('@everyone'));
  assert.ok(text.includes('\\[click\\]'));
  assert.ok(text.includes('declared test claims are not independently verified'));
  assert.ok(text.includes('Priority rationale'));
  assert.ok(text.includes(`/blob/${packet.headSha}/update.ts#L2`));
  result.evidence[0].anchors.push({ path: 'callers/(helper).ts', side: 'base', line: 3 });
  const linked = renderMarkdown(packet, result, assess(packet, result, current()));
  assert.ok(linked.includes(`/blob/${packet.mergeBaseSha}/callers/%28helper%29.ts#L3`));
});

test('scan-first report separates clean source from missing CI and never hides incomplete or stale scope', t => {
  const { packet } = repository(t);
  for (const status of ['completed', 'partial']) {
    for (const freshness of ['current', 'superseded', 'unverified']) {
      const result = completed(packet); result.status = status; result.validation = [];
      const report = renderMarkdown(packet, result, assess(packet, result, { ...current(), status: freshness }));
      // Only a finished, current review is scored; missing CI does not withhold it.
      assert.match(report, status === 'completed' && freshness === 'current' ? /^## <img[^>]+> 5\/5 — Waiting for required checks/ : /^## <img[^>]+> Not rated/);
      assert.ok(!report.includes('/review-icons/5.svg'));
      assert.match(report, /Required checks not verified/);
      assert.match(report, /<details><summary>Run summary and checks/);
      assert.equal((report.match(/<details>/g) ?? []).length, (report.match(/<\/details>/g) ?? []).length);
    }
  }
  const result = completed(packet); result.findings = [finding('P1')];
  const report = renderMarkdown(packet, result, assess(packet, result, current()));
  assert.match(report, /^## <img[^>]+> 1\/5 — 1 fix before merge/);
  assert.ok(report.indexOf('**Fix:**') < report.indexOf('<details>'));
});


test('report links to the owned dashboard and derives its summary from the assessment', t => {
  const { packet } = repository(t), result = completed(packet);
  result.findings = [finding('P2')];
  const assessment = assess(packet, result, current());
  const url = 'https://review.atmin.ai/?repository=42#review/abc-123';
  const report = renderMarkdown(packet, result, assessment, url);
  assert.ok(report.includes(`[View full review on atmin](${url})`));
  assert.ok(report.includes('| P0 | P1 | P2 | P3 | P4 |'));
  assert.ok(report.includes('| 0 | 0 | **1** | 0 | 0 |'));
  assert.ok(report.indexOf('**Fix:**') < report.indexOf('<summary>Review details'));
  assert.ok(report.indexOf('<summary>Run summary and checks') < report.indexOf('Changes needed. 1 finding'));
  assert.ok(!report.includes(result.summary));
  assert.ok(!renderMarkdown(packet, result, assessment, 'javascript:alert(1)').includes('javascript:'));
  assert.ok(renderMarkdown(packet, result, assessment, 'https://reviews.example.test/?repository=42#review/abc').includes('[View full review on atmin](https://reviews.example.test/'));
});

test('free-form readiness claims cannot override partial, failed or stale review summaries', t => {
  const { packet } = repository(t);
  for (const status of ['completed', 'partial']) for (const freshness of ['current', 'superseded', 'unverified']) {
    const result = completed(packet); result.status = status;
    result.summary = 'Ready to merge. No problems. 5/5.';
    result.validation = [];
    const assessment = assess(packet, result, { ...current(), status: freshness });
    const report = renderMarkdown(packet, result, assessment);
    assert.ok(!report.includes(result.summary));
    assert.ok(reviewSummary(assessment).includes(assessment.outcome));
    assert.ok(reviewSummary(assessment).includes(status === 'completed' && freshness === 'current' ? 'Rating: 5/5.' : 'Not rated.'));
  }
});

test('icons: every finding carries its priority, the headline follows the score, and every icon referenced exists', async t => {
  const { existsSync } = await import('node:fs');
  const { packet } = repository(t);
  const icons = report => [...report.matchAll(/review-icons\/([\w-]+)\.svg/g)].map(m => m[1]);
  const pass = [{ name: 'change-validation', status: 'pass', reason: 'Synthetic check.' }];
  const cases = [
    [[], pass, '5'],                // clean and nothing outstanding: green
    [[], [{ name: 'change-validation', status: 'not-run', reason: 'Synthetic check.' }], '3'], // 5/5, checks missing: amber
    [['P2'], pass, '3'],            // capped at 3/5
    [['P1', 'P2'], pass, '1'],      // capped at 1/5
  ];
  for (const [priorities, ci, headline] of cases) {
    const result = completed(packet);
    result.findings = priorities.map((p, i) => ({ ...finding(p), id: `f${i}` }));
    const report = renderMarkdown(packet, result, assess(packet, result, current(), ci));
    const [top, ...rest] = icons(report);
    assert.equal(top, headline);
    assert.deepEqual(rest, priorities.map(p => p.toLowerCase()), 'one icon per finding, matching its priority');
  }
  const partial = completed(packet); partial.status = 'partial';
  assert.equal(icons(renderMarkdown(packet, partial, assess(packet, partial, current())))[0], 'unscored');
  for (const name of ['1', '3', '5', 'unscored', 'p0', 'p1', 'p2', 'p3', 'p4']) {
    assert.ok(existsSync(new URL(`../assets/review-icons/${name}.svg`, import.meta.url)), `${name}.svg must be committed`);
  }
});
