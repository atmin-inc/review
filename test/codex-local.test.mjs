import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexModel } from '../benchmarks/codex-model.mjs';
import { investigate, accountedUsd, parseProfile } from '../dist/investigation.js';
import { runReview } from '../dist/run.js';
import { repository, persist, finalReport } from './helpers.mjs';
import { withTrace } from '../dist/trace.js';

const profile = parseProfile(JSON.parse(readFileSync(new URL('../profiles/completion-codex-local.json', import.meta.url))));
const call = (name, args) => ({ name, arguments: JSON.stringify(args) });
const threadId = '11111111-1111-4111-8111-111111111111';
const reply = (calls, turn = 1) => [{ type: 'thread.started', thread_id: threadId }, { type: 'item.completed', item: { type: 'todo_list', items: [] } }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ calls }) } },
  { type: 'turn.completed', usage: { input_tokens: 1000 * turn, cached_input_tokens: 500 * turn, output_tokens: 100 * turn } }];

test('local subscription adapter recovers a completed turn and continues with controller evidence', async t => {
  const fixture = repository(t), directory = persist(fixture);
  const batches = [reply(['base', 'head'].map(side => call('read_file', { side, path: 'update.ts', startLine: 1, count: 200 }))),
    reply([call('end_investigation', { complete: true, limitations: [] })], 2),
    reply([call('finish', finalReport())], 3)];
  const privateError = 'stream disconnected: private-source-and-credential-fixture';
  batches[0].splice(1, 0, { type: 'error', message: privateError });
  const workspaces = [], prompts = [];
  const execute = (binary, args, options) => {
    assert.equal(binary, 'codex');
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY']) assert.equal(options.env[key], undefined);
    if (args[0] === 'login') return Promise.resolve({ stdout: '', stderr: 'Logged in using ChatGPT' });
    if (args[0] === '--version') return Promise.resolve({ stdout: 'codex-cli fixture', stderr: '' });
    for (const flag of ['--ignore-user-config', '--output-schema']) assert.ok(args.includes(flag));
    assert.equal(args.includes('--ephemeral'), false);
    if (prompts.length) assert.equal(args[args.indexOf('resume') + 1], threadId);
    assert.ok(args.includes('shell_tool')); assert.ok(args.includes('web_search="disabled"'));
    workspaces.push(args[args.indexOf('-C') + 1]);
    const promise = Promise.resolve({ stdout: batches.shift().map(event => JSON.stringify(event)).join('\n'), stderr: '' });
    promise.child = { stdin: { end(prompt) { prompts.push(prompt); } } };
    return promise;
  };
  const model = await codexModel(profile, execute);
  const { result, receipt } = await withTrace(directory, () => investigate(directory, fixture.packet, profile, model)).finally(() => model.close());
  assert.equal(result.status, 'completed');
  assert.equal(result.evidence.length, 2);
  assert.equal(receipt.rateCard.billing, 'subscription');
  assert.equal(accountedUsd(receipt), 0);
  assert.equal(receipt.calls[0].inputTokens, 1000);
  assert.equal(receipt.calls[1].inputTokens, 1000);
  assert.equal(receipt.calls[1].outputTokens, 100);
  const trace = readFileSync(join(directory, 'trace.ndjson'), 'utf8');
  assert.ok(trace.includes('"recoveredErrors":1'));
  assert.equal(trace.includes(privateError), false);
  assert.ok(prompts[1].includes('read-1'));
  assert.equal(new Set(workspaces).size, 1);
  assert.equal(prompts[1].includes('You are the model inside'), false);
  for (const path of workspaces) assert.equal(existsSync(path), false);
  await assert.rejects(runReview(directory, profile), /benchmark Codex adapter/);
});

test('local adapter rejects API auth, native tools and incomplete CLI turns', async () => {
  await assert.rejects(codexModel(profile, async () => ({ stdout: 'Logged in using an API key', stderr: '' })), /ChatGPT login/);
  for (const events of [
    [{ type: 'turn.failed' }],
    [{ type: 'error', message: 'stream disconnected without completion' }],
    [],
  ]) {
    const model = await codexModel(profile, async (_binary, args) => ({
      stdout: args[0] === 'login' ? 'Logged in using ChatGPT' : args[0] === '--version' ? 'codex-cli fixture'
        : events.map(event => JSON.stringify(event)).join('\n'), stderr: '',
    }));
    try { await assert.rejects(model.respond({ instructions: '', context: '{}', transcript: [], tools: [] }, 8192, new AbortController().signal)); }
    finally { model.close(); }
  }
});

