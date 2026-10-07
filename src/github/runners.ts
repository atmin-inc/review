import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Self-run: a PR author's own machine reviews their PR with the CLI they signed in to
// (`atmin-code-review-runner`), and this service publishes the result. The runner only ever
// calls out; it is offered jobs whose PR its GitHub user authored, and nothing else.
export type Cli = 'claude' | 'codex';
export interface RunnerRow { id: string; user: number; login: string; cli: string | null; model: string | null; version: string | null; seen: number; }
// `modelKey` is the organization's own model key, on an offer to this service's runners only.
export interface Offer { job: string; repository: string; pr: number; token: string; previous: unknown; profile?: unknown; checks?: unknown; modelKey?: string }
// What a dispatched job ended as. Anything but 'done' falls back to a hosted review.
export type Outcome = 'done' | 'unclaimed' | 'silent' | 'failed' | 'cancelled';

// A runner counts as online while it polled within this window; it polls every few seconds.
export const ONLINE_MS = 120_000;
// A runner that has not picked an offered job up by then is treated as gone.
export const CLAIM_MS = 60_000;
// A claimed job whose runner stops sending heartbeats for this long is taken back.
export const SILENT_MS = 120_000;
// A pool job waits this long for one of this service's runners to be free.
export const POOL_WAIT_MS = 30 * 60_000;
// The user id of this service's own runners, which take any job offered to the pool.
export const POOL = 0;
// A user's runner sends the two records publication reads; this service's own runners send
// every record of the run, which billing (receipt.json) and the dashboard read.
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 2;
export const MAX_POOL_UPLOAD_BYTES = 64 * 1024 ** 2;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const runnerLabel = (row: Pick<RunnerRow, 'login' | 'cli' | 'model'>) =>
  `@${row.login}'s runner (${row.cli === 'codex' ? 'Codex' : 'Claude Code'}${row.model ? ` / ${row.model}` : ''})`;

