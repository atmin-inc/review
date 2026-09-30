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
    if (init.method === 'GET' && path.startsWith('/checkout/sessions/')) return Response.json(state.session ?? { customer: { id: 'cus_test1', email: 'billing@owner.test' }, mode: 'setup', status: 'complete',
      setup_intent: { status: 'succeeded', payment_method: { id: state.method ?? 'pm_test1', card: { brand: 'visa', last4: '4242' } } } });
    if (init.method === 'POST' && path.startsWith('/customers/')) return Response.json({ id: path.slice(11) });
    if (init.method === 'POST' && path === '/invoices') return Response.json({ id: `in_test${params['metadata[installation]']}` });
    if (init.method === 'POST' && path === '/invoiceitems') return Response.json({ id: 'ii_test1' });
    if (init.method === 'POST' && /^\/invoices\/in_\w+\/finalize$/.test(path)) return Response.json({ id: path.split('/')[2], status: 'open', attempt_count: 0, hosted_invoice_url: `https://invoice.stripe.com/i/acct_1/${path.split('/')[2]}` });
    // `state.invoices` holds what Stripe says about each invoice now; paying one marks it paid.
    if (init.method === 'GET' && /^\/invoices\/in_\w+$/.test(path)) return Response.json(state.invoices?.[path.split('/')[2]] ?? { id: path.split('/')[2], status: 'open', attempt_count: 0 });
    if (init.method === 'POST' && /^\/invoices\/in_\w+\/pay$/.test(path)) return Response.json({ ...(state.invoices ??= {})[path.split('/')[2]], id: path.split('/')[2], status: 'paid' });
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
  for (const session of [{ customer: { id: 'cus_other' }, mode: 'setup', status: 'complete', setup_intent: { status: 'succeeded', payment_method: { id: 'pm_test1', card: { brand: 'visa', last4: '4242' } } } },
    { customer: { id: 'cus_test1' }, mode: 'setup', status: 'open', setup_intent: { status: 'requires_payment_method', payment_method: null } },
    { customer: { id: 'cus_test1' }, mode: 'payment', status: 'complete', setup_intent: null }]) {
    f.state.session = session;
    await assert.rejects(f.billing.confirm(99, 'cs_test_abc', 7), { status: 409 });
  }
  assert.equal(f.repositories.billing(99).card, null); assert.equal(f.repositories.limit(99).needsCard, true);
  delete f.state.session;
  assert.equal(await f.billing.confirm(99, 'cs_test_abc', 7), 'Visa ending 4242');
  const fetched = f.state.calls.at(-2), made = f.state.calls.at(-1);
  assert.deepEqual([fetched.params['expand[0]'], fetched.params['expand[1]']], ['setup_intent.payment_method', 'customer']);
  // Invoices charge the customer's default card, so the saved card becomes it.
  assert.deepEqual([made.path, made.params['invoice_settings[default_payment_method]']], ['/customers/cus_test1', 'pm_test1']);
  // Checkout puts the address it collected on the customer; Stripe sends receipts there.
  assert.deepEqual(f.repositories.billing(99), { customer: 'cus_test1', paymentMethod: 'pm_test1', card: 'Visa ending 4242', email: 'billing@owner.test', updated: f.repositories.billing(99).updated, updatedBy: 7 });
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
  f.repositories.setCustomer(99, 'cus_test1', 7); f.repositories.setCard(99, 'pm_test1', 'Visa ending 4242', 'billing@owner.test', 7);
  // September: free, max(.10 x 2, .05) = .20, max(.01 x 2, .05) = .05, and one whose cost never settled.
  [.10, .10, .01, null].forEach((usd, i) => f.review(f.first, Date.UTC(2026, 8, 3) + i, usd));
  // Reviews outside September are not on its invoice.
  f.review(f.first, august, 1); f.review(f.first, october, 1);
  // A second organization with a card and no reviews owes nothing and is not invoiced.
  const other = f.repositories.connect(55, 'other/app', 77);
  f.repositories.setCustomer(77, 'cus_other', 7); f.repositories.setCard(77, 'pm_other', 'Visa ending 1881', null, 7);

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
  assert.equal(f.repositories.invoices(99)[0].url, 'https://invoice.stripe.com/i/acct_1/in_test99');
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

