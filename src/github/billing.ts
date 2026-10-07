import type { PaymentRecord, Repositories } from './repositories.js';
import { chargeCredit } from './dashboard-view.js';

// A failed Stripe call names its method, path, Stripe's error code and Stripe's own sentence
// (Stripe masks keys in it), never the rest of the body, so a log line says why a step broke.
export class StripeError extends Error {
  constructor(readonly status: number, readonly request: string, readonly code: string, detail?: string) { super(`Stripe ${status} ${code} on ${request}${detail ? `: ${detail}` : ''}`); }
}
export class Stripe {
  // Which of Stripe's modes the key works in; a key of neither kind is refused at start.
  readonly mode: 'test' | 'live';
  constructor(private key: string, private fetcher: typeof fetch = fetch) {
    const mode = /^[rs]k_(test|live)_/.exec(key)?.[1];
    if (mode !== 'test' && mode !== 'live') throw new Error('Unrecognized Stripe key');
    this.mode = mode;
  }
  async call(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}, idempotencyKey?: string): Promise<any> {
    const query = new URLSearchParams(params), request = `${method} ${path}`;
    const response = await this.fetcher(`https://api.stripe.com/v1${path}${method === 'GET' && query.size ? `?${query}` : ''}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: method === 'POST' ? query.toString() : null,
    }).catch(error => { throw new StripeError(0, request, error?.name === 'TimeoutError' ? 'no response in 15 s' : 'no response'); });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new StripeError(response.status, request, typeof data?.error?.code === 'string' ? data.error.code : typeof data?.error?.type === 'string' ? data.error.type : 'unreadable response',
      typeof data?.error?.message === 'string' ? data.error.message.slice(0, 300) : undefined);
    if (!data || typeof data !== 'object') throw new StripeError(response.status, request, 'unreadable response');
    return data;
  }
}

// Credit is sold in these amounts, in US cents, and auto top-up buys one of them whenever an
// organization's credit falls below `topUpBelowUsd`.
export const creditAmounts = [1000, 2500, 5000, 10000];
export const topUpBelowUsd = 5;

const id = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`);
const checkoutId = /^cs_(test|live)_[A-Za-z0-9]{1,250}$/;
const brands: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
const log = (line: string) => process.stderr.write(`atmin review: ${line}\n`);
const failure = (error: unknown) => error instanceof Error ? error.message.slice(0, 200) : 'non-error thrown';
// Stripe's receipt page for one charge; nothing else is linked.
const receiptUrl = (value: unknown) => typeof value === 'string' && value.startsWith('https://pay.stripe.com/receipts/') && value.length <= 2048 ? value : null;
// A saved card as the Billing page names it, or null for anything else.
function cardOf(method: any): { id: string; card: string; expires: string } | null {
  if (!id('pm').test(method?.id) || typeof method.card?.last4 !== 'string' || !/^\d{4}$/.test(method.card.last4) || !Number.isInteger(method.card.exp_month) || method.card.exp_month < 1
    || method.card.exp_month > 12 || !Number.isInteger(method.card.exp_year) || method.card.exp_year < 2000 || method.card.exp_year > 2200) return null;
  return { id: method.id, card: `${brands[method.card.brand] ?? 'Card'} ending ${method.card.last4}`, expires: `${String(method.card.exp_month).padStart(2, '0')}/${method.card.exp_year}` };
}
// Why a top-up failed, in words for the Billing page, from Stripe's error code.
const topUpFailure = (code: string) => code === 'authentication_required' || code === 'requires_action' ? 'The card’s bank asked the card holder to approve the charge.'
  : code === 'expired_card' ? 'The card has expired.' : code === 'card_declined' || code === 'requires_payment_method' ? 'The card was declined.' : 'Stripe could not charge the card.';

// Prepaid review credit through Stripe, in US dollars. An admin buys credit on a Checkout page,
// which also saves the card for auto top-up; the purchase is credited when the browser returns
// (`confirm`), or by the hourly check (`reconcile`) when it never does. With auto top-up on, the
// saved card is charged off-session whenever credit falls below $5 (`topUp`); a charge the card
// does not pay stops auto top-up until an admin buys credit or turns it on again. Each payment is
// a row written before Stripe is asked to take it, and a top-up is created unconfirmed, recorded,
// then confirmed, so a retried or interrupted payment never charges twice. Stripe emails the
// receipt to the address entered in Checkout.
export class Billing {
  constructor(private stripe: Stripe, private repositories: Repositories, private origin: string) { repositories.stripeMode(stripe.mode); }
  private async customer(installation: number, account: string, by: number): Promise<string> {
    const existing = this.repositories.billing(installation)?.customer;
    if (existing) return existing;
    const created = await this.stripe.call('POST', '/customers', { name: account, 'metadata[installation]': String(installation), 'metadata[account]': account }, `atmin-customer-${installation}`);
    if (!id('cus').test(created.id)) throw new StripeError(200, 'POST /customers', 'invalid customer');
    this.repositories.setCustomer(installation, created.id, by);
    log(`Stripe customer ${created.id} created for installation ${installation} by GitHub user ${by}`);
    return created.id;
  }
  // The Checkout page for buying `cents` of credit; the browser is sent there.
  async checkout(installation: number, account: string, cents: number, by: number): Promise<string> {
    if (!creditAmounts.includes(cents)) throw new StripeError(400, 'checkout', 'invalid amount');
    const customer = await this.customer(installation, account, by), page = `${this.origin}/billing?installation=${installation}`;
    // The account's default currency (CAD for atmin) must not decide the price's.
    const session = await this.stripe.call('POST', '/checkout/sessions', { mode: 'payment', customer, 'payment_method_types[0]': 'card',
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(cents),
      'line_items[0][price_data][product_data][name]': 'atmin review credit', 'payment_intent_data[setup_future_usage]': 'off_session',
      'payment_intent_data[description]': `atmin review credit for ${account}`, 'payment_intent_data[metadata][installation]': String(installation),
      success_url: `${page}&checkout={CHECKOUT_SESSION_ID}`, cancel_url: page, 'metadata[installation]': String(installation) });
    if (!checkoutId.test(session.id) || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) throw new StripeError(200, 'POST /checkout/sessions', 'invalid session');
    this.repositories.startPayment(session.id, installation, 'checkout', cents, by);
    log(`credit checkout ${session.id} for ${cents} cents started for installation ${installation} by GitHub user ${by}`);
    return session.url;
  }
  // After Checkout returns: credits the purchase if Stripe took the payment, and says how much
  // was added and which card was saved. Returning twice adds nothing more.
  async confirm(installation: number, session: string, by: number): Promise<{ usd: number; card: string | null }> {
    const row = checkoutId.test(session) ? this.repositories.payment(session) : null;
    if (!row || row.installation !== installation || row.kind !== 'checkout') throw new StripeError(400, 'confirm', 'unknown checkout');
    if (row.state !== 'paid' && !await this.settleCheckout(row, by)) throw new StripeError(409, `GET /checkout/sessions/${session}`, 'checkout not paid');
    return { usd: row.cents / 100, card: this.repositories.billing(installation)?.card ?? null };
  }
  // Asks Stripe how one checkout stands; true once it is paid and credited.
  private async settleCheckout(row: PaymentRecord, by: number | null): Promise<boolean> {
    const found = await this.stripe.call('GET', `/checkout/sessions/${row.reference}`, { 'expand[0]': 'payment_intent.payment_method', 'expand[1]': 'payment_intent.latest_charge', 'expand[2]': 'customer' });
    if (found.status === 'expired') { this.repositories.finishPayment(row.reference, 'expired'); log(`credit checkout ${row.reference} for installation ${row.installation} expired unpaid`); return false; }
    if (found.status !== 'complete' || found.payment_status !== 'paid') return false;
    const intent = found.payment_intent;
    if (found.customer?.id !== this.repositories.billing(row.installation)?.customer || found.mode !== 'payment' || found.amount_total !== row.cents || found.currency !== 'usd' || intent?.status !== 'succeeded') {
      // Not expected from Stripe; marked failed so the hourly check stops asking, and logged once.
      this.repositories.finishPayment(row.reference, 'failed');
      log(`credit checkout ${row.reference} for installation ${row.installation} is paid but does not match what was sold (customer, amount, currency or payment); marked failed and nothing added, check it in Stripe`);
      return false;
    }
    this.repositories.addCredit(row.installation, row.reference, 'purchase', row.cents * 10_000, row.by, null, receiptUrl(intent.latest_charge?.receipt_url));
    this.repositories.finishPayment(row.reference, 'paid');
    const card = cardOf(intent.payment_method);
    // Checkout puts the address it collected on a customer that had none.
    const email = typeof found.customer.email === 'string' && found.customer.email.length <= 512 ? found.customer.email : null;
    if (card) this.repositories.setCard(row.installation, card.id, card.card, card.expires, email, by);
    log(`credit checkout ${row.reference} paid: ${row.cents} cents added to installation ${row.installation}${card ? `; card ${card.id} saved for auto top-up` : '; no card saved'}`);
    return true;
  }
  // Hourly: settles every checkout and top-up whose outcome is not known yet, so a buyer who
  // closed the page after paying is still credited.
  async reconcile(): Promise<void> {
    for (const row of this.repositories.openPayments()) {
      try { if (row.kind === 'checkout') await this.settleCheckout(row, row.by); else await this.settleTopUp(row); }
      catch (error) { log(`checking ${row.kind} ${row.reference} for installation ${row.installation} failed: ${failure(error)}`); }
    }
  }
  // Buys the chosen amount for each installation with auto top-up on whose credit is below $5,
  // or moves on a top-up still open. Called after each review, hourly, and when an admin turns
  // auto top-up on (`only`).
  async topUp(only?: number, now = Date.now()): Promise<void> {
    for (const installation of this.repositories.toppedUp().filter(i => only === undefined || i === only)) {
      try {
        const open = this.repositories.openPayments().find(row => row.installation === installation && row.kind === 'top-up');
        if (open) { await this.settleTopUp(open); continue; }
        chargeCredit(this.repositories, installation, now);
        if (this.repositories.balance(installation) >= topUpBelowUsd) continue;
        const reference = `atmin-topup-${installation}-${this.repositories.topUpCount(installation) + 1}`;
        this.repositories.startPayment(reference, installation, 'top-up', this.repositories.billing(installation)!.topUpCents!, null);
        await this.settleTopUp(this.repositories.payment(reference)!);
      } catch (error) { log(`auto top-up for installation ${installation} failed and is retried later: ${failure(error)}`); }
    }
  }
  // One step at a time: make the PaymentIntent unconfirmed (an idempotent call), record it,
  // confirm it off-session, and credit it once Stripe says it succeeded. A PaymentIntent is paid
  // at most once, so asking again after an interruption cannot charge twice.
  private async settleTopUp(row: PaymentRecord): Promise<void> {
    const record = this.repositories.billing(row.installation)!;
    let intent = row.intent ? await this.stripe.call('GET', `/payment_intents/${row.intent}`, { 'expand[0]': 'latest_charge' }) : null;
    try {
      if (!intent) {
        intent = await this.stripe.call('POST', '/payment_intents', { amount: String(row.cents), currency: 'usd', customer: record.customer, payment_method: record.paymentMethod!,
          description: 'atmin review credit, auto top-up', 'metadata[installation]': String(row.installation), 'metadata[reference]': row.reference }, row.reference);
        if (!id('pi').test(intent.id) || intent.amount !== row.cents) throw new StripeError(200, 'POST /payment_intents', 'invalid payment intent');
        this.repositories.setPaymentIntent(row.reference, intent.id);
      }
      if (intent.status === 'requires_confirmation') intent = await this.stripe.call('POST', `/payment_intents/${intent.id}/confirm`, { off_session: 'true', 'expand[0]': 'latest_charge' }, `${row.reference}-confirm`);
    } catch (error) {
      // 402: the card did not pay. 400: Stripe refused the request, such as a card since removed.
      if (error instanceof StripeError && [400, 402].includes(error.status)) return this.failTopUp(row, error.code);
      throw error;
    }
    if (intent.status === 'succeeded') {
      this.repositories.addCredit(row.installation, row.reference, 'top-up', row.cents * 10_000, null, null, receiptUrl(intent.latest_charge?.receipt_url));
      this.repositories.finishPayment(row.reference, 'paid');
      log(`auto top-up ${intent.id} paid: ${row.cents} cents added to installation ${row.installation}`);
    } else if (['requires_payment_method', 'requires_action', 'canceled'].includes(intent.status)) {
      this.failTopUp(row, typeof intent.last_payment_error?.code === 'string' ? intent.last_payment_error.code : intent.status);
    } // Anything else, such as 'processing', is asked about again by the hourly check.
  }
  private failTopUp(row: PaymentRecord, code: string): void {
    this.repositories.finishPayment(row.reference, 'failed');
    this.repositories.failTopUp(row.installation, topUpFailure(code));
    log(`auto top-up ${row.reference} of ${row.cents} cents for installation ${row.installation} failed with ${code}; auto top-up stopped until an admin buys credit or turns it on again`);
  }
}
