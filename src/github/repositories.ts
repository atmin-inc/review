import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PilotConfig } from './config.js';
import { COUNTED, Store, type Job } from './store.js';
import type { ModelKeys } from './model-keys.js';
import { ReviewSettings, type ModelChoice } from './settings.js';
import { DEFAULT_MAX_INSTALLATION_DISK_MB, directoryBytes } from './runner.js';
import { chargeCredit } from './dashboard-view.js';

export interface Repository { config: PilotConfig; store: Store; settings: ReviewSettings; }
// A plan caps an installation's reviews per UTC month and prices the ones beyond its free
// allowance. Those are paid from the installation's prepaid credit (see `credit` and billing.ts):
// once the free reviews are used, a review starts only while credit is above zero, so one
// review can take it slightly below. An operator-set plan applies as set, credit included.
export interface Plan { freeReviews: number; monthlyReviews: number; multiplier: number; minimumUsd: number; }
export const defaultPlan: Plan = { freeReviews: 20, monthlyReviews: 1000, multiplier: 2, minimumUsd: 0.05 };
// Reviews that started before credit replaced monthly invoices are never taken from credit.
export const creditStart = Date.UTC(2026, 9, 1);
// Credit is a ledger in millionths of a US dollar, one row per reference: Checkout purchases
// (the session ID), automatic top-ups (the payment's reference), operator grants, and one row
// per started review once it is priced (`review-<job>`, zero while free), so nothing is added or
// taken twice. `receipt` is Stripe's receipt page for a payment.
export type CreditKind = 'purchase' | 'top-up' | 'grant' | 'review';
export interface CreditRecord { reference: string; kind: CreditKind; usd: number; created: number; by: number | null; note: string | null; receipt: string | null; }
// A payment to Stripe for credit, written before Stripe is asked to take it. 'open' until Stripe
// says it was paid, failed, or (a Checkout page left unpaid) expired; also expired when the Stripe
// key changes mode (`stripeMode`). `intent` is a top-up's
// PaymentIntent once Stripe has made it.
export type PaymentState = 'open' | 'paid' | 'failed' | 'expired';
export interface PaymentRecord { reference: string; installation: number; kind: 'checkout' | 'top-up'; cents: number; state: PaymentState; intent: string | null; created: number; by: number | null; }
// `customer` is the installation's Stripe customer; `card` describes the card its last purchase
// saved, as "Visa ending 4242", and `expires` its expiry as "MM/YYYY" (null for cards saved before
// expiry was recorded). `email` is where Stripe sends receipts: the address entered in Checkout,
// which Stripe sets on the customer. `topUpCents` is the auto top-up amount (null when off), and
// `topUpFailed` why the last top-up failed, which keeps auto top-up stopped until it is cleared.
export interface BillingRecord { customer: string; paymentMethod: string | null; card: string | null; expires: string | null; email: string | null; topUpCents: number | null; topUpFailed: string | null; updated: number; updatedBy: number; }
export const perInstallation = 10, maxRepositories = 200;
export const dailyLimitReached = 'The operator’s rolling 24-hour review limit was reached. A maintainer can rerun after capacity is available. No inference was started.';
export const storageLimitReached = (limitMb: number) => `This organization’s review records on the atmin review service are over its ${limitMb} MB storage limit, so this review did not start. Records older than 90 days are deleted automatically; contact atmin to raise the limit sooner. No inference was started.`;
const mb = (bytes: number) => Math.round(bytes / 1024 ** 2);

