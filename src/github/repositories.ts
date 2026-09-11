import { join } from 'node:path';
import type { PilotConfig } from './config.js';
import { Store, type Job } from './store.js';
import { ReviewSettings, type ModelChoice } from './settings.js';

export interface Repository { config: PilotConfig; store: Store; settings: ReviewSettings; }

// ponytail: one approved installation, at most ten repositories, one scheduler.
// Separate stores reuse the worker's existing isolation boundary without tenant SQL.
export class Repositories {
  readonly entries = new Map<number, Repository>();
  constructor(readonly config: PilotConfig, readonly root: Store, private models: ModelChoice[], private owner: string) {
    root.db.exec('CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, installation INTEGER NOT NULL)');
    const rows = root.db.prepare('SELECT * FROM repositories').all();
    if (rows.length > 9 || rows.some(row => row.installation !== config.installationId || row.id === config.repositoryId)) throw new Error('Repository directory does not match installation');
    this.entries.set(config.repositoryId, { config, store: root, settings: new ReviewSettings(config, root, models) });
    for (const row of rows) this.open(Number(row.id), String(row.name));
  }
  private open(id: number, name: string): Repository {
    if (!Number.isSafeInteger(id) || id < 1 || !/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error('Invalid repository identity');
    const config = { ...this.config, repositoryId: id, repository: name, trustedChecks: [],
      stateDirectory: join(this.config.stateDirectory, 'repositories', String(this.config.installationId), String(id)) };
    const store = new Store(config.stateDirectory);
    if (!store.acquire(this.owner)) { store.close(); throw new Error('Repository already has a worker'); }
    const repository = { config, store, settings: new ReviewSettings(config, store, this.models) };
    this.entries.set(id, repository);
    return repository;
  }
  // Caller must verify both current admin permission and installation membership.
  connect(id: number, name: string): Repository {
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.config.repository !== name) throw new Error('Repository name changed; operator reconciliation required');
      return existing;
    }
    if (this.entries.size >= 10) throw new Error('Private pilot repository limit reached');
    const repository = this.open(id, name);
    try { this.root.db.prepare('INSERT INTO repositories VALUES(?,?,?)').run(id, name, this.config.installationId); }
    catch (error) { repository.store.close(); this.entries.delete(id); throw error; }
    return repository;
  }
  reserve(repository: Repository, job: Job, owner: string, limit: number): boolean {
    // Synchronous with reservation; all stores must be leased by this scheduler.
    let used = 0;
    for (const entry of this.entries.values()) {
      if (!entry.store.owns(owner)) return false;
      used += Number(entry.store.db.prepare('SELECT count(*) AS n FROM jobs WHERE started>?').get(Date.now() - 86_400_000)!.n);
    }
    return used < this.config.maxReviewsPerDay && repository.store.reserve(job, owner, limit);
  }
  close(): void {
    for (const [id, entry] of this.entries) if (entry.store !== this.root) {
      entry.store.release(this.owner); entry.store.close(); this.entries.delete(id);
    }
  }
}
