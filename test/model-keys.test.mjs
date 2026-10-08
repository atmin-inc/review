import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/github/store.js';
import { Repositories } from '../dist/github/repositories.js';
import { ModelKeys, checkModelKey } from '../dist/github/model-keys.js';
import { Runners } from '../dist/github/runners.js';
import { router, modelCredential } from '../dist/github/runner.js';
import { openAIModel } from '../dist/openai-model.js';
import { meteredCost } from '../dist/investigation.js';
import { readProfile } from '../dist/run.js';

const secret = 'a test sealing secret of at least 32 bytes';
const key = 'ABSKQmVkcm9ja0FQSUtleS10ZXN0LWtleS0xMjM0NTY3ODkw';
const profile = resolve('profiles/review-luna-openrouter.json');
const models = [{ id: 'luna', label: 'Luna', profile: readProfile(profile) }];

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-model-keys-'));
  const config = { repository: 'owner/repo', repositoryId: 42, installationId: 99, profile, stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay: 100 };
  const store = new Store(root); assert.ok(store.acquire('worker'));
  const keys = new ModelKeys(store.db, secret);
  const repositories = new Repositories(config, store, models, 'worker', 'https://review.example.test', keys);
  t.after(() => { repositories.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store, keys, repositories, entry: repositories.entries.get(42) };
}

// A Responses API reply that calls one tool, as Bedrock's OpenAI-compatible endpoint returns it.
const reply = () => Response.json({ id: 'resp_1', object: 'response', model: 'us.openai.gpt-6-luna', status: 'completed',
  output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ok', arguments: '{}', status: 'completed' }],
  usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 8 } } });

// The key reaches the database only sealed: a copy of the database, or a query printed to a
// terminal, must not reveal it. It is bound to its organization, and a lost secret stops reviews
// rather than letting them run on this service's key.
test('an organization\'s model key is stored sealed, shown only by its last four characters, and bound to its organization', t => {
  const f = setup(t);
  assert.equal(f.keys.provider(99), null);
  f.keys.set(99, 'bedrock', key, 8, Date.UTC(2026, 9, 7));
  assert.deepEqual(f.keys.view(99), { provider: 'bedrock', last4: 'ODkw', updatedAt: '2026-10-07T00:00:00.000Z', updatedBy: 8 });
  assert.deepEqual(f.keys.get(99), { provider: 'bedrock', key });
  const dump = JSON.stringify(f.store.db.prepare('SELECT * FROM model_keys').all());
  assert.ok(!dump.includes(key) && !dump.includes(key.slice(4, 20)));
  // Moved to another organization's row, it no longer opens.
  f.store.db.prepare('INSERT INTO model_keys SELECT 77, provider, sealed, last4, updated, updatedBy FROM model_keys WHERE installation=99').run();
  assert.throws(() => f.keys.get(77), /cannot be unsealed/);
  assert.throws(() => new ModelKeys(f.store.db, 'another secret, also of at least 32 bytes').get(99), /cannot be unsealed/);
  assert.throws(() => new ModelKeys(f.store.db, undefined).get(99), /ATMIN_REVIEW_KEY_SECRET is not set/);
  assert.throws(() => new ModelKeys(f.store.db, 'short'), /at least 32 bytes/);
  assert.throws(() => f.keys.set(99, 'bedrock', 'has spaces in it, so not a key', 8), /Invalid model key/);
  assert.equal(f.keys.remove(99, 8), true);
  assert.equal(f.keys.get(99), null);
});

