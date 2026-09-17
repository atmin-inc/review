import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRouterModel } from '../dist/openrouter-model.js';
import { parseProfile, price, instructions, toolDefinitions, investigate } from '../dist/investigation.js';
import { repository, persist, finalReport } from './helpers.mjs';

const profile = JSON.parse(readFileSync(new URL('../profiles/smoke-openrouter-free.json', import.meta.url)));
const input = { instructions, context: 'owned-fixture', transcript: [], tools: toolDefinitions };
const catalog = (prompt = '0') => ({ data: [{ id: profile.model, canonical_slug: 'cohere/north-mini-code-20260617',
  pricing: { prompt, completion: '0' }, supported_parameters: ['tools', 'tool_choice'] }] });
const response = () => ({ id: 'generation-fixture', model: profile.model, usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0 },
  choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-finish',
    type: 'function', function: { name: 'finish', arguments: JSON.stringify(finalReport({ complete: false })) } }] } }] });
test('tool text schemas preserve complete paths and summaries under whole-string decoding', () => {
  const schemas = [
    toolDefinitions.find(t => t.name === 'read_file').parameters.properties.path,
    toolDefinitions.find(t => t.name === 'finish').parameters.properties.limitations.items,
    toolDefinitions.find(t => t.name === 'record_finding').parameters.properties.title,
  ];
  for (const schema of schemas) {
    // Some provider decoders apply pattern to the whole string, unlike AJV's search semantics.
    const fullMatch = new RegExp(`^(?:${schema.pattern})$`);
    assert.match('review/src/openrouter-model.ts', fullMatch);
    assert.match('Review completed.\nNo reportable findings.', fullMatch);
    assert.equal(fullMatch.test(' \n\t'), false);
  }
});
test('free profile cannot select paid models or a nonzero spending cap', () => {
  assert.equal(parseProfile(profile).maxUsd, 0);
  assert.throws(() => parseProfile({ ...profile, model: 'openrouter/auto' }));
  assert.throws(() => parseProfile({ ...profile, maxUsd: 1 }));
  assert.equal(price(50000, 8000, 0, 'cohere/north-mini-code:free'), 0);
});
test('free adapter pins provider and zero pricing, and records actual token usage', async t => {
  const requests = [];
  const transport = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/models')) return Response.json(catalog());
    const data = response();
    if (JSON.parse(options.body).tools.some(t => t.function.name === 'end_investigation')) {
      data.choices[0].message.tool_calls[0].function = { name: 'end_investigation', arguments: JSON.stringify({ complete: false, limitations: ['Fixture omits source inspection.'] }) };
    }
    return Response.json(data);
  };
  const fixture = repository(t), directory = persist(fixture);
  const output = await investigate(directory, fixture.packet, profile, openRouterModel(profile, 'fixture-key', transport));
  assert.equal(output.receipt.calls[0].reportedCostUsd, 0);
  assert.equal(output.receipt.calls[0].meteredUsd, 0);
  assert.equal(output.receipt.inputCountKind, 'conservative-estimate');
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.model, profile.model);
  assert.deepEqual(body.provider, { only: ['cohere'], allow_fallbacks: false, require_parameters: true,
    max_price: { prompt: 0, completion: 0, request: 0 } });
  assert.equal(requests[0].options.headers, undefined);
  assert.equal(requests[1].options.redirect, 'error');
});
test('free catalog pricing or snapshot change stops before inference', async () => {
  let calls = 0;
  const adapter = openRouterModel(profile, 'fixture-key', async () => { calls++; return Response.json(catalog('0.0001')); });
  await assert.rejects(adapter.count(input, AbortSignal.timeout(1000)), /rejected the request/);
  assert.equal(calls, 1);
});
test('OpenRouter HTTP errors do not copy raw credential or prompt text', async () => {
  const adapter = openRouterModel(profile, 'fixture-key', async () => Response.json({ error: { message: 'sensitive-body' } }, { status: 402 }));
  await assert.rejects(adapter.respond(input, 1024, AbortSignal.timeout(10000)), error => {
    assert.equal(error.failure.kind, 'funding');
    assert.ok(!error.message.includes('sensitive-body'));
    return true;
  });
});
test('unexpected provider charge is retained in accounting and stops the free review', async t => {
  const fixture = repository(t), directory = persist(fixture);
  const output = await investigate(directory, fixture.packet, profile, {
    async count() { return 1000; },
    async respond() { return { model: profile.model, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0,
      reportedCostUsd: 0.1, status: 'completed', continuation: [], calls: [] }; },
    toolOutput: () => ({}),
  });
  assert.equal(output.receipt.calls[0].meteredUsd, 0.1);
  assert.equal(output.result.status, 'partial');
  assert.match(output.receipt.stopReason, /free-only cost/);
});