test('a charge the card fails stops the default plan at its free reviews until the invoice is paid, and a new card pays it', async t => {
  const f = setup(t), now = Date.UTC(2026, 9, 2, 3);
  f.repositories.setCustomer(99, 'cus_test1', 7); f.repositories.setCard(99, 'pm_test1', 'Visa ending 4242', 'billing@owner.test', 7);
  for (let i = 0; i < 25; i++) f.review(f.first, Date.UTC(2026, 8, 3) + i, .10);
  assert.deepEqual(await f.billing.invoice(now), ['in_test99']);
  const url = 'https://invoice.stripe.com/i/acct_1/in_test99', checks = () => f.state.calls.filter(call => call.method === 'GET' && call.path === '/invoices/in_test99').length;
  // Stripe charges the card about an hour after finalizing; until then nothing is owed.
  await f.billing.refresh(now + 1000);
  assert.deepEqual([f.repositories.invoices(99)[0].state, f.repositories.limit(99).limit], ['finalized', 1000]);
  // A declined charge leaves the invoice open with an attempt: the default plan falls back to the
  // free reviews, the same as having no card, and the hourly check keeps asking.
  f.state.invoices = { in_test99: { id: 'in_test99', status: 'open', attempt_count: 1, hosted_invoice_url: url } };
  await f.billing.refresh(now + 3_600_000);
  assert.deepEqual(f.repositories.invoices(99)[0], { month: '2026-09', invoice: 'in_test99', amountCents: 100, reviews: 25, state: 'failed', url });
  assert.deepEqual(f.repositories.limit(99), { plan: f.repositories.plan(99).plan, limit: 20, needsCard: true, unpaid: '2026-09' });
  // Paid on Stripe's page, or by one of Stripe's retries: the limit lifts on the next check.
  f.state.invoices.in_test99 = { id: 'in_test99', status: 'paid', attempt_count: 2, hosted_invoice_url: url };
  await f.billing.refresh(now + 7_200_000);
  assert.deepEqual([f.repositories.invoices(99)[0].state, f.repositories.limit(99).limit], ['paid', 1000]);
  // A paid invoice is settled; nothing asks about it again.
  const asked = checks();
  await f.billing.refresh(now + 10_800_000);
  assert.equal(checks(), asked);

  // Again, but the admin replaces the card: the new one is charged for the invoice at once.
  f.repositories.settleInvoice(99, '2026-09', 'failed', url, now);
  f.state.method = 'pm_test2';
  await f.billing.confirm(99, 'cs_test_abc', 7);
  const pay = f.state.calls.at(-1);
  assert.deepEqual([pay.method, pay.path, pay.params.payment_method, pay.key], ['POST', '/invoices/in_test99/pay', 'pm_test2', 'atmin-pay-in_test99-pm_test2']);
  assert.deepEqual([f.repositories.invoices(99)[0].state, f.repositories.limit(99).unpaid], ['paid', null]);
  // A new card that is declined too is still saved; the invoice stays owed.
  f.repositories.settleInvoice(99, '2026-09', 'uncollectible', url, now);
  f.state.method = 'pm_test3'; f.state.fail = { 'POST /invoices/in_test99/pay': 'card_declined' };
  assert.equal(await f.billing.confirm(99, 'cs_test_abc', 7), 'Visa ending 4242');
  assert.deepEqual([f.repositories.billing(99).paymentMethod, f.repositories.limit(99).unpaid], ['pm_test3', '2026-09']);
  delete f.state.fail;

  // An operator voiding the invoice in Stripe ends what is owed; a status billing does not know,
  // a failed check and a page that is not Stripe's change nothing.
  f.state.invoices.in_test99 = { id: 'in_test99', status: 'void', hosted_invoice_url: 'https://evil.test/pay' };
  await f.billing.refresh(now + 14_400_000);
  assert.deepEqual([f.repositories.invoices(99)[0].state, f.repositories.invoices(99)[0].url, f.repositories.limit(99).limit], ['void', null, 1000]);
  f.repositories.settleInvoice(99, '2026-09', 'failed', url, now);
  f.state.invoices.in_test99 = { id: 'in_test99', status: 'draft' };
  await f.billing.refresh(now + 18_000_000);
  f.state.fail = { 'GET /invoices/in_test99': 'rate_limit' };
  await f.billing.refresh(now + 21_600_000);
  assert.deepEqual([f.repositories.invoices(99)[0].state, f.repositories.invoices(99)[0].url], ['failed', url]);
});