// The organization pays its model provider for these reviews, so atmin's free allowance and
// credit must not be spent or required. Nor do the daily limits hold them: they bound this
// service's model spend, and Mason neared the service's 100 a day on its own key (2026-10-08).
test('reviews on an organization\'s own key need no free reviews or credit, and neither its plan nor the daily limits count or hold them; the off switch applies', t => {
  const f = setup(t);
  f.entry.store.enable(true);
  f.repositories.setPlan(99, { freeReviews: 0, monthlyReviews: 1000, multiplier: 2, minimumUsd: .05 }, 8);
  let n = 0;
  const attempt = (limit = 100) => { f.entry.store.enqueue(`d${++n}`, n); return f.repositories.reserve(f.entry, f.entry.store.next('worker'), 'worker', limit); };
  assert.match(attempt(), /has no review credit left/);
  f.keys.set(99, 'bedrock', key, 8);
  f.config.maxReviewsPerDay = 1;
  assert.equal(attempt(1), true);
  assert.equal(attempt(1), true, 'past both the repository and the service daily limit');
  const jobs = f.entry.store.db.prepare('SELECT pr, modelKey, started FROM jobs ORDER BY pr').all();
  assert.deepEqual(jobs.map(job => [job.pr, job.modelKey, job.started !== null]), [[1, null, false], [2, 'bedrock', true], [3, 'bedrock', true]]);
  assert.equal(f.repositories.started(99, 0, Date.now() + 1).length, 0);
  assert.equal(f.repositories.reviewsToday(), 0);
  f.repositories.setPlan(99, { freeReviews: 0, monthlyReviews: 0, multiplier: 2, minimumUsd: .05 }, 8);
  assert.match(attempt(), /^Reviews are turned off for this organization/);
  // Without its key, the organization is back on atmin's plan and credit.
  f.repositories.setPlan(99, { freeReviews: 0, monthlyReviews: 1000, multiplier: 2, minimumUsd: .05 }, 8);
  f.keys.remove(99, 8);
  assert.match(attempt(), /has no review credit left/);
  // Reviews on this service's key are still held to both daily limits.
  f.repositories.setPlan(99, { freeReviews: 1000, monthlyReviews: 1000, multiplier: 2, minimumUsd: .05 }, 8);
  assert.equal(attempt(), true);
  assert.equal(f.repositories.reviewsToday(), 1);
  assert.match(attempt(), /rolling 24-hour review limit was reached/);
  f.config.maxReviewsPerDay = 100;
  assert.match(attempt(1), /rolling 24-hour review limit was reached/);
  assert.equal(attempt(2), true);
  // A day full of those does not stop a review on the organization's own key.
  f.config.maxReviewsPerDay = 1;
  f.keys.set(99, 'bedrock', key, 8);
  assert.equal(attempt(1), true);
});

// The key goes only to this service's runners, with that organization's job, and the job
// forgets it once a runner claims it. A review started on the key never runs on another.
test('a review on an organization\'s key is offered as Luna on Bedrock with the key, which the job forgets once claimed', async t => {
  const f = setup(t);
  f.keys.set(99, 'bedrock', key, 8);
  const runners = new Runners(f.store.db);
  const route = router(f.config, { readToken: async () => 'read-only' }, runners, undefined, f.keys);
  const job = { id: '00000000-0000-4000-8000-000000000001', pr: 7, modelKey: 'bedrock' };
  await route.offer(job, 'pool', f.root, null);
  const stored = () => JSON.parse(f.store.db.prepare('SELECT offer FROM runner_jobs WHERE job=?').get(job.id).offer);
  assert.deepEqual([stored().profile.provider, stored().profile.model, stored().profile.maxUsd, stored().modelKey], ['bedrock', 'us.openai.gpt-6-luna', 2, key]);
  const offer = runners.claim(Runners.hosted('pool-token-of-at-least-32-bytes!!', 'pool-token-of-at-least-32-bytes!!', 'hosted-1'));
  assert.equal(offer.modelKey, key);
  assert.equal(stored().modelKey, undefined);
  assert.deepEqual(modelCredential(offer.profile, offer, { OPENROUTER_API_KEY: 'ours' }), ['AWS_BEARER_TOKEN_BEDROCK', key]);
  // Never this service's key for the organization's job, nor the organization's for another.
  assert.throws(() => modelCredential(offer.profile, { ...offer, modelKey: undefined }, { AWS_BEARER_TOKEN_BEDROCK: 'ours' }), /credential unavailable/);
  assert.throws(() => modelCredential(readProfile(profile), offer, { OPENROUTER_API_KEY: 'ours' }), /credential unavailable/);
  assert.deepEqual(modelCredential(readProfile(profile), { job: 'x' }, { OPENROUTER_API_KEY: 'ours' }), ['OPENROUTER_API_KEY', 'ours']);
  // A key removed after the review started stops it rather than running it on atmin's key.
  f.keys.remove(99, 8);
  await assert.rejects(route.offer({ ...job, id: '00000000-0000-4000-8000-000000000002' }, 'pool', f.root, null), /no longer set/);
  // An ordinary review is offered as configured, without a key.
  await route.offer({ ...job, id: '00000000-0000-4000-8000-000000000003', modelKey: null }, 'pool', f.root, null);
  const plain = JSON.parse(f.store.db.prepare('SELECT offer FROM runner_jobs WHERE job=?').get('00000000-0000-4000-8000-000000000003').offer);
  assert.deepEqual([plain.profile.provider, 'modelKey' in plain], ['openrouter', false]);
});

