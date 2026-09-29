import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/github/store.js';
import { Repositories } from '../dist/github/repositories.js';
import { Billing, Stripe, StripeError } from '../dist/github/billing.js';
import { readProfile } from '../dist/run.js';

const origin = 'https://review.example.test';
const profile = resolve('profiles/smoke-openrouter-free.json');
const models = [{ id: 'free', label: 'Free', profile: readProfile(profile) }];

// A fake Stripe that answers the calls billing makes and records each one.
function fakeStripe(state = {}) {
  state.calls = [];
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.equal(init.headers.Authorization, 'Bearer sk_test_fake');
    const { pathname, searchParams } = new URL(url), path = pathname.replace(/^\/v1/, '');
    const params = Object.fromEntries(init.method === 'GET' ? searchParams : new URLSearchParams(init.body));
    state.calls.push({ method: init.method, path, params, key: init.headers['Idempotency-Key'] ?? null });
    const fail = state.fail?.[`${init.method} ${path}`];
    if (fail) return Response.json({ error: { type: 'card_error', code: fail, message: 'Test failure.' } }, { status: 402 });
    if (init.method === 'POST' && path === '/customers') return Response.json({ id: 'cus_test1' });
    if (init.method === 'POST' && path === '/checkout/sessions') return Response.json({ id: 'cs_test_abc', url: state.sessionUrl ?? 'https://checkout.stripe.com/c/pay/cs_test_abc' });
    if (init.method === 'GET' && path.startsWith('/checkout/sessions/')) return Response.json(state.session ?? { customer: 'cus_test1', mode: 'setup', status: 'complete',
      setup_intent: { status: 'succeeded', payment_method: { id: 'pm_test1', card: { brand: 'visa', last4: '4242' } } } });
    if (init.method === 'POST' && path.startsWith('/customers/')) return Response.json({ id: path.slice(11) });
    if (init.method === 'POST' && path === '/invoices') return Response.json({ id: `in_test${params['metadata[installation]']}` });
    if (init.method === 'POST' && path === '/invoiceitems') return Response.json({ id: 'ii_test1' });
    if (init.method === 'POST' && /^\/invoices\/in_\w+\/finalize$/.test(path)) return Response.json({ id: path.split('/')[2], status: 'open' });
    throw new Error(`Unexpected Stripe call ${init.method} ${path}`);
  };
  return fetcher;
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-billing-'));
  const config = { repository: 'owner/repo', repositoryId: 42, installationId: 99, profile, stateDirectory: root, host: '127.0.0.1', port: 8787, maxReviewsPerDay: 100 };
  const store = new Store(root); assert.ok(store.acquire('worker'));
  const repositories = new Repositories(config, store, models, 'worker', origin), state = {};
  const billing = new Billing(new Stripe('sk_test_fake', fakeStripe(state)), repositories, origin);
  t.after(() => { repositories.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  // A started review with a receipt of the given recorded cost; null is a cost that never settled.
  let n = 0;
  const review = (entry, started, usd) => {
    entry.store.enable(true);
    const id = entry.store.enqueue(`delivery-${++n}`, n), directory = join(root, `run-${n}`);
    mkdirSync(directory);
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ profile: models[0].profile, finishedAt: 'now', calls: [{ meteredUsd: usd }] }));
    entry.store.db.prepare("UPDATE jobs SET state='completed', started=?, artifact=? WHERE id=?").run(started, directory, id);
  };
  return { root, repositories, billing, state, review, first: repositories.entries.get(42) };
}

test('a card is saved through Checkout in setup mode, and only a completed checkout of this customer counts', async t => {
  const f = setup(t);
  const url = await f.billing.checkout(99, 'owner', 7);
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_test_abc');
  const [customer, session] = f.state.calls;
  // A retried first checkout must not create a second customer.
  assert.deepEqual([customer.method, customer.path, customer.key, customer.params.name, customer.params['metadata[installation]']], ['POST', '/customers', 'atmin-customer-99', 'owner', '99']);
  assert.equal(session.params.mode, 'setup'); assert.equal(session.params.customer, 'cus_test1');
  assert.equal(session.params.success_url, `${origin}/usage?installation=99&checkout={CHECKOUT_SESSION_ID}`);
  assert.equal(session.params.cancel_url, `${origin}/usage?installation=99`);
  await f.billing.checkout(99, 'owner', 7);
  assert.equal(f.state.calls.filter(call => call.path === '/customers').length, 1);
  // Only Stripe's own Checkout page is a place to send the browser.
  f.state.sessionUrl = 'https://evil.test/pay';
  await assert.rejects(f.billing.checkout(99, 'owner', 7), StripeError);

  // Returning from Checkout proves nothing by itself: the session must be complete, saved a
  // card, and belong to this installation's customer.
  await assert.rejects(f.billing.confirm(99, 'not-a-session', 7), { status: 400 });
  await assert.rejects(f.billing.confirm(77, 'cs_test_abc', 7), { status: 400 });
  for (const session of [{ customer: 'cus_other', mode: 'setup', status: 'complete', setup_intent: { status: 'succeeded', payment_method: { id: 'pm_test1', card: { brand: 'visa', last4: '4242' } } } },
    { customer: 'cus_test1', mode: 'setup', status: 'open', setup_intent: { status: 'requires_payment_method', payment_method: null } },
    { customer: 'cus_test1', mode: 'payment', status: 'complete', setup_intent: null }]) {
    f.state.session = session;
    await assert.rejects(f.billing.confirm(99, 'cs_test_abc', 7), { status: 409 });
  }
  assert.equal(f.repositories.billing(99).card, null); assert.equal(f.repositories.limit(99).needsCard, true);
  delete f.state.session;
  assert.equal(await f.billing.confirm(99, 'cs_test_abc', 7), 'Visa ending 4242');
  const fetched = f.state.calls.at(-2), made = f.state.calls.at(-1);
  assert.equal(fetched.params['expand[0]'], 'setup_intent.payment_method');
  // Invoices charge the customer's default card, so the saved card becomes it.
  assert.deepEqual([made.path, made.params['invoice_settings[default_payment_method]']], ['/customers/cus_test1', 'pm_test1']);
  assert.deepEqual(f.repositories.billing(99), { customer: 'cus_test1', paymentMethod: 'pm_test1', card: 'Visa ending 4242', updated: f.repositories.billing(99).updated, updatedBy: 7 });
  assert.equal(f.repositories.limit(99).needsCard, false);
  // Stripe errors name the step and code, never the key.
  f.state.fail = { 'POST /checkout/sessions': 'api_key_expired' };
  await assert.rejects(f.billing.checkout(99, 'owner', 7), error => error instanceof StripeError && error.status === 402
    && error.message === 'Stripe 402 api_key_expired on POST /checkout/sessions: Test failure.' && !error.message.includes('sk_test'));
});

