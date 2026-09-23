import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { claudeModel } from '../benchmarks/claude-model.mjs';
import { parseProfile } from '../dist/investigation.js';
import { runClaimReview } from '../dist/claim-run.js';
import { repository, persist } from './helpers.mjs';

const profile = parseProfile(JSON.parse(readFileSync(new URL('../profiles/martian-claude-haiku.json', import.meta.url))));
const input = (transcript = []) => ({ instructions: 'review', context: JSON.stringify({ diff: 'd' }), transcript, tools: [{ name: 'read_file', parameters: {} }] });
const result = (calls, extra = {}) => ({ code: 0, stderr: '', stdout: JSON.stringify({ is_error: false, subtype: 'success', structured_output: { calls },
  usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 50 }, total_cost_usd: 0.01, ...extra }) });

// The memory of this project holds the benchmark's answers, and a Claude CLI started from
// the repository reads CLAUDE.md, AGENTS.md and memory by default. A model that saw them
// would be graded on recall of the answer key, so nothing but the prompt may reach it.
test('the Claude CLI is started with nothing but the prompt in front of it', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: '/memory', CLAUDE_MEMORY_STORES: 'x', CLAUDE_EFFORT: 'high',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1', OPENROUTER_API_KEY: 'k' });
  const seen = [];
  try {
    const model = claudeModel(profile, async (binary, args, options, stdin) => { seen.push({ binary, args, options, stdin }); return result([{ name: 'read_file', arguments: '{}' }]); });
    await model.respond(input(), 8192, new AbortController().signal);
    const [{ binary, args, options }] = seen;
    assert.equal(binary, 'claude');
    for (const key of ['CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', 'CLAUDE_MEMORY_STORES', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'OPENROUTER_API_KEY']) {
      assert.equal(options.env[key], undefined, key);
    }
    assert.deepEqual(readdirSync(options.cwd), [], 'an empty working directory has no CLAUDE.md to read');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--no-session-persistence'));
    model.close();
  } finally { process.env = saved; }
});

// Stateless on purpose: each request carries the whole conversation, so a reading recorded
// from another provider can be replayed into Claude, which is what the emission bench does.
test('each request carries the whole transcript, and usage counts cached and fresh input', async () => {
  const prompts = [];
  const model = claudeModel(profile, async (_b, _a, _o, stdin) => { prompts.push(stdin); return result([{ name: 'read_file', arguments: '{"path":"a"}' }]); });
  const first = await model.respond(input(), 8192, new AbortController().signal);
  assert.equal(first.status, 'completed');
  assert.equal(first.inputTokens, 1210);
  assert.equal(first.cachedInputTokens, 200);
  const transcript = [...first.continuation, model.toolOutput(first.calls[0].id, { text: 'file body' })];
  await model.respond(input(transcript), 8192, new AbortController().signal);
  const second = JSON.parse(prompts[1]);
  assert.deepEqual(second.transcript, transcript);
  assert.equal(second.context.diff, 'd');
  model.close();
});

test('a CLI error becomes a provider failure without its text, and running out of output is incomplete', async () => {
  const secret = 'private-source-fixture';
  const failing = claudeModel(profile, async () => ({ code: 1, stderr: secret, stdout: JSON.stringify({ is_error: true, result: `429 rate limit ${secret}`, usage: {} }) }));
  await assert.rejects(failing.respond(input(), 8192, new AbortController().signal), error => error.failure?.kind === 'rate-limit' && !error.message.includes(secret));
  const cut = claudeModel(profile, async () => result([], { is_error: true, stop_reason: 'max_tokens' }));
  assert.equal((await cut.respond(input(), 8192, new AbortController().signal)).status, 'incomplete');
  failing.close(); cut.close();
});

test('a Claude profile cannot run without the benchmark adapter', async t => {
  await assert.rejects(runClaimReview(persist(repository(t)), profile), /benchmark adapter/);
  assert.throws(() => claudeModel({ ...profile, model: 'claude-unknown' }), /Invalid local Claude profile/);
});