test('Luna on Bedrock calls bedrock-runtime\'s OpenAI-compatible endpoint with the key and the US inference profile, and bounds input without a count call', async () => {
  const calls = [];
  const model = openAIModel(readProfile(resolve('profiles/review-luna-bedrock.json')), key, async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) });
    return reply();
  });
  const input = { instructions: 'Review.', context: 'diff', transcript: [], tools: [{ name: 'ok', description: 'd', parameters: { type: 'object', properties: {} } }] };
  assert.equal(model.inputCountKind, 'conservative-estimate');
  assert.ok(await model.count(input, AbortSignal.timeout(1000)) > 4096);
  const result = await model.respond(input, 2048, AbortSignal.timeout(5000));
  assert.deepEqual(calls.map(call => [call.url, call.auth]), [['https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses', `Bearer ${key}`]]);
  assert.deepEqual([calls[0].body.model, calls[0].body.store, 'service_tier' in calls[0].body, calls[0].body.tool_choice], ['us.openai.gpt-6-luna', false, false, 'required']);
  assert.deepEqual(result.calls, [{ id: 'call_1', name: 'ok', arguments: '{}' }]);
});

// The organization's AWS bill for a review is what /admin records as its cost: Bedrock's US inference
// profile bills every Luna rate 10% above OpenAI's, including the long-context rates past 272K tokens.
test('a review on Bedrock is costed at the US inference profile\'s rates, which Bedrock reports cache writes for', () => {
  const bedrock = readProfile(resolve('profiles/review-luna-bedrock.json'));
  const cost = usage => meteredCost(bedrock, { inputTokens: 1000, outputTokens: 50, ...usage });
  assert.ok(Math.abs(cost({ cachedInputTokens: 600, cacheWriteTokens: 300 }) - (100 * 0.11 + 600 * 0.011 + 300 * 0.1375 + 50 * 0.55) / 1e6) < 1e-15);
  assert.ok(Math.abs(meteredCost(bedrock, { inputTokens: 300_000, outputTokens: 1000, cachedInputTokens: 100_000, cacheWriteTokens: 50_000 })
    - (150_000 * 0.22 + 100_000 * 0.022 + 50_000 * 0.275 + 1000 * 0.825) / 1e6) < 1e-15);
  assert.equal(cost({ cachedInputTokens: 600 }), null);
});

// A key that cannot run a review is refused when it is set, not at a customer's next PR.
test('a model key is checked with one tool call before it is saved, and a refusal says why without the key', async () => {
  const seen = [];
  assert.equal(await checkModelKey('bedrock', key, async (url, init) => { seen.push(JSON.parse(init.body)); return reply(); }), null);
  assert.deepEqual([seen[0].model, seen[0].tool_choice, seen[0].tools.map(tool => tool.name)], ['us.openai.gpt-6-luna', 'required', ['ok']]);
  const denied = await checkModelKey('bedrock', key, async () => Response.json({ error: { message: 'You don\'t have access to the model', code: 'access_denied' } }, { status: 403 }));
  assert.match(denied, /refused the key\. Use a Bedrock API key whose IAM policy allows bedrock:InvokeModel on the us\.openai\.gpt-6-luna inference profile and on the account's default project/);
  assert.match(await checkModelKey('bedrock', key, async () => Response.json({ error: { message: 'bad' } }, { status: 400 })), /did not run the check call \(request, HTTP 400\)\. The key was not saved/);
  assert.match(await checkModelKey('bedrock', key, async () => { throw new TypeError('fetch failed'); }), /could not be reached|did not run the check call/);
  for (const message of [denied]) assert.ok(!message.includes(key));
});