export function month(now: number): { name: string; start: number; end: number } {
  const date = new Date(now), start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return { name: new Date(start).toISOString().slice(0, 7), start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
export function parsePlan(value: unknown): Plan {
  const p = value as Plan;
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100_000;
  const usd = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== 4 || Object.keys(p).some(k => !(k in defaultPlan))
    || !count(p.freeReviews) || !count(p.monthlyReviews) || !usd(p.multiplier) || !usd(p.minimumUsd)) throw new Error('Invalid plan');
  return { freeReviews: p.freeReviews, monthlyReviews: p.monthlyReviews, multiplier: p.multiplier, minimumUsd: p.minimumUsd };
}
// No `@`: the refusal is posted on the PR and must not notify the author.
export function authorLimitReached(login: string, limit: number, now: number): string {
  const { start, end } = month(now);
  const name = new Date(start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `PRs by \`${login}\` reached this repository's limit of ${limit} ${limit === 1 ? 'review' : 'reviews'} per author for ${name}. Reviews resume on ${new Date(end).toISOString().slice(0, 10)}, or sooner if a repository admin raises the limit on the atmin dashboard. No inference was started.`;
}
const monthName = (start: number) => new Date(start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function monthlyLimitReached(plan: Plan, now: number): string {
  const { start, end } = month(now);
  if (!plan.monthlyReviews) return 'Reviews are turned off for this organization. An atmin operator can turn them back on. No inference was started.';
  return `This organization reached its limit of ${plan.monthlyReviews} reviews for ${monthName(start)}. Reviews resume on ${new Date(end).toISOString().slice(0, 10)}, or sooner if an atmin operator raises the limit. No inference was started.`;
}
// `url` is the Billing page, set when credit can be bought (a Stripe key is configured).
export function creditUsedUp(plan: Plan, now: number, url?: string): string {
  const { start, end } = month(now);
  const used = plan.freeReviews ? `used its ${plan.freeReviews} free reviews for ${monthName(start)} and ` : '';
  const buy = url ? `A repository admin can buy credit on the atmin dashboard (${url}) to keep reviewing` : 'atmin can add credit to keep reviewing';
  return `This organization ${used}has no review credit left. ${buy}${plan.freeReviews ? `; otherwise free reviews start again on ${new Date(end).toISOString().slice(0, 10)}` : ''}. No inference was started.`;
}
// Reviews this service ran: one on the author's own runner costs no inference and counts toward no plan.
const startedSince = (store: Store, since: number) => Number(store.db.prepare('SELECT count(*) AS n FROM jobs WHERE started>=? AND runner IS NULL').get(since)!.n);

// ponytail: any installation connects up to ten repositories itself; one scheduler serves them all.
// Separate stores reuse the worker's existing isolation boundary without tenant SQL.
export class Repositories {
  readonly entries = new Map<number, Repository>();
  // `origin` is the dashboard's, set only when credit can be bought (a Stripe key is configured),
  // for the link in a refusal that asks for it.
  constructor(readonly config: PilotConfig, readonly root: Store, private models: ModelChoice[], private owner: string, private origin?: string, readonly keys?: ModelKeys) {
    // The `invoices` table of the monthly-invoice release is left as it is on servers that have it.
    root.db.exec(`CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, installation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (installation INTEGER PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, updatedBy INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing (installation INTEGER PRIMARY KEY, customer TEXT NOT NULL, paymentMethod TEXT, card TEXT, updated INTEGER NOT NULL, updatedBy INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit (reference TEXT PRIMARY KEY, installation INTEGER NOT NULL, kind TEXT NOT NULL, micros INTEGER NOT NULL, created INTEGER NOT NULL, by INTEGER, note TEXT, receipt TEXT);
      CREATE INDEX IF NOT EXISTS credit_installation ON credit(installation, created);
      CREATE TABLE IF NOT EXISTS payments (reference TEXT PRIMARY KEY, installation INTEGER NOT NULL, kind TEXT NOT NULL, cents INTEGER NOT NULL, state TEXT NOT NULL, intent TEXT, created INTEGER NOT NULL, by INTEGER);
      CREATE TABLE IF NOT EXISTS stripe (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL);`);
    // Columns added after the first billing release; its table exists on the server.
    for (const [column, type] of [['email', 'TEXT'], ['expires', 'TEXT'], ['topUpCents', 'INTEGER'], ['topUpFailed', 'TEXT']]) {
      if (!root.db.prepare('PRAGMA table_info(billing)').all().some(row => row.name === column)) root.db.exec(`ALTER TABLE billing ADD COLUMN ${column} ${type}`);
    }
    const rows = root.db.prepare('SELECT * FROM repositories').all();
    if (rows.length >= maxRepositories || rows.some(row => row.id === config.repositoryId)) throw new Error('Repository directory does not match installation');
    this.entries.set(config.repositoryId, { config, store: root, settings: new ReviewSettings(config, root, models) });
    for (const row of rows) this.open(Number(row.id), String(row.name), Number(row.installation));
  }
  private open(id: number, name: string, installation: number): Repository {
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(installation) || installation < 1 || !/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error('Invalid repository identity');
    const config = { ...this.config, repositoryId: id, repository: name, installationId: installation, trustedChecks: [],
      stateDirectory: join(this.config.stateDirectory, 'repositories', String(installation), String(id)) };
    const store = new Store(config.stateDirectory);
    if (!store.acquire(this.owner)) { store.close(); throw new Error('Repository already has a worker'); }
    const repository = { config, store, settings: new ReviewSettings(config, store, this.models) };
    this.entries.set(id, repository);
    return repository;
  }
  of(installation: number): Repository[] { return [...this.entries.values()].filter(entry => entry.config.installationId === installation); }
  // Installations with a connected repository, including ones since removed from GitHub.
  installations(): Set<number> { return new Set([...this.entries.values()].map(entry => entry.config.installationId)); }
  // Caller must verify current admin permission and installation membership.
  connect(id: number, name: string, installation: number): Repository {
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.config.repository !== name || existing.config.installationId !== installation) throw new Error('Repository name or installation changed; operator reconciliation required');
      return existing;
    }
    if (this.entries.size >= maxRepositories || this.of(installation).length >= perInstallation) throw new Error('Repository limit reached');
    const repository = this.open(id, name, installation);
    try { this.root.db.prepare('INSERT INTO repositories VALUES(?,?,?)').run(id, name, installation); }
    catch (error) { repository.store.close(); this.entries.delete(id); throw error; }
    return repository;
  }
  plan(installation: number): { plan: Plan; updatedAt: number | null; updatedBy: number | null } {
    const row = this.root.db.prepare('SELECT * FROM plans WHERE installation=?').get(installation);
    return row ? { plan: parsePlan(JSON.parse(String(row.value))), updatedAt: Number(row.updated), updatedBy: Number(row.updatedBy) }
      : { plan: defaultPlan, updatedAt: null, updatedBy: null };
  }
  billing(installation: number): BillingRecord | null {
    const row = this.root.db.prepare('SELECT * FROM billing WHERE installation=?').get(installation);
    const text = (value: unknown) => value === null ? null : String(value);
    return row ? { customer: String(row.customer), paymentMethod: text(row.paymentMethod), card: text(row.card), expires: text(row.expires), email: text(row.email),
      topUpCents: row.topUpCents === null ? null : Number(row.topUpCents), topUpFailed: text(row.topUpFailed), updated: Number(row.updated), updatedBy: Number(row.updatedBy) } : null;
  }
  setCustomer(installation: number, customer: string, by: number): void {
    // Two admins starting Checkout at once get the same customer from Stripe's idempotency key.
    this.root.db.prepare('INSERT INTO billing(installation,customer,updated,updatedBy) VALUES(?,?,?,?) ON CONFLICT(installation) DO NOTHING').run(installation, customer, Date.now(), by);
  }
  // A card that just paid works, so saving one also lets a stopped auto top-up try again.
  setCard(installation: number, paymentMethod: string, card: string, expires: string, email: string | null, by: number | null): void {
    this.root.db.prepare('UPDATE billing SET paymentMethod=?, card=?, expires=?, email=?, topUpFailed=NULL, updated=?, updatedBy=COALESCE(?, updatedBy) WHERE installation=?').run(paymentMethod, card, expires, email, Date.now(), by, installation);
  }
  // Caller must check `cents` is an amount credit is sold in and that a card is saved to turn it on.
  setTopUp(installation: number, cents: number | null, by: number): void {
    this.root.db.prepare('UPDATE billing SET topUpCents=?, topUpFailed=NULL, updated=?, updatedBy=? WHERE installation=?').run(cents, Date.now(), by, installation);
    process.stderr.write(`atmin review: auto top-up for installation ${installation} ${cents === null ? 'turned off' : `set to ${cents} cents`} by GitHub user ${by}\n`);
  }
  // Stripe's test and live modes share nothing: a customer, card or payment made with a key of
  // one mode does not exist for a key of the other. When the key's mode changes, the old mode's
  // customers, with their saved cards and auto top-up, are forgotten and its open payments are
  // closed as expired, so each organization starts again on the Billing page. Credit already in
  // the ledger stays; an operator takes test credit away in /admin. A server that billed before
  // the mode was recorded had only ever used a test key.
  stripeMode(mode: 'test' | 'live'): void {
    this.root.transaction(() => {
      const previous = String(this.root.db.prepare('SELECT mode FROM stripe').get()?.mode ?? 'test');
      if (previous !== mode) {
        const customers = this.root.db.prepare('DELETE FROM billing').run().changes;
        const payments = this.root.db.prepare("UPDATE payments SET state='expired' WHERE state='open'").run().changes;
        process.stderr.write(`atmin review: Stripe key changed from ${previous} to ${mode} mode; forgot ${customers} Stripe customers with their saved cards and auto top-up, and closed ${payments} open payments as expired. Credit balances are unchanged.\n`);
      }
      this.root.db.prepare('INSERT INTO stripe VALUES(1,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode').run(mode);
    });
  }
  failTopUp(installation: number, reason: string): void { this.root.db.prepare('UPDATE billing SET topUpFailed=? WHERE installation=?').run(reason, installation); }
  // Installations whose auto top-up is on, has a card to charge and has not failed.
  toppedUp(): number[] {
    return this.root.db.prepare('SELECT installation FROM billing WHERE topUpCents IS NOT NULL AND topUpFailed IS NULL AND paymentMethod IS NOT NULL').all().map(row => Number(row.installation));
  }
  // The Billing page, where an admin buys credit; undefined when credit cannot be bought.
  billingUrl(installation: number): string | undefined { return this.origin && `${this.origin}/billing?installation=${installation}`; }

  balance(installation: number): number {
    return Number(this.root.db.prepare('SELECT COALESCE(SUM(micros), 0) AS n FROM credit WHERE installation=?').get(installation)!.n) / 1e6;
  }
  // Adds one ledger row; false when its reference is already there, so a retried step changes nothing.
  addCredit(installation: number, reference: string, kind: CreditKind, micros: number, by: number | null, note: string | null, receipt: string | null): boolean {
    if (!Number.isSafeInteger(micros)) throw new Error('Invalid credit amount');
    return this.root.db.prepare('INSERT INTO credit VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(reference) DO NOTHING').run(reference, installation, kind, micros, Date.now(), by, note, receipt).changes > 0;
  }
  credited(reference: string): boolean { return Boolean(this.root.db.prepare('SELECT 1 FROM credit WHERE reference=?').get(reference)); }
  // Purchases, top-ups and grants, newest first; reviews are on the Usage page.
  creditHistory(installation: number, limit = 24): CreditRecord[] {
    return this.root.db.prepare("SELECT * FROM credit WHERE installation=? AND kind!='review' ORDER BY created DESC, rowid DESC LIMIT ?").all(installation, limit).map(row => ({ reference: String(row.reference),
      kind: String(row.kind) as CreditKind, usd: Number(row.micros) / 1e6, created: Number(row.created), by: row.by === null ? null : Number(row.by), note: row.note === null ? null : String(row.note), receipt: row.receipt === null ? null : String(row.receipt) }));
  }
  // Caller must verify that `by` is an operator. A negative amount takes credit away.
  grant(installation: number, usd: unknown, note: unknown, by: number): number {
    if (!Number.isSafeInteger(installation) || installation < 1 || typeof usd !== 'number' || !Number.isFinite(usd) || usd === 0 || Math.abs(usd) > 1000
      || typeof note !== 'string' || !note.trim() || note.trim().length > 200) throw new Error('Invalid grant');
    const micros = Math.round(usd * 1e6);
    this.addCredit(installation, `grant-${randomUUID()}`, 'grant', micros, by, note.trim(), null);
    process.stderr.write(`atmin review: ${micros / 1e6} USD of credit ${usd > 0 ? 'added to' : 'taken from'} installation ${installation} by GitHub user ${by}\n`);
    return this.balance(installation);
  }

  startPayment(reference: string, installation: number, kind: PaymentRecord['kind'], cents: number, by: number | null): void {
    this.root.db.prepare("INSERT INTO payments(reference,installation,kind,cents,state,created,by) VALUES(?,?,?,?,'open',?,?)").run(reference, installation, kind, cents, Date.now(), by);
  }
  setPaymentIntent(reference: string, intent: string): void { this.root.db.prepare('UPDATE payments SET intent=? WHERE reference=?').run(intent, reference); }
  finishPayment(reference: string, state: Exclude<PaymentState, 'open'>): void { this.root.db.prepare('UPDATE payments SET state=? WHERE reference=?').run(state, reference); }
  payment(reference: string): PaymentRecord | null { return this.payments('reference=?', reference)[0] ?? null; }
  openPayments(): PaymentRecord[] { return this.payments("state='open'"); }
  topUpCount(installation: number): number { return Number(this.root.db.prepare("SELECT count(*) AS n FROM payments WHERE installation=? AND kind='top-up'").get(installation)!.n); }
  private payments(where: string, ...values: (string | number)[]): PaymentRecord[] {
    return this.root.db.prepare(`SELECT * FROM payments WHERE ${where} ORDER BY created`).all(...values).map(row => ({ reference: String(row.reference), installation: Number(row.installation),
      kind: String(row.kind) as PaymentRecord['kind'], cents: Number(row.cents), state: String(row.state) as PaymentState, intent: row.intent === null ? null : String(row.intent),
      created: Number(row.created), by: row.by === null ? null : Number(row.by) }));
  }
  planned(): number[] { return this.root.db.prepare('SELECT installation FROM plans').all().map(row => Number(row.installation)); }
  // Caller must verify that `by` is an operator.
  setPlan(installation: number, value: unknown, by: number): Plan {
    const plan = parsePlan(value);
    if (!Number.isSafeInteger(installation) || installation < 1) throw new Error('Invalid installation');
    this.root.db.prepare('INSERT INTO plans VALUES(?,?,?,?) ON CONFLICT(installation) DO UPDATE SET value=excluded.value, updated=excluded.updated, updatedBy=excluded.updatedBy')
      .run(installation, JSON.stringify(plan), Date.now(), by);
    process.stderr.write(`atmin review: plan for installation ${installation} set to ${JSON.stringify(plan)} by GitHub user ${by}\n`);
    return plan;
  }
  // Jobs that started inference on this service's model key in [start, end) and count toward the
  // plan, oldest first, across the installation's repositories.
  started(installation: number, start: number, end: number): { entry: Repository; job: Job }[] {
    return this.of(installation).flatMap(entry => (entry.store.db.prepare(`SELECT * FROM jobs WHERE started>=? AND started<? AND runner IS NULL AND modelKey IS NULL AND ${COUNTED}`).all(start, end) as unknown as Job[]).map(job => ({ entry, job })))
      .sort((a, b) => a.job.started! - b.job.started!);
  }
  // What the installation's repositories store on the shared disk: run records and each
  // repository's shared copy of its history. Databases are small and not counted.
  stored(installation: number): { runs: number; copies: number } {
    return this.of(installation).reduce((sum, entry) => ({ runs: sum.runs + directoryBytes(join(entry.config.stateDirectory, 'runs')),
      copies: sum.copies + directoryBytes(join(entry.config.stateDirectory, 'source-cache.git')) }), { runs: 0, copies: 0 });
  }
  storageLimitMb(): number { return this.config.maxInstallationDiskMb ?? DEFAULT_MAX_INSTALLATION_DISK_MB; }
  reviewsToday(now = Date.now()): number { return [...this.entries.values()].reduce((n, entry) => n + startedSince(entry.store, now - 86_400_000), 0); }
  // Returns true once inference may start, or the reason it may not, which the PR comment shows.
  reserve(repository: Repository, job: Job, owner: string, limit: number): true | string {
    // Synchronous with reservation; all stores must be leased by this scheduler.
    if ([...this.entries.values()].some(entry => !entry.store.owns(owner))) return 'The review service lost its lease on repository state. No inference was started.';
    const now = Date.now(), installation = repository.config.installationId, { plan } = this.plan(installation);
    const used = this.started(installation, month(now).start, month(now).end).length;
    const refuse = (reason: string, detail: string) => {
      process.stderr.write(`atmin review: review ${job.id} of repository ${repository.config.repositoryId} not started: ${detail}\n`);
      return reason;
    };
    // On the organization's own model key its free reviews and credit do not apply, and its
    // monthly limit, which counts reviews on this service's key, applies only as the switch that
    // turns its reviews off. The limits below, which protect this service, still do.
    const modelKey = this.keys?.provider(installation) ?? null;
    if ((modelKey === null || plan.monthlyReviews === 0) && used >= plan.monthlyReviews) return refuse(monthlyLimitReached(plan, now), `installation ${installation} used ${used} of ${plan.monthlyReviews} monthly reviews`);
    if (modelKey === null && used >= plan.freeReviews) {
      chargeCredit(this, installation, now);
      const credit = this.balance(installation);
      if (credit <= 0) return refuse(creditUsedUp(plan, now, this.billingUrl(installation)), `installation ${installation} used ${used} reviews, ${plan.freeReviews} free, with ${credit} USD of credit`);
    }
    const today = this.reviewsToday(now);
    if (today >= this.config.maxReviewsPerDay) return refuse(dailyLimitReached, `service used ${today} of ${this.config.maxReviewsPerDay} daily reviews`);
    // Checked before each review, so one review can take an organization past its limit. Shared
    // copies go first: the next review fetches its own again. Reviews run one at a time, so no
    // other review is reading a copy while it is wiped.
    const limitMb = this.storageLimitMb();
    let stored = this.stored(installation);
    if (stored.runs + stored.copies > limitMb * 1024 ** 2) {
      for (const entry of this.of(installation)) rmSync(join(entry.config.stateDirectory, 'source-cache.git'), { recursive: true, force: true });
      process.stderr.write(`atmin review: installation ${installation} stored ${mb(stored.runs + stored.copies)} MB (${mb(stored.copies)} MB in shared copies), over its ${limitMb} MB limit; wiped its shared copies\n`);
      stored = this.stored(installation);
      if (stored.runs + stored.copies > limitMb * 1024 ** 2) return refuse(storageLimitReached(limitMb), `installation ${installation} stores ${mb(stored.runs)} MB of run records, over its ${limitMb} MB limit`);
    }
    return repository.store.reserve(job, owner, limit, modelKey) || refuse(dailyLimitReached, 'repository daily limit reached or job superseded');
  }
  close(): void {
    for (const [id, entry] of this.entries) if (entry.store !== this.root) {
      entry.store.release(this.owner); entry.store.close(); this.entries.delete(id);
    }
  }
}
