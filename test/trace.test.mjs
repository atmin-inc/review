import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTrace, traceEvent, traceOperation } from '../dist/trace.js';
import { openRouterModel } from '../dist/openrouter-model.js';
import { runReview } from '../dist/run.js';
import { repository, persist, finalReport } from './helpers.mjs';
import { probeInput, runProbe } from '../benchmarks/reporting-probe.mjs';
import { historyCases } from '../benchmarks/reporting-history.mjs';
import { sourceSlice } from '../dist/snapshot.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/smoke-openrouter-free.json', import.meta.url)));
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'atmin-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
test('real review tracing correlates phases, provider timing and tools without recording content', async t => {
  const f = repository(t), path = persist(f);
  f.write('untracked-secret.txt', 'never-trace-source');
  const adapter = openRouterModel(profile, 'never-trace-api-key', async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: profile.model, canonical_slug: 'cohere/north-mini-code-20260617',
      pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'tool_choice'] }] });
    const discovering = JSON.parse(options.body).tools.some(t => t.function.name === 'end_investigation');
    const args = { complete: false, limitations: ['never-trace-arguments'] };
    return Response.json({ id: 'gen-test', model: profile.model, usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
      choices: [{ finish_reason: 'tool_calls', message: { content: 'never-trace-prose', reasoning_details: ['never-trace-reasoning'],
        tool_calls: [{ id: 'finish', function: { name: discovering ? 'end_investigation' : 'finish', arguments: JSON.stringify(discovering ? args : finalReport(args)) } }] } }] });
  });
  await runReview(path, profile, adapter);
  const text = readFileSync(join(path, 'trace.ndjson'), 'utf8');
  for (const value of ['never-trace-api-key', 'never-trace-prose', 'never-trace-reasoning', 'never-trace-arguments', 'never-trace-source', 'owner !== account']) assert.ok(!text.includes(value));
  const events = text.trim().split('\n').map(JSON.parse);
  for (const name of ['review.config', 'review.request', 'provider.headers', 'provider.body', 'provider.response', 'provider.inference', 'review.tool', 'budget.settled', 'review.result']) assert.ok(events.some(event => event.name === name), name);
  assert.equal(new Set(events.map(event => event.args.traceId)).size, 1);
  assert.ok(events.filter(event => event.ph === 'X').every(event => event.dur >= 0));
  assert.equal(statSync(join(path, 'trace.ndjson')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'trace.perfetto.json'))).traceEvents, events);
  await assert.rejects(runReview(path, profile, adapter), /already started/);
});
test('trace failures record boundaries without exposing raw transport errors; concurrent runs stay separate', async t => {
  const root = directory(t), a = join(root, 'a'), b = join(root, 'b'); mkdirSync(a); mkdirSync(b);
  const results = await Promise.allSettled([withTrace(a, () => traceOperation('request', { request: 1 }, async () => { throw new Error('never-trace-transport-secret'); })),
    withTrace(b, async () => traceEvent('other-run'))]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
  const first = readFileSync(join(a, 'trace.ndjson'), 'utf8'), second = readFileSync(join(b, 'trace.ndjson'), 'utf8');
  assert.ok(first.includes('threw')); assert.ok(!first.includes('never-trace-transport-secret'));
  assert.ok(!first.includes('other-run')); assert.ok(second.includes('other-run'));
});
test('telemetry storage is bounded and a failed viewer export does not change the operation result', async t => {
  const root = directory(t); mkdirSync(join(root, 'trace.perfetto.json'));
  assert.equal(await withTrace(root, async () => {
    for (let i = 0; i < 1000; i++) traceEvent('bounded-fixture', { value: 'x'.repeat(8192) });
    return 42;
  }), 42);
  assert.ok(statSync(join(root, 'trace.ndjson')).size <= 4 * 1024 * 1024);
});
test('reporting probes keep source tools out of both variants and reserve before paid inference', async t => {
  const old = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'never-trace-probe-key';
  t.after(() => { if (old === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = old; });
  assert.deepEqual(probeInput(false).tools.map(tool => tool.name), ['finish']);
  assert.deepEqual(probeInput(true).tools.map(tool => tool.name), ['finish']);
  assert.equal(probeInput(false).context, probeInput(true).context);
  const out = join(directory(t), 'probes'); let posts = 0;
  const cases = await runProbe(out, async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'deepseek/deepseek-v3.2', canonical_slug: 'deepseek/deepseek-v3.2-20251201', supported_parameters: ['tools', 'tool_choice'] }] });
    if (url.endsWith('/endpoints')) return Response.json({ data: { endpoints: [{ tag: 'novita/fp8', status: 0, supports_tool_choice: { required: true }, supported_parameters: ['tools'], pricing: { prompt: '0.000000269', completion: '0.0000004' } }] } });
    posts++;
    const receipt = JSON.parse(readFileSync(join(out, 'fresh-default/probe.json')));
    assert.equal(receipt.dispatched, true); assert.ok(receipt.reservedUsd > 0 && receipt.reservedUsd <= 0.05);
    assert.deepEqual(JSON.parse(options.body).tools.map(tool => tool.function.name), ['finish']);
    return Response.json({ error: { message: 'never-trace-provider-secret' } }, { status: 402 });
  });
  assert.equal(posts, 1); assert.equal(cases.length, 1); assert.equal(cases[0].meteredUsd, null);
  assert.equal(cases[0].failure.kind, 'funding');
  assert.ok(!readFileSync(join(out, 'fresh-default/trace.ndjson'), 'utf8').includes('never-trace-provider-secret'));
});
test('history and handoff preserve the same immutable work and reject corrupted evidence before inference', async t => {
  const f = repository(t), path = persist(f), result = JSON.parse(readFileSync(join(path, 'result.json')));
  result.status = 'partial';
  result.evidence = ['base', 'head'].map((side, index) => {
    const { text, ...capture } = sourceSlice(join(path, 'source.git'), side === 'head' ? f.packet.headSha : f.packet.mergeBaseSha, 'update.ts', 1, 2);
    return { id: `read-${index + 1}`, kind: 'source-read', provenance: 'controller-captured', summary: 'Fixture read.',
      anchors: [{ path: 'update.ts', side, line: 1 }], capture };
  });
  writeFileSync(join(path, 'result.json'), JSON.stringify(result));
  f.write('update.ts', 'never-use-dirty-source');
  const variants = historyCases(path);
  assert.equal(variants.length, 6);
  assert.equal(historyCases(path, 1).length, 2);
  assert.throws(() => historyCases(path, 4), /1–3 diagnostic pairs/);
  assert.deepEqual(variants.map(v => v.history), [true, false, false, true, true, false]);
  const history = variants[0].input, handoff = variants[1].input;
  const { frozenInvestigation, ...context } = JSON.parse(handoff.context);
  assert.deepEqual(context, JSON.parse(history.context));
  assert.equal(handoff.transcript.length, 0);
  assert.deepEqual(history.tools.map(tool => tool.name), ['finish']);
  for (const [index, step] of frozenInvestigation.entries()) {
    const call = history.transcript[index * 2].tool_calls[0];
    assert.equal(call.id, step.id); assert.equal(call.function.name, step.name);
    assert.deepEqual(JSON.parse(call.function.arguments), step.arguments);
    assert.deepEqual(JSON.parse(history.transcript[index * 2 + 1].content), step.output);
  }
  assert.ok(!JSON.stringify(variants).includes('never-use-dirty-source'));
  await assert.rejects(runProbe(join(path, 'invalid'), fetch, [...variants, variants[0]]), /Invalid diagnostic cases/);
  await assert.rejects(runProbe(join(path, 'invalid'), fetch, variants, 120001), /deadline exceeds/);
  await assert.rejects(runProbe(join(path, 'invalid'), fetch, [{ ...variants[0], id: '../escape' }]), /Invalid diagnostic cases/);
  result.evidence[0].capture.contentHash = 'a'.repeat(64);
  writeFileSync(join(path, 'result.json'), JSON.stringify(result));
  assert.throws(() => historyCases(path), /immutable range and digest/);
});
