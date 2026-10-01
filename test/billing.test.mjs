import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/github/store.js';
import { Repositories, month } from '../dist/github/repositories.js';
import { Billing, Stripe, StripeError } from '../dist/github/billing.js';
import { chargeCredit } from '../dist/github/dashboard-view.js';
import { readProfile } from '../dist/run.js';
import { priceLine } from '../dist/render.js';

const origin = 'https://review.example.test';
const profile = resolve('profiles/smoke-openrouter-free.json');
const models = [{ id: 'free', label: 'Free', profile: readProfile(profile) }];
const receipt = 'https://pay.stripe.com/receipts/payment/test_1';

// A fake Stripe that answers the calls billing makes and records each one. Like Stripe, it
// returns the same PaymentIntent for a repeated idempotency key and pays an intent only once.
function fakeStripe(state) {
  state.calls = []; state.intents = new Map(); state.keys = new Map();
  const card = method => ({ id: method, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
  const paid = (id, cents) => ({ id, customer: { id: 'cus_test1', email: 'billing@owner.test' }, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: cents, currency: 'usd',
    payment_intent: { status: 'succeeded', payment_method: card(state.method ?? 'pm_test1'), latest_charge: { receipt_url: receipt } } });
  return async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.equal(init.headers.Authorization, 'Bearer sk_test_fake');
    const { pathname, searchParams } = new URL(url), path = pathname.replace(/^\/v1/, ''), request = `${init.method} ${path}`;
    const params = Object.fromEntries(init.method === 'GET' ? searchParams : new URLSearchParams(init.body)), key = init.headers['Idempotency-Key'] ?? null;
    state.calls.push({ method: init.method, path, params, key });
    if (state.fail?.[request]) return Response.json({ error: { type: 'card_error', code: state.fail[request], message: 'Test failure.' } }, { status: 402 });
    // `lost` is a request Stripe carries out whose response never arrives.
    const lost = () => { if (state.lost === request) { delete state.lost; throw new TypeError('fetch failed'); } };
    if (request === 'POST /customers') return Response.json({ id: 'cus_test1' });
    if (request === 'POST /checkout/sessions') {
      const id = `cs_test_${state.calls.filter(call => call.path === '/checkout/sessions').length}`;
      return Response.json({ id, url: state.sessionUrl ?? `https://checkout.stripe.com/c/pay/${id}` });
    }
    if (init.method === 'GET' && path.startsWith('/checkout/sessions/')) {
      const id = path.split('/')[3];
      return Response.json(state.sessions?.[id] ?? paid(id, state.amount ?? 2500));
    }
    if (request === 'POST /payment_intents') {
      let intent = state.intents.get(state.keys.get(key));
      if (!intent) {
        intent = { id: `pi_test${state.intents.size + 1}`, amount: Number(params.amount), currency: params.currency, customer: params.customer, payment_method: params.payment_method, status: 'requires_confirmation', latest_charge: null };
        state.intents.set(intent.id, intent); state.keys.set(key, intent.id);
      }
      lost();
      return Response.json(intent);
    }
    const confirm = path.match(/^\/payment_intents\/(pi_\w+)\/confirm$/);
    if (init.method === 'POST' && confirm) {
      const intent = state.intents.get(confirm[1]);
      if (intent.status !== 'requires_confirmation') return Response.json({ error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state' } }, { status: 400 });
      Object.assign(intent, { status: 'succeeded', latest_charge: { receipt_url: receipt } });
      lost();
      return Response.json(intent);
    }
    if (init.method === 'GET' && path.startsWith('/payment_intents/')) return Response.json(state.intents.get(path.split('/')[2]));
    throw new Error(`Unexpected Stripe call ${request}`);
  };
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-billing-'));
  const config = { repository: 'owner/repo', repositoryId: 42, installationId: 99, profile, stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay: 100 };
  const store = new Store(root); assert.ok(store.acquire('worker'));
  const repositories = new Repositories(config, store, models, 'worker', origin), state = {};
  const billing = new Billing(new Stripe('sk_test_fake', fakeStripe(state)), repositories, origin);
  t.after(() => { repositories.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  // A started review with a receipt of the given recorded cost; null is a cost not settled yet.
  let n = 0;
  const review = (entry, started, usd) => {
    entry.store.enable(true);
    const id = entry.store.enqueue(`delivery-${++n}`, n), directory = join(root, `run-${n}`);
    mkdirSync(directory);
    const write = cost => writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ profile: models[0].profile, finishedAt: 'now', calls: [{ meteredUsd: cost }] }));
    write(usd);
    entry.store.db.prepare("UPDATE jobs SET state='completed', started=?, artifact=? WHERE id=?").run(started, directory, id);
    return { id, settle: write };
  };
  const first = repositories.entries.get(42);
  const attempt = () => { first.store.enqueue(`attempt-${++n}`, n); return repositories.reserve(first, first.store.next('worker'), 'worker', 100); };
  const card = () => { repositories.setCustomer(99, 'cus_test1', 7); repositories.setCard(99, 'pm_test1', 'Visa ending 4242', '12/2030', 'billing@owner.test', 7); };
  return { root, repositories, billing, state, review, attempt, card, first };
}

test('credit is bought on a Checkout page in US dollars that saves the card, and is added once, only for a paid checkout of this organization', async t => {
  const f = setup(t);
  assert.equal(await f.billing.checkout(99, 'owner', 2500, 7), 'https://checkout.stripe.com/c/pay/cs_test_1');
  const [customer, session] = f.state.calls;
  // A retried first checkout must not create a second customer.
  assert.deepEqual([customer.path, customer.key, customer.params.name, customer.params['metadata[installation]']], ['/customers', 'atmin-customer-99', 'owner', '99']);
  // The account's default currency is CAD; the price is US dollars. Paying saves the card for
  // top-ups charged while nobody is on the page.
  assert.deepEqual([session.params.mode, session.params.customer, session.params['line_items[0][price_data][unit_amount]'], session.params['line_items[0][price_data][currency]'], session.params['payment_intent_data[setup_future_usage]']],
    ['payment', 'cus_test1', '2500', 'usd', 'off_session']);
  assert.equal(session.params.success_url, `${origin}/billing?installation=99&checkout={CHECKOUT_SESSION_ID}`);
  assert.equal(session.params.cancel_url, `${origin}/billing?installation=99`);
  // Only the amounts on sale, and only Stripe's own page.
  await assert.rejects(f.billing.checkout(99, 'owner', 1234, 7), { status: 400 });
  f.state.sessionUrl = 'https://evil.test/pay';
  await assert.rejects(f.billing.checkout(99, 'owner', 1000, 7), StripeError);
  delete f.state.sessionUrl;
  assert.equal(f.state.calls.filter(call => call.path === '/customers').length, 1);

  // Returning from Checkout proves nothing by itself: the session must be one atmin started for
  // this organization, and Stripe must have taken the amount sold from this customer.
  await assert.rejects(f.billing.confirm(99, 'not-a-session', 7), { status: 400 });
  await assert.rejects(f.billing.confirm(77, 'cs_test_1', 7), { status: 400 });
  await assert.rejects(f.billing.confirm(99, 'cs_test_999', 7), { status: 400 });
  const base = { customer: { id: 'cus_test1' }, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 2500, currency: 'usd', payment_intent: { status: 'succeeded' } };
  for (const unpaid of [{ status: 'open', payment_status: 'unpaid' }, { payment_status: 'unpaid' }, { customer: { id: 'cus_other' } }, { amount_total: 1000 }, { currency: 'cad' }, { payment_intent: { status: 'processing' } }]) {
    f.state.sessions = { cs_test_1: { ...base, ...unpaid } };
    await assert.rejects(f.billing.confirm(99, 'cs_test_1', 7), { status: 409 });
  }
  assert.equal(f.repositories.balance(99), 0); assert.equal(f.repositories.billing(99).card, null);
  // A paid checkout that does not match what was sold is marked failed, so the hourly check stops asking.
  assert.equal(f.repositories.payment('cs_test_1').state, 'failed');
  delete f.state.sessions;
  assert.deepEqual(await f.billing.confirm(99, 'cs_test_1', 7), { usd: 25, card: 'Visa ending 4242' });
  assert.equal(f.repositories.balance(99), 25);
  assert.deepEqual(f.repositories.creditHistory(99).map(({ reference, kind, usd, by, receipt: link }) => ({ reference, kind, usd, by, link })),
    [{ reference: 'cs_test_1', kind: 'purchase', usd: 25, by: 7, link: receipt }]);
  // Checkout puts the address it collected on the customer; Stripe sends receipts there.
  assert.deepEqual(f.repositories.billing(99), { customer: 'cus_test1', paymentMethod: 'pm_test1', card: 'Visa ending 4242', expires: '12/2030', email: 'billing@owner.test',
    topUpCents: null, topUpFailed: null, updated: f.repositories.billing(99).updated, updatedBy: 7 });
  // Reloading the return page adds nothing more and does not ask Stripe again.
  const asked = f.state.calls.length;
  assert.deepEqual(await f.billing.confirm(99, 'cs_test_1', 7), { usd: 25, card: 'Visa ending 4242' });
  assert.equal(f.state.calls.length, asked); assert.equal(f.repositories.balance(99), 25);
  // Stripe errors name the step and code, never the key.
  f.state.fail = { 'POST /checkout/sessions': 'api_key_expired' };
  await assert.rejects(f.billing.checkout(99, 'owner', 1000, 7), error => error instanceof StripeError && error.status === 402
    && error.message === 'Stripe 402 api_key_expired on POST /checkout/sessions: Test failure.' && !error.message.includes('sk_test'));
});

test('a buyer who closes the page after paying is still credited by the hourly check, once, and an unpaid checkout expires', async t => {
  const f = setup(t);
  await f.billing.checkout(99, 'owner', 2500, 7); await f.billing.checkout(99, 'owner', 1000, 7); await f.billing.checkout(99, 'owner', 5000, 7);
  f.state.sessions = { cs_test_2: { status: 'expired' }, cs_test_3: { status: 'open', payment_status: 'unpaid' } };
  await f.billing.reconcile();
  assert.equal(f.repositories.balance(99), 25);
  assert.deepEqual(['cs_test_1', 'cs_test_2', 'cs_test_3'].map(id => f.repositories.payment(id).state), ['paid', 'expired', 'open']);
  // The buyer comes back after all: nothing is added twice.
  assert.deepEqual(await f.billing.confirm(99, 'cs_test_1', 7), { usd: 25, card: 'Visa ending 4242' });
  assert.equal(f.repositories.balance(99), 25);
  // Settled checkouts are not asked about again; the open one is, until Stripe settles it.
  const asked = () => f.state.calls.filter(call => call.method === 'GET').map(call => call.path.split('/')[3]);
  const before = asked().length;
  await f.billing.reconcile();
  assert.deepEqual(asked().slice(before), ['cs_test_3']);
});

test('each review past the free ones is paid from credit once, at the price its comment showed, and none starts at zero credit', t => {
  const f = setup(t), now = Date.now(), { start } = month(now);
  // 20 free reviews, whatever they cost.
  const free = Array.from({ length: 20 }, (_, i) => f.review(f.first, start + i, 5));
  assert.match(f.attempt(), /has no review credit left/);
  f.repositories.grant(99, 1, 'test credit', 8);
  // Any credit above zero starts a review: max(.30 x 2, .05) = .60 is taken once it settles, and
  // taking it again, as every check of the balance does, changes nothing.
  assert.equal(f.attempt(), true);
  f.review(f.first, start + 20, .3);
  for (let i = 0; i < 3; i++) chargeCredit(f.repositories, 99, now);
  assert.equal(f.repositories.balance(99), .4);
  // The review that starts on the last of the credit may take it below zero; then nothing starts.
  assert.equal(f.attempt(), true);
  f.review(f.first, start + 21, 1);
  chargeCredit(f.repositories, 99, now);
  assert.equal(Math.round(f.repositories.balance(99) * 100) / 100, -1.6);
  assert.match(f.attempt(), /has no review credit left/);
  // A review whose cost has not settled is not guessed at; it is taken when it settles.
  f.repositories.grant(99, 10, 'test credit', 8);
  const pending = f.review(f.first, start + 22, null);
  chargeCredit(f.repositories, 99, now);
  assert.equal(Math.round(f.repositories.balance(99) * 100) / 100, 8.4);
  pending.settle(.01);
  chargeCredit(f.repositories, 99, now);
  assert.equal(Math.round(f.repositories.balance(99) * 100) / 100, 8.35);
  // A plan changed later does not price a review again: the 20 free ones stay free.
  f.repositories.setPlan(99, { freeReviews: 5, monthlyReviews: 1000, multiplier: 3, minimumUsd: .05 }, 8);
  chargeCredit(f.repositories, 99, now);
  assert.equal(Math.round(f.repositories.balance(99) * 100) / 100, 8.35);
  assert.ok(free.every(({ id }) => f.repositories.credited(`review-${id}`)));
});

test('reviews from before credit replaced monthly invoices are never taken from credit', t => {
  const f = setup(t);
  f.repositories.setPlan(99, { freeReviews: 0, monthlyReviews: 1000, multiplier: 2, minimumUsd: .05 }, 8);
  f.repositories.grant(99, 5, 'test credit', 8);
  const september = f.review(f.first, Date.UTC(2026, 8, 30, 23), 1), october = f.review(f.first, Date.UTC(2026, 9, 1, 1), 1);
  chargeCredit(f.repositories, 99, Date.UTC(2026, 9, 2));
  assert.equal(f.repositories.balance(99), 3);
  assert.deepEqual([f.repositories.credited(`review-${september.id}`), f.repositories.credited(`review-${october.id}`)], [false, true]);
});

test('auto top-up charges the saved card the chosen amount below $5, once even when a response is lost, and stops when the card fails', async t => {
  const f = setup(t);
  f.card(); f.repositories.grant(99, 6, 'test credit', 8);
  f.repositories.setTopUp(99, 2500, 7);
  await f.billing.topUp();
  assert.equal(f.state.calls.length, 0);
  f.repositories.grant(99, -2, 'test debit', 8);
  await f.billing.topUp();
  // Made unconfirmed under an idempotency key, then confirmed off-session: in US dollars, for the
  // chosen amount, on the saved card.
  const [create, confirm] = f.state.calls;
  assert.deepEqual([create.path, create.key, create.params.amount, create.params.currency, create.params.customer, create.params.payment_method, create.params.confirm],
    ['/payment_intents', 'atmin-topup-99-1', '2500', 'usd', 'cus_test1', 'pm_test1', undefined]);
  assert.deepEqual([confirm.path, confirm.params.off_session, confirm.key], ['/payment_intents/pi_test1/confirm', 'true', 'atmin-topup-99-1-confirm']);
  assert.equal(f.repositories.balance(99), 29);
  assert.deepEqual(f.repositories.creditHistory(99)[0], { ...f.repositories.creditHistory(99)[0], reference: 'atmin-topup-99-1', kind: 'top-up', usd: 25, receipt });
  await f.billing.topUp();
  assert.equal(f.state.calls.length, 2);

  // Stripe made the intent but the answer was lost: asking again with the same key gets the
  // same intent, so one charge.
  f.repositories.grant(99, -26, 'test debit', 8);
  f.state.lost = 'POST /payment_intents';
  await f.billing.topUp();
  assert.deepEqual([f.repositories.payment('atmin-topup-99-2').state, f.repositories.payment('atmin-topup-99-2').intent, f.repositories.balance(99)], ['open', null, 3]);
  await f.billing.topUp();
  assert.deepEqual([f.state.intents.size, f.repositories.balance(99)], [2, 28]);
  // Stripe charged the card but the answer was lost: the next check reads the intent and
  // credits it without confirming it again.
  f.repositories.grant(99, -25, 'test debit', 8);
  f.state.lost = 'POST /payment_intents/pi_test3/confirm';
  await f.billing.topUp();
  assert.deepEqual([f.repositories.payment('atmin-topup-99-3').state, f.repositories.balance(99)], ['open', 3]);
  await f.billing.reconcile();
  assert.deepEqual([f.repositories.payment('atmin-topup-99-3').state, f.repositories.balance(99)], ['paid', 28]);
  assert.equal(f.state.calls.filter(call => call.path === '/payment_intents/pi_test3/confirm').length, 1);
  assert.equal(f.state.intents.size, 3);

  // A declined card stops auto top-up, says why, and nothing charges it again.
  f.repositories.grant(99, -25, 'test debit', 8);
  f.state.fail = { 'POST /payment_intents/pi_test4/confirm': 'card_declined' };
  await f.billing.topUp();
  assert.deepEqual([f.repositories.payment('atmin-topup-99-4').state, f.repositories.billing(99).topUpFailed, f.repositories.balance(99)], ['failed', 'The card was declined.', 3]);
  assert.deepEqual(f.repositories.toppedUp(), []);
  const calls = f.state.calls.length;
  await f.billing.topUp(); await f.billing.reconcile();
  assert.equal(f.state.calls.length, calls);
  // Turning it on again tries once more; a bank that wants the card holder stops it again.
  f.state.fail = { 'POST /payment_intents/pi_test5/confirm': 'authentication_required' };
  f.repositories.setTopUp(99, 1000, 7);
  await f.billing.topUp();
  assert.equal(f.repositories.billing(99).topUpFailed, 'The card’s bank asked the card holder to approve the charge.');
  // A purchase saves a card that just paid, so auto top-up runs again.
  delete f.state.fail;
  await f.billing.checkout(99, 'owner', 1000, 7); f.state.amount = 1000; f.state.method = 'pm_test2';
  await f.billing.confirm(99, 'cs_test_1', 7);
  assert.deepEqual([f.repositories.billing(99).topUpFailed, f.repositories.toppedUp(), f.repositories.balance(99)], [null, [99], 13]);
});

test('operators add or take credit with a note, within bounds', t => {
  const f = setup(t);
  for (const [usd, note] of [[0, 'x'], [NaN, 'x'], [1000.01, 'x'], [-1000.01, 'x'], ['5', 'x'], [5, ''], [5, ' '], [5, 'x'.repeat(201)], [5, undefined]]) {
    assert.throws(() => f.repositories.grant(99, usd, note, 8), /Invalid grant/);
  }
  assert.equal(f.repositories.grant(99, 12.5, ' Mason pilot ', 8), 12.5);
  assert.equal(f.repositories.grant(99, -2.5, 'correction', 8), 10);
  assert.deepEqual(f.repositories.creditHistory(99).map(({ kind, usd, by, note }) => [kind, usd, by, note]), [['grant', -2.5, 8, 'correction'], ['grant', 12.5, 8, 'Mason pilot']]);
});

test('the PR comment says what credit is left and warns when it runs low or out, unless auto top-up refills it', () => {
  const url = `${origin}/billing?installation=99`, paid = { month: '2026-10', index: 24, freeReviews: 20, free: false, usd: .1 };
  const line = credit => priceLine({ ...paid, credit }), head = '**This review costs $0.10**. It is review 25 in October 2026, after 20 free.';
  assert.equal(line({ usd: 12.3, topUp: false, url }), `${head} It was paid from review credit, which has $12.30 left.`);
  assert.equal(line({ usd: 1.99, topUp: false, url }), `${head} It was paid from review credit, which has $1.99 left. Credit is running low; a repository admin can [buy more](${url}).`);
  // Below zero reads as none left; without Stripe there is nowhere to link.
  assert.equal(line({ usd: -.04, topUp: false }), `${head} It was paid from review credit, which has $0.00 left. Reviews stop until atmin adds credit.`);
  assert.equal(line({ usd: 1.99, topUp: true, url }), `${head} It was paid from review credit, which has $1.99 left.`);
  // Free reviews mention credit only on the last one, and only when there is none.
  const free = { month: '2026-10', index: 18, freeReviews: 20, free: true, usd: 0 };
  assert.equal(priceLine({ ...free, credit: { usd: 0, topUp: false, url } }), '**This review is free:** 19 of 20 free reviews in October 2026.');
  assert.equal(priceLine({ ...free, index: 19, credit: { usd: 3, topUp: false, url } }), '**This review is free:** 20 of 20 free reviews in October 2026.');
  assert.equal(priceLine({ ...free, index: 19, credit: { usd: 0, topUp: true, url } }), '**This review is free:** 20 of 20 free reviews in October 2026.');
});