test('each installation with a card is invoiced once for the month before, at the price the PR comments showed', async t => {
  const f = setup(t);
  const now = Date.UTC(2026, 9, 2, 3), august = Date.UTC(2026, 7, 10), october = Date.UTC(2026, 9, 1, 12);
  f.repositories.setPlan(99, { freeReviews: 1, monthlyReviews: 10, multiplier: 2, minimumUsd: .05 }, 8);
  f.repositories.setCustomer(99, 'cus_test1', 7); f.repositories.setCard(99, 'pm_test1', 'Visa ending 4242', 7);
  // September: free, max(.10 x 2, .05) = .20, max(.01 x 2, .05) = .05, and one whose cost never settled.
  [.10, .10, .01, null].forEach((usd, i) => f.review(f.first, Date.UTC(2026, 8, 3) + i, usd));
  // Reviews outside September are not on its invoice.
  f.review(f.first, august, 1); f.review(f.first, october, 1);
  // A second organization with a card and no reviews owes nothing and is not invoiced.
  const other = f.repositories.connect(55, 'other/app', 77);
  f.repositories.setCustomer(77, 'cus_other', 7); f.repositories.setCard(77, 'pm_other', 'Visa ending 1881', 7);

  // Usage is final only once the month is over and its last reviews settled, so the first day waits.
  assert.deepEqual(await f.billing.invoice(Date.UTC(2026, 9, 1, 23)), []);
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual(await f.billing.invoice(now), ['in_test99']);
  const [invoice, item, finalize] = f.state.calls;
  // Prices are in US dollars whatever the Stripe account's default currency; Stripe refuses a USD
  // item on an invoice that defaulted to CAD. The draft waits until its item is on it.
  assert.deepEqual([invoice.path, invoice.params.customer, invoice.params.currency, invoice.params.collection_method, invoice.params.auto_advance, invoice.params.pending_invoice_items_behavior, invoice.key],
    ['/invoices', 'cus_test1', 'usd', 'charge_automatically', 'false', 'exclude', 'atmin-invoice-99-2026-09']);
  assert.deepEqual([item.path, item.params.invoice, item.params.amount, item.params.currency, item.params.description, item.key],
    ['/invoiceitems', 'in_test99', '25', 'usd', '4 reviews in September 2026: 1 free, 2 billed, 1 not billed because their cost never settled', 'atmin-item-99-2026-09']);
  assert.deepEqual([finalize.path, finalize.params.auto_advance, finalize.key], ['/invoices/in_test99/finalize', 'true', 'atmin-finalize-99-2026-09']);
  assert.deepEqual(f.repositories.invoice(99, '2026-09'), { invoice: 'in_test99', amountCents: 25, state: 'finalized' });
  assert.deepEqual(f.repositories.invoice(77, '2026-09'), { invoice: null, amountCents: 0, state: 'nothing-due' });
  // The hourly loop calls this again; nobody is billed twice.
  assert.deepEqual(await f.billing.invoice(now + 3_600_000), []);
  assert.equal(f.state.calls.length, 3);

  // A failure midway leaves the month for an operator instead of retrying into a double charge.
  f.review(other, Date.UTC(2026, 9, 5), .10);
  f.repositories.setPlan(77, { freeReviews: 0, monthlyReviews: 10, multiplier: 2, minimumUsd: .05 }, 8);
  f.state.fail = { 'POST /invoices/in_test77/finalize': 'invoice_finalization_error' };
  assert.deepEqual(await f.billing.invoice(Date.UTC(2026, 10, 2, 3)), []);
  assert.equal(f.repositories.invoice(99, '2026-10').state, 'nothing-due');
  assert.deepEqual(f.repositories.invoice(77, '2026-10'), { invoice: null, amountCents: 20, state: 'creating' });
  const calls = f.state.calls.length;
  delete f.state.fail;
  assert.deepEqual(await f.billing.invoice(Date.UTC(2026, 10, 2, 4)), []);
  assert.equal(f.state.calls.length, calls);
});
