import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Self-run: a PR author's own machine reviews their PR with the CLI they signed in to
// (`atmin-code-review-runner`), and this service publishes the result. The runner only ever
// calls out; it is offered jobs whose PR its GitHub user authored, and nothing else.
export type Cli = 'claude' | 'codex';
export interface RunnerRow { id: string; user: number; login: string; cli: string | null; model: string | null; version: string | null; seen: number; }
export interface Offer { job: string; repository: string; pr: number; token: string; previous: unknown }
// What a dispatched job ended as. Anything but 'done' falls back to a hosted review.
export type Outcome = 'done' | 'unclaimed' | 'silent' | 'failed' | 'cancelled';

// A runner counts as online while it polled within this window; it polls every few seconds.
export const ONLINE_MS = 120_000;
// A runner that has not picked an offered job up by then is treated as gone.
export const CLAIM_MS = 60_000;
// A claimed job whose runner stops sending heartbeats for this long is taken back.
export const SILENT_MS = 120_000;
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 2;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const runnerLabel = (row: Pick<RunnerRow, 'login' | 'cli' | 'model'>) =>
  `@${row.login}'s runner (${row.cli === 'codex' ? 'Codex' : 'Claude Code'}${row.model ? ` / ${row.model}` : ''})`;

export class Runners {
  constructor(private db: DatabaseSync, private sleep = (ms: number) => new Promise(done => setTimeout(done, ms))) {
    db.exec(`CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, user INTEGER NOT NULL, login TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE,
        cli TEXT, model TEXT, version TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runner_jobs (job TEXT PRIMARY KEY, user INTEGER NOT NULL, repositoryId INTEGER NOT NULL, directory TEXT NOT NULL, offer TEXT NOT NULL,
        state TEXT NOT NULL, runner TEXT, offered INTEGER NOT NULL, heartbeat INTEGER, error TEXT);
      CREATE INDEX IF NOT EXISTS runner_jobs_user ON runner_jobs(user, state, offered);`);
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

  offer(job: string, user: number, repositoryId: number, directory: string, offer: Offer, now = Date.now()): void {
    this.db.prepare("INSERT INTO runner_jobs(job,user,repositoryId,directory,offer,state,offered) VALUES(?,?,?,?,?,'offered',?)")
      .run(job, user, repositoryId, directory, JSON.stringify(offer), now);
  }
  // The oldest job offered to this runner's user, now claimed by this runner.
  claim(runner: RunnerRow, now = Date.now()): Offer | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT job,offer FROM runner_jobs WHERE user=? AND state='offered' ORDER BY offered LIMIT 1").get(runner.user);
      if (row) this.db.prepare("UPDATE runner_jobs SET state='claimed',runner=?,heartbeat=? WHERE job=?").run(runner.id, now, row.job as string);
      this.db.exec('COMMIT');
      return row ? JSON.parse(String(row.offer)) as Offer : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Only the runner that claimed a job may report on it, and only while it is still claimed.
  claimed(runner: RunnerRow, job: string): { directory: string } | null {
    return (this.db.prepare("SELECT directory FROM runner_jobs WHERE job=? AND runner=? AND state='claimed'").get(job, runner.id) as unknown as { directory: string } | undefined) ?? null;
  }
  heartbeat(runner: RunnerRow, job: string, now = Date.now()): boolean {
    return this.db.prepare("UPDATE runner_jobs SET heartbeat=? WHERE job=? AND runner=? AND state='claimed'").run(now, job, runner.id).changes === 1;
  }
  finish(runner: RunnerRow, job: string, state: 'done' | 'failed', error: string | null = null): boolean {
    return this.db.prepare("UPDATE runner_jobs SET state=?,error=? WHERE job=? AND runner=? AND state='claimed'").run(state, error, job, runner.id).changes === 1;
  }
  private end(job: string, state: Outcome): void {
    this.db.prepare("UPDATE runner_jobs SET state=? WHERE job=? AND state IN ('offered','claimed')").run(state, job);
  }
  // Waits for the runner's upload. Never throws for the runner's sake: every way it can go
  // wrong is an outcome, and the worker reviews on this service instead.
  async wait(job: string, signal: AbortSignal, deadline: number, now = () => Date.now()): Promise<Outcome> {
    for (;;) {
      const row = this.db.prepare('SELECT state,offered,heartbeat FROM runner_jobs WHERE job=?').get(job);
      if (!row) return 'failed';
      const state = String(row.state), t = now();
      if (state === 'done' || state === 'failed') return state;
      if (signal.aborted) { this.end(job, 'cancelled'); return 'cancelled'; }
      if (state === 'offered' && t - Number(row.offered) > CLAIM_MS) { this.end(job, 'unclaimed'); return 'unclaimed'; }
      if (state === 'claimed' && (t - Number(row.heartbeat) > SILENT_MS || t > deadline)) { this.end(job, 'silent'); return 'silent'; }
      await this.sleep(1000);
    }
  }
  outcome(job: string): { state: string; error: string | null } | null {
    return (this.db.prepare('SELECT state,error FROM runner_jobs WHERE job=?').get(job) as unknown as { state: string; error: string | null } | undefined) ?? null;
  }
}
