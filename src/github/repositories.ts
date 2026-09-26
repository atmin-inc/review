import { join } from 'node:path';
import type { PilotConfig } from './config.js';
import { Store, type Job } from './store.js';
import { ReviewSettings, type ModelChoice } from './settings.js';

export interface Repository { config: PilotConfig; store: Store; settings: ReviewSettings; }
// A plan caps an installation's reviews per UTC month and prices the ones beyond its free
// allowance. Until billing exists, the cap equals the free allowance and an operator raises it.
export interface Plan { freeReviews: number; monthlyReviews: number; multiplier: number; minimumUsd: number; }
export const defaultPlan: Plan = { freeReviews: 20, monthlyReviews: 20, multiplier: 2, minimumUsd: 0.05 };
export const perInstallation = 10, maxRepositories = 200;
export const dailyLimitReached = 'The operator’s rolling 24-hour review limit was reached. A maintainer can rerun after capacity is available. No inference was started.';

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
function monthlyLimitReached(plan: Plan, now: number): string {
  const { start, end } = month(now);
  if (!plan.monthlyReviews) return 'Reviews are turned off for this organization. An atmin operator can turn them back on. No inference was started.';
  const name = new Date(start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `This organization reached its limit of ${plan.monthlyReviews} reviews for ${name}. Reviews resume on ${new Date(end).toISOString().slice(0, 10)}, or sooner if an atmin operator raises the limit. No inference was started.`;
}
const startedSince = (store: Store, since: number) => Number(store.db.prepare('SELECT count(*) AS n FROM jobs WHERE started>=?').get(since)!.n);

// ponytail: any installation connects up to ten repositories itself; one scheduler serves them all.
// Separate stores reuse the worker's existing isolation boundary without tenant SQL.
export class Repositories {
  readonly entries = new Map<number, Repository>();
  constructor(readonly config: PilotConfig, readonly root: Store, private models: ModelChoice[], private owner: string) {
    root.db.exec(`CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, installation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (installation INTEGER PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, updatedBy INTEGER NOT NULL);`);
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
  // Reviews that started inference since `since`, oldest first, across the installation's repositories.
  started(installation: number, since: number): { entry: Repository; job: Job }[] {
    return this.of(installation).flatMap(entry => (entry.store.db.prepare('SELECT * FROM jobs WHERE started>=?').all(since) as unknown as Job[]).map(job => ({ entry, job })))
      .sort((a, b) => a.job.started! - b.job.started!);
  }
  reviewsToday(now = Date.now()): number { return [...this.entries.values()].reduce((n, entry) => n + startedSince(entry.store, now - 86_400_000), 0); }
  // Returns true once inference may start, or the reason it may not, which the PR comment shows.
  reserve(repository: Repository, job: Job, owner: string, limit: number): true | string {
    // Synchronous with reservation; all stores must be leased by this scheduler.
    if ([...this.entries.values()].some(entry => !entry.store.owns(owner))) return 'The review service lost its lease on repository state. No inference was started.';
    const now = Date.now(), installation = repository.config.installationId, { plan } = this.plan(installation);
    const used = this.of(installation).reduce((n, entry) => n + startedSince(entry.store, month(now).start), 0);
    const refuse = (reason: string, detail: string) => {
      process.stderr.write(`atmin review: review ${job.id} of repository ${repository.config.repositoryId} not started: ${detail}\n`);
      return reason;
    };
    if (used >= plan.monthlyReviews) return refuse(monthlyLimitReached(plan, now), `installation ${installation} used ${used} of ${plan.monthlyReviews} monthly reviews`);
    const today = this.reviewsToday(now);
    if (today >= this.config.maxReviewsPerDay) return refuse(dailyLimitReached, `service used ${today} of ${this.config.maxReviewsPerDay} daily reviews`);
    return repository.store.reserve(job, owner, limit) || refuse(dailyLimitReached, 'repository daily limit reached or job superseded');
  }
  close(): void {
    for (const [id, entry] of this.entries) if (entry.store !== this.root) {
      entry.store.release(this.owner); entry.store.close(); this.entries.delete(id);
    }
  }
}