const paidProfile = JSON.parse(readFileSync(new URL('../profiles/baseline-deepseek.json', import.meta.url)));
const paidCatalog = () => ({ data: [{ id: paidProfile.model, canonical_slug: 'deepseek/deepseek-v3.2-20251201', supported_parameters: ['tools', 'tool_choice'] }] });
const paidEndpoints = (prompt = '0.000000269') => ({ data: { endpoints: [{ tag: 'novita/fp8', status: 0,
  supports_tool_choice: { required: true }, supported_parameters: ['tools', 'tool_choice'], pricing: { prompt, completion: '0.0000004' } }] } });

for (const finishReason of [null, 'error']) test(`a settled ${finishReason ?? 'missing'} finish marker retries without applying partial tools`, async t => {
  const fixture = repository(t), directory = persist(fixture), requests = [];
  const tool = (name, args) => ({ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const steps = [
    tool('read_file', { side: 'head', path: 'update.ts', startLine: 1, count: 200 }),
    tool('finish', finalReport()),
    tool('read_file', { side: 'base', path: 'update.ts', startLine: 1, count: 200 }),
    tool('end_investigation', { complete: true, limitations: [] }),
    tool('finish', finalReport()),
  ];
  const adapter = openRouterModel(paidProfile, 'fixture-key', async (url, options) => {
    if (url.endsWith('/models')) return Response.json(paidCatalog());
    if (url.endsWith('/endpoints')) return Response.json(paidEndpoints());
    requests.push(JSON.parse(options.body));
    const data = response(); data.model = paidProfile.model; data.usage.cost = 0.00001;
    data.choices[0].message.tool_calls = [steps[requests.length - 1]];
    if (requests.length === 2) data.choices[0].finish_reason = finishReason;
    return Response.json(data);
  });
  const {result, receipt} = await investigate(directory, fixture.packet, paidProfile, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(receipt.calls.length, 5);
  assert.equal(receipt.toolCalls, 4);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(receipt.calls.reduce((sum, call) => sum + call.meteredUsd, 0), 0.00005);
});

test('paid route reserves before dispatch, pins prices/provider, and settles actual dollars', async t => {
  const fixture = repository(t), directory = persist(fixture), requests = [];
  let reservation;
  const transport = async (url, options) => {
    requests.push({url, options});
    if (url.endsWith('/models')) return Response.json(paidCatalog());
    if (url.endsWith('/endpoints')) return Response.json(paidEndpoints());
    assert.ok(reservation > 0);
    const data = response(); data.model = paidProfile.model; data.usage.cost = 0.0000469;
    if (JSON.parse(options.body).tools.some(t => t.function.name === 'end_investigation')) {
      data.choices[0].message.tool_calls[0].function = { name: 'end_investigation', arguments: JSON.stringify({ complete: false, limitations: ['Fixture omits source inspection.'] }) };
    }
    return Response.json(data);
  };
  const output = await investigate(directory, fixture.packet, paidProfile, openRouterModel(paidProfile, 'fixture-key', transport), (_result, receipt) => { reservation = receipt.calls.at(-1)?.reservedUsd; });
  assert.equal(output.receipt.calls[0].meteredUsd, 0.0000469);
  assert.equal(output.receipt.stopReason, 'finished');
  const payload = JSON.parse(requests.at(-1).options.body);
  assert.deepEqual(payload.provider, { only: ['novita/fp8'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0.269, completion: 0.4, request: 0 } });
  assert.equal(price(100000, 10000, 0, paidProfile.model), 0.0309);
});

test('paid route refuses a changed endpoint price before inference', async () => {
  let posts = 0;
  const adapter = openRouterModel(paidProfile, 'fixture-key', async (url, options) => {
    if (options.method === 'POST') posts++;
    return Response.json(url.endsWith('/models') ? paidCatalog() : paidEndpoints('0.000003'));
  });
  await assert.rejects(adapter.count(input, AbortSignal.timeout(1000)));
  assert.equal(posts, 0);
});

test('paid request cannot start without budget; unknown charge retains its reservation', async t => {
  const fixture = repository(t), directory = persist(fixture);
  let calls = 0;
  const model = { async count() { return 1000; }, async respond() { calls++; return {model: paidProfile.model, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, status: 'completed', continuation: [], calls: []}; }, toolOutput: () => ({}) };
  const denied = await investigate(directory, fixture.packet, {...paidProfile, maxUsd: 0.000001}, model);
  assert.equal(calls, 0); assert.match(denied.receipt.stopReason, /Budget/);
  const unknown = await investigate(directory, fixture.packet, paidProfile, model);
  assert.equal(calls, 1); assert.equal(unknown.receipt.calls[0].meteredUsd, null);
  assert.ok(unknown.receipt.calls[0].reservedUsd > 0);
  assert.match(unknown.receipt.stopReason, /cost confirmation missing/);
});