export class Runners {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, user INTEGER NOT NULL, login TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE,
        cli TEXT, model TEXT, version TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runner_jobs (job TEXT PRIMARY KEY, user INTEGER NOT NULL, repositoryId INTEGER NOT NULL, directory TEXT NOT NULL, offer TEXT NOT NULL,
        state TEXT NOT NULL, runner TEXT, offered INTEGER NOT NULL, heartbeat INTEGER, error TEXT, deadline INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS runner_jobs_user ON runner_jobs(user, state, offered);`);
    // Tables created before the worker stopped waiting on runners have no deadline column.
    if (!db.prepare('PRAGMA table_info(runner_jobs)').all().some(column => column.name === 'deadline')) db.exec('ALTER TABLE runner_jobs ADD COLUMN deadline INTEGER NOT NULL DEFAULT 0');
    // An offer carries a GitHub token, and may carry an organization's own model key, both needed
    // only until a runner claims it. Older releases kept them.
    db.exec(`UPDATE runner_jobs SET offer=json_remove(offer,'$.token','$.modelKey') WHERE state<>'offered'`);
  }
  // The runner's own token, shown once. Only its hash is kept. Signing in again adds a runner;
  // the newest one seen is the one offered work.
  register(user: number, login: string, now = Date.now()): string {
    const token = `atr_${randomBytes(32).toString('base64url')}`;
    this.db.prepare('INSERT INTO runners(id,user,login,tokenHash,created) VALUES(?,?,?,?,?)').run(randomUUID(), user, login, hash(token), now);
    return token;
  }
  authenticate(token: string): RunnerRow | null {
    if (!/^atr_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return (this.db.prepare('SELECT id,user,login,cli,model,version,seen FROM runners WHERE tokenHash=? AND revoked=0').get(hash(token)) as unknown as RunnerRow | undefined) ?? null;
  }
  // One of this service's own runners, which share one secret (ATMIN_RUNNER_POOL_TOKEN) and
  // name themselves. They take pool jobs only.
  static hosted(token: string, expected: string | undefined, name: string): RunnerRow | null {
    if (!expected || Buffer.byteLength(expected) < 32 || !/^[a-z0-9-]{1,40}$/.test(name)) return null;
    if (!timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(expected).digest())) return null;
    return { id: `pool:${name}`, user: POOL, login: 'atmin', cli: null, model: null, version: null, seen: Date.now() };
  }
  seen(runner: string, cli: Cli, model: string, version: string, now = Date.now()): void {
    this.db.prepare('UPDATE runners SET cli=?,model=?,version=?,seen=? WHERE id=?').run(cli, model, version, now, runner);
  }
  online(user: number, now = Date.now()): RunnerRow | null {
    return (this.db.prepare('SELECT id,user,login,cli,model,version,seen FROM runners WHERE user=? AND revoked=0 AND seen>? AND cli IS NOT NULL ORDER BY seen DESC LIMIT 1')
      .get(user, now - ONLINE_MS) as unknown as RunnerRow | undefined) ?? null;
  }
  list(user: number): RunnerRow[] {
    return this.db.prepare('SELECT id,user,login,cli,model,version,seen FROM runners WHERE user=? AND revoked=0 ORDER BY seen DESC').all(user) as unknown as RunnerRow[];
  }
  revoke(user: number, id: string): boolean { return this.db.prepare('UPDATE runners SET revoked=1 WHERE id=? AND user=?').run(id, user).changes === 1; }

  // Offers a job to one user's own runner, or to POOL: this service's hosted runners. Offering
  // again (the author's runner did not deliver) replaces the earlier offer.
  offer(job: string, user: number, repositoryId: number, directory: string, offer: Offer, deadlineMs: number, now = Date.now()): void {
    this.db.prepare(`INSERT INTO runner_jobs(job,user,repositoryId,directory,offer,state,offered,heartbeat,runner,error,deadline) VALUES(?,?,?,?,?,'offered',?,NULL,NULL,NULL,?)
      ON CONFLICT(job) DO UPDATE SET user=excluded.user,offer=excluded.offer,state='offered',offered=excluded.offered,heartbeat=NULL,runner=NULL,error=NULL,deadline=excluded.deadline`)
      .run(job, user, repositoryId, directory, JSON.stringify(offer), now, now + deadlineMs);
  }
  // The oldest job offered to this runner: its user's, or the pool's for a hosted runner.
  claim(runner: RunnerRow, now = Date.now()): Offer | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT job,offer FROM runner_jobs WHERE user=? AND state='offered' ORDER BY offered LIMIT 1").get(runner.user);
      // The deadline was stored as offer time plus the allowed run time; the clock starts now.
      if (row) this.db.prepare("UPDATE runner_jobs SET state='claimed',offer=json_remove(offer,'$.token','$.modelKey'),runner=?,heartbeat=?,deadline=deadline-offered+? WHERE job=?").run(runner.id, now, now, row.job as string);
      this.db.exec('COMMIT');
      return row ? JSON.parse(String(row.offer)) as Offer : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Only the runner that claimed a job may report on it, and only while it is still claimed.
  claimed(runner: RunnerRow, job: string): { directory: string; user: number } | null {
    return (this.db.prepare("SELECT directory,user FROM runner_jobs WHERE job=? AND runner=? AND state='claimed'").get(job, runner.id) as unknown as { directory: string; user: number } | undefined) ?? null;
  }
  heartbeat(runner: RunnerRow, job: string, now = Date.now()): boolean {
    return this.db.prepare("UPDATE runner_jobs SET heartbeat=? WHERE job=? AND runner=? AND state='claimed'").run(now, job, runner.id).changes === 1;
  }
  finish(runner: RunnerRow, job: string, state: 'done' | 'failed', error: string | null = null): boolean {
    return this.db.prepare("UPDATE runner_jobs SET state=?,error=? WHERE job=? AND runner=? AND state='claimed'").run(state, error, job, runner.id).changes === 1;
  }
  // Jobs of one repository the worker has not closed.
  open(repositoryId: number): string[] {
    return (this.db.prepare("SELECT job FROM runner_jobs WHERE repositoryId=? AND state<>'closed'").all(repositoryId) as unknown as { job: string }[]).map(row => row.job);
  }
  // The worker is done with a job: it collected it, or the review was superseded, paused or
  // failed. A runner still holding it has its next report refused.
  close(job: string): void { this.db.prepare("UPDATE runner_jobs SET state='closed',offer=json_remove(offer,'$.token','$.modelKey') WHERE job=?").run(job); }
  private end(job: string, state: Outcome): void {
    this.db.prepare("UPDATE runner_jobs SET state=?,offer=json_remove(offer,'$.token','$.modelKey') WHERE job=? AND state IN ('offered','claimed')").run(state, job);
  }
  // How a dispatched job ended, or null while a runner may still deliver. The worker checks on
  // each tick and never waits. A user's own runner must claim within CLAIM_MS; the pool's
  // runners may all be busy, so a pool job waits up to POOL_WAIT_MS for a free one.
  poll(job: string, now = Date.now()): Outcome | null {
    const row = this.db.prepare('SELECT state,user,offered,heartbeat,deadline FROM runner_jobs WHERE job=?').get(job);
    if (!row) return 'failed';
    const state = String(row.state);
    if (state === 'closed') return 'cancelled';
    if (state !== 'offered' && state !== 'claimed') return state as Outcome;
    const ended = state === 'offered' && now - Number(row.offered) > (Number(row.user) === POOL ? POOL_WAIT_MS : CLAIM_MS) ? 'unclaimed'
      : state === 'claimed' && (now - Number(row.heartbeat) > SILENT_MS || now > Number(row.deadline)) ? 'silent' : null;
    if (ended) this.end(job, ended);
    return ended;
  }
  outcome(job: string): { state: string; error: string | null } | null {
    return (this.db.prepare('SELECT state,error FROM runner_jobs WHERE job=?').get(job) as unknown as { state: string; error: string | null } | undefined) ?? null;
  }
}
