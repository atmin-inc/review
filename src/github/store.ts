import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type JobState = 'queued' | 'running' | 'publishing' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'uncertain';
export interface Job { id: string; pr: number; state: JobState; created: number; started: number | null; artifact: string | null; report: string | null; error: string | null; createStarted: number; }
// One service owns the worker lease. Local CLI controls share the WAL database.
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, 'pilot.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, owner TEXT, lease INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO control(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, received INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, pr INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER, artifact TEXT, report TEXT, error TEXT, createStarted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pulls (pr INTEGER PRIMARY KEY, desired TEXT NOT NULL, comment INTEGER, baseRef TEXT, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, created);`);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enabled(): boolean { return Boolean(this.db.prepare('SELECT enabled FROM control').get()!.enabled); }
  enable(value: boolean): void {
    this.transaction(() => {
      this.db.prepare('UPDATE control SET enabled=?').run(Number(value));
      if (!value) this.db.prepare("UPDATE jobs SET state='cancelled', error='operator-paused' WHERE state IN ('queued','running','publishing')").run();
    });
  }
  seen(delivery: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM deliveries WHERE id=?').get(delivery)); }
  enqueue(delivery: string, pr: number): string | null {
    return this.transaction(() => {
      if (this.seen(delivery)) return null;
      this.db.prepare('INSERT INTO deliveries VALUES(?,?)').run(delivery, Date.now());
      if (!this.enabled()) return null;
      const id = randomUUID();
      this.db.prepare("UPDATE jobs SET state='cancelled', error='superseded' WHERE pr=? AND state IN ('queued','running','publishing')").run(pr);
      this.db.prepare("INSERT INTO jobs(id,pr,state,created) VALUES(?,?,'queued',?)").run(id, pr, Date.now());
      this.db.prepare('INSERT INTO pulls(pr,desired) VALUES(?,?) ON CONFLICT(pr) DO UPDATE SET desired=excluded.desired').run(pr, id);
      return id;
    });
  }
  acquire(owner: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const control = this.db.prepare('SELECT owner,lease FROM control').get()!;
      if (control.owner !== owner && Number(control.lease) > now) return false;
      // Never restart interrupted inference automatically: its reservation may have been consumed.
      if (control.owner !== owner) this.db.prepare("UPDATE jobs SET state=CASE WHEN report IS NULL THEN 'failed' ELSE 'publishing' END, error='worker-interrupted; explicit rerun required' WHERE state='running'").run();
      this.db.prepare('UPDATE control SET owner=?,lease=?').run(owner, now + 30_000);
      return true;
    });
  }
  renew(owner: string): boolean {
    return this.db.prepare('UPDATE control SET lease=? WHERE owner=? AND lease>?').run(Date.now() + 30_000, owner, Date.now()).changes === 1;
  }
  release(owner: string): void { this.db.prepare('UPDATE control SET owner=NULL,lease=0 WHERE owner=?').run(owner); }
  owns(owner: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM control WHERE owner=? AND lease>?').get(owner, Date.now())); }
  current(job: Job, owner: string): boolean {
    return this.enabled() && this.owns(owner) && Boolean(this.db.prepare("SELECT 1 FROM pulls JOIN jobs ON pulls.desired=jobs.id WHERE jobs.id=? AND jobs.state IN ('running','publishing')").get(job.id));
  }
  next(owner: string): Job | null {
    return this.transaction(() => {
      if (!this.enabled() || !this.owns(owner)) return null;
      const resume = this.db.prepare("SELECT * FROM jobs WHERE state='publishing' ORDER BY created LIMIT 1").get() as unknown as Job | undefined;
      if (resume) return resume;
      const job = this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").get() as unknown as Job | undefined;
      if (!job) return null;
      this.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id);
      return this.get(job.id);
    });
  }
  reserve(job: Job, owner: string, limit: number): boolean {
    return this.transaction(() => {
      if (!this.current(job, owner)) return false;
      const count = Number(this.db.prepare('SELECT count(*) AS n FROM jobs WHERE started>?').get(Date.now() - 86_400_000)!.n);
      if (count >= limit) return false;
      this.db.prepare('UPDATE jobs SET started=? WHERE id=?').run(Date.now(), job.id);
      return true;
    });
  }
  get(id: string): Job { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job; }
  update(id: string, values: Partial<Pick<Job, 'state' | 'artifact' | 'report' | 'error' | 'createStarted'>>): void {
    const entries = Object.entries(values);
    if (!entries.length) return;
    const allowed = ['state', 'artifact', 'report', 'error', 'createStarted'];
    if (entries.some(([key]) => !allowed.includes(key))) throw new Error('Invalid job field');
    this.db.prepare(`UPDATE jobs SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, v]) => v!), id);
  }
  comment(pr: number): number | null { return this.db.prepare('SELECT comment FROM pulls WHERE pr=?').get(pr)?.comment as number | null ?? null; }
  track(pr: number, baseRef: string, active: boolean): void { this.db.prepare('UPDATE pulls SET baseRef=?,active=? WHERE pr=?').run(baseRef, Number(active), pr); }
  branchPulls(baseRef: string): number[] { return this.db.prepare('SELECT pr FROM pulls WHERE baseRef=? AND active=1').all(baseRef).map(row => Number(row.pr)); }
  setComment(pr: number, id: number): void { this.db.prepare('UPDATE pulls SET comment=? WHERE pr=?').run(id, pr); }
  uncertainCreate(pr: number): boolean { return Boolean(this.db.prepare('SELECT 1 FROM jobs WHERE pr=? AND createStarted=1').get(pr)); }
  creationConfirmed(pr: number, comment: number): void {
    this.transaction(() => {
      this.setComment(pr, comment);
      this.db.prepare('UPDATE jobs SET createStarted=0 WHERE pr=?').run(pr);
    });
  }
  retryPublication(pr: number): boolean {
    const job = this.db.prepare("SELECT jobs.* FROM jobs JOIN pulls ON jobs.id=pulls.desired WHERE jobs.pr=? AND jobs.report IS NOT NULL AND jobs.state IN ('uncertain','failed','completed')").get(pr) as unknown as Job | undefined;
    if (!job) return false;
    this.update(job.id, { state: 'publishing', error: null });
    return true;
  }
  status(): unknown {
    return { enabled: this.enabled(), jobs: this.db.prepare('SELECT id,pr,state,created,started,error,artifact FROM jobs ORDER BY created DESC LIMIT 30').all() };
  }
}