test('CLI failures retain safe diagnostic types without response or stderr content', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'atmin-codex-trace-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = 'private-source-and-credential-fixture';
  const model = await codexModel(profile, async (_binary, args) => {
    if (args[0] === 'login') return { stdout: 'Logged in using ChatGPT', stderr: '' };
    if (args[0] === '--version') return { stdout: 'codex-cli fixture', stderr: '' };
    throw Object.assign(new Error('connection timed out'), { code: 1, stderr: secret,
      stdout: JSON.stringify({ type: 'turn.failed', error: { message: secret } }) });
  });
  t.after(() => model.close());
  await withTrace(directory, () => assert.rejects(model.respond({ instructions: '', context: '', transcript: [], tools: [] }, 8192, new AbortController().signal), /Provider unavailable/));
  const trace = readFileSync(join(directory, 'trace.ndjson'), 'utf8');
  assert.ok(trace.includes('provider.codex.failure'));
  assert.ok(trace.includes('"classification":"transport"'));
  assert.ok(trace.includes('"exitCode":1'));
  assert.equal(trace.includes(secret), false);
});

test('rejected native output preserves confirmed usage without executing its calls', async t => {
  for (const change of [
    events => [...events, { type: 'item.updated', item: { type: 'command_execution' } }],
    events => events.map(event => event.item?.type === 'agent_message' ? { ...event, item: { ...event.item, text: 'not JSON' } } : event),
    events => events.map(event => event.type === 'thread.started' ? { ...event, thread_id: 'not-a-session-id' } : event),
    events => [...events, { type: 'error', message: 'connection failed after completion' }],
    events => [{ type: 'turn.failed' }, ...events],
  ]) {
    const fixture = repository(t), directory = persist(fixture);
    const batch = reply([call('read_file', { side: 'head', path: 'update.ts', startLine: 1, count: 200 })]);
    batch.splice(1, 0, { type: 'error', message: 'stream disconnected before completion' });
    const events = change(batch);
    const model = await codexModel(profile, async (_binary, args) => ({ stdout: args[0] === 'login' ? 'Logged in using ChatGPT'
      : args[0] === '--version' ? 'codex-cli fixture' : events.map(event => JSON.stringify(event)).join('\n'), stderr: '' }));
    const { result, receipt } = await investigate(directory, fixture.packet, profile, model).finally(() => model.close());
    assert.equal(result.status, 'partial');
    assert.equal(result.evidence.length, 0);
    assert.equal(receipt.calls.length, 1);
    assert.equal(receipt.calls[0].outputTokens, 100);
    assert.equal(receipt.calls[0].meteredUsd, 0);
    assert.equal(receipt.calls[0].status, 'incomplete');
    assert.equal(receipt.providerFailure, null); // Local validation, not a synthetic HTTP rejection.
  }
});

test('streamed metadata is available before the CLI exits and never contains source', async t => {
  const { PassThrough } = await import('node:stream');
  const directory = mkdtempSync(join(tmpdir(), 'atmin-codex-stream-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = 'private-source-fixture';
  const stdout = new PassThrough(), stderr = new PassThrough();
  let release;
  const model = await codexModel(profile, (_binary, args) => {
    if (args[0] === 'login') return Promise.resolve({ stdout: 'Logged in using ChatGPT', stderr: '' });
    if (args[0] === '--version') return Promise.resolve({ stdout: 'codex-cli fixture', stderr: '' });
    const pending = new Promise(resolve => { release = resolve; });
    pending.child = { stdout, stderr, stdin: { end() {
      stderr.write(secret);
      stdout.write(reply([call('finish', { secret })]).map(event => JSON.stringify(event)).join('\n') + '\n');
    } } };
    return pending;
  });
  t.after(() => model.close());
  await withTrace(directory, async () => {
    const pending = model.respond({ instructions: '', context: '{}', transcript: [], tools: [] }, 8192, new AbortController().signal);
    const live = readFileSync(join(directory, 'trace.ndjson'), 'utf8');
    assert.ok(live.includes('provider.codex.event'));
    assert.equal(live.includes('provider.codex.finished'), false);
    assert.equal(live.includes(secret), false);
    stdout.end(); stderr.end(); release({ stdout: '', stderr: secret });
    assert.equal((await pending).status, 'completed');
  });
  const trace = readFileSync(join(directory, 'trace.ndjson'), 'utf8');
  assert.ok(trace.includes('firstEventMs'));
  assert.ok(trace.includes('stderrBytes'));
  assert.equal(trace.includes(secret), false);
});

test('a session rejects a different review or rewritten transcript', async t => {
  const model = await codexModel(profile, async (_binary, args) => ({ stdout: args[0] === 'login' ? 'Logged in using ChatGPT'
    : args[0] === '--version' ? 'codex-cli fixture' : reply([call('ping', {})]).map(event => JSON.stringify(event)).join('\n'), stderr: '' }));
  t.after(() => model.close());
  const input = { instructions: 'review', context: JSON.stringify({ snapshot: 'one', controllerBudget: {} }),
    transcript: [{ role: 'user', content: 'original' }], tools: [] };
  await model.respond(input, 8192, new AbortController().signal);
  for (const changed of [{ ...input, instructions: 'different' }, { ...input, context: '{"snapshot":"two"}' },
    { ...input, transcript: [{ role: 'user', content: 'rewritten' }] }]) {
    await assert.rejects(model.count(changed), /cannot switch review context or rewrite history/);
  }
  assert.ok(await model.count(input) > 65536);
  model.close();
  await assert.rejects(model.count(input), /closed/);
});
