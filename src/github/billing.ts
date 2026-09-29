import { month, type Repositories } from './repositories.js';
import { monthlyUsage } from './dashboard-view.js';

// A failed Stripe call names its method, path, Stripe's error code and Stripe's own sentence
// (Stripe masks keys in it), never the rest of the body, so a log line says why a step broke.
export class StripeError extends Error {
  constructor(readonly status: number, readonly request: string, readonly code: string, detail?: string) { super(`Stripe ${status} ${code} on ${request}${detail ? `: ${detail}` : ''}`); }
}
export class Stripe {
  constructor(private key: string, private fetcher: typeof fetch = fetch) {}
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

const id = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`);
const brands: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
const log = (line: string) => process.stderr.write(`atmin review: ${line}\n`);

// Cards and monthly invoices through Stripe. A card is saved with Checkout in setup mode, so
// nothing is charged then. On the second day of each UTC month, each installation with a card
// is invoiced once for the month before, in US dollars, at the price the PR comments showed
// under the plan in force when the invoice is made.
export class Billing {
  constructor(private stripe: Stripe, private repositories: Repositories, private origin: string) {}
  // The Checkout page for saving a card; the browser is sent there.
  async checkout(installation: number, account: string, by: number): Promise<string> {
    let customer = this.repositories.billing(installation)?.customer;
    if (!customer) {
      const created = await this.stripe.call('POST', '/customers', { name: account, 'metadata[installation]': String(installation), 'metadata[account]': account }, `atmin-customer-${installation}`);
      if (!id('cus').test(created.id)) throw new StripeError(200, 'POST /customers', 'invalid customer');
      customer = created.id as string;
      this.repositories.setCustomer(installation, customer, by);
      log(`Stripe customer ${customer} created for installation ${installation} by GitHub user ${by}`);
    }
    const usage = `${this.origin}/usage?installation=${installation}`;
    const session = await this.stripe.call('POST', '/checkout/sessions', { mode: 'setup', customer, 'payment_method_types[0]': 'card',
      success_url: `${usage}&checkout={CHECKOUT_SESSION_ID}`, cancel_url: usage, 'metadata[installation]': String(installation) });
    if (typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) throw new StripeError(200, 'POST /checkout/sessions', 'invalid session');
    log(`card checkout started for installation ${installation} by GitHub user ${by}`);
    return session.url;
  }
  // After Checkout returns: the session must belong to this installation's customer and have
  // saved a card, which becomes the customer's default for invoices.
  async confirm(installation: number, session: string, by: number): Promise<string> {
    const record = this.repositories.billing(installation);
    if (!record || !/^cs_(test|live)_[A-Za-z0-9]{1,250}$/.test(session)) throw new StripeError(400, 'confirm', 'unknown checkout');
    const found = await this.stripe.call('GET', `/checkout/sessions/${session}`, { 'expand[0]': 'setup_intent.payment_method' });
    const method = found.setup_intent?.payment_method;
    if (found.customer !== record.customer || found.mode !== 'setup' || found.status !== 'complete' || found.setup_intent?.status !== 'succeeded'
      || !id('pm').test(method?.id) || typeof method.card?.last4 !== 'string' || !/^\d{4}$/.test(method.card.last4)) throw new StripeError(409, `GET /checkout/sessions/${session}`, 'checkout not complete');
    await this.stripe.call('POST', `/customers/${record.customer}`, { 'invoice_settings[default_payment_method]': method.id }, `atmin-default-${method.id}`);
    const card = `${brands[method.card.brand] ?? 'Card'} ending ${method.card.last4}`;
    this.repositories.setCard(installation, method.id, card, by);
    log(`card ${method.id} saved for installation ${installation} by GitHub user ${by}`);
    return card;
  }
  // Bills the month before `now`, from its second day. Returns the invoices created.
  async invoice(now = Date.now()): Promise<string[]> {
    const current = month(now);
    if (now < current.start + 86_400_000) return [];
    const previous = current.start - 1, name = month(previous).name, created: string[] = [];
    for (const installation of this.repositories.billed()) {
      const existing = this.repositories.invoice(installation, name);
      if (existing) {
        if (existing.state === 'creating') log(`invoice for installation ${installation} for ${name} was interrupted; check Stripe for customer ${this.repositories.billing(installation)!.customer} before billing by hand`);
        continue;
      }
      const { plan } = this.repositories.limit(installation), usage = monthlyUsage(this.repositories, installation, previous);
      const cents = Math.round(usage.estimatedUsd * 100), billed = Math.max(0, usage.reviews - plan.freeReviews) - usage.unknownCostReviews;
      if (!cents) { this.repositories.startInvoice(installation, name, 0, usage.reviews, 'nothing-due'); continue; }
      this.repositories.startInvoice(installation, name, cents, usage.reviews, 'creating');
      try {
        const customer = this.repositories.billing(installation)!.customer, label = new Date(`${name}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        // The account's default currency (CAD for atmin) must not decide the invoice's. The draft
        // does not advance by itself, so a failure before finalizing never sends an empty invoice.
        const invoice = await this.stripe.call('POST', '/invoices', { customer, currency: 'usd', collection_method: 'charge_automatically', auto_advance: 'false', pending_invoice_items_behavior: 'exclude',
          description: `atmin review, ${label}`, 'metadata[installation]': String(installation), 'metadata[month]': name }, `atmin-invoice-${installation}-${name}`);
        if (!id('in').test(invoice.id)) throw new StripeError(200, 'POST /invoices', 'invalid invoice');
        await this.stripe.call('POST', '/invoiceitems', { customer, invoice: invoice.id, amount: String(cents), currency: 'usd',
          description: `${usage.reviews} reviews in ${label}: ${plan.freeReviews} free, ${billed} billed${usage.unknownCostReviews ? `, ${usage.unknownCostReviews} not billed because their cost never settled` : ''}` }, `atmin-item-${installation}-${name}`);
        // Finalizing hands collection to Stripe, which charges the default card.
        await this.stripe.call('POST', `/invoices/${invoice.id}/finalize`, { auto_advance: 'true' }, `atmin-finalize-${installation}-${name}`);
        this.repositories.finishInvoice(installation, name, invoice.id);
        log(`invoice ${invoice.id} of ${cents} cents for ${usage.reviews} reviews in ${name} finalized for installation ${installation}`);
        created.push(invoice.id);
      } catch (error) {
        log(`invoice for installation ${installation} for ${name} failed and is left for an operator: ${error instanceof Error ? error.message.slice(0, 200) : 'non-error thrown'}`);
      }
    }
    return created;
  }
}
