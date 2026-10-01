import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePacket } from '../contracts.js';
import { readProfile } from '../run.js';
import { previousReview } from '../claim-result.js';
import type { SelfRun } from './worker.js';
import type { Runners } from './runners.js';
import type { PilotConfig } from './config.js';
import type { GitHub } from './api.js';
import type { ReviewSettings } from './settings.js';
import type { Job, Store } from './store.js';

// Storage limits, because strangers' repositories share this disk. Each connected repository
// already has its own directory, database and shared copy (see Repositories).
export const DEFAULT_MIN_FREE_DISK_MB = 2048;
export const RUN_RETENTION_DAYS = 90;
// A shared copy only grows (garbage collection is off; see sourceCache in src/snapshot.ts).
// Past this size the next review wipes it and fetches afresh; Lors, 2026-09-26: a wipe only
// slows the next review. Connected repositories are at most 2 GB on GitHub.
export const MAX_SOURCE_CACHE_BYTES = 3 * 1024 ** 3;
// What one organization's run records and shared copies may hold together. mason-v1's copy is
// about 175 MB and a finished run record a few hundred KB, since its snapshot is deleted.
export const DEFAULT_MAX_INSTALLATION_DISK_MB = 5120;

export function freeDiskMb(directory: string): number {
  const stats = statfsSync(directory);
  return Math.floor(stats.bavail * stats.bsize / 1024 ** 2);
}
export function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  return total;
}
// The worker runs one review at a time, so nothing else reads the copy while it is wiped.
export function trimSourceCache(cache: string, limit = MAX_SOURCE_CACHE_BYTES): boolean {
  const size = directoryBytes(cache);
  if (size <= limit) return false;
  rmSync(cache, { recursive: true, force: true });
  process.stderr.write(`atmin review: shared copy ${cache} held ${Math.round(size / 1024 ** 2)} MB, over the ${Math.round(limit / 1024 ** 2)} MB limit; wiped\n`);
  return true;
}
// Deletes run records older than RUN_RETENTION_DAYS (see Store.expireRuns). The review's
// row, with the comment it published, stays in the database.
export function expireRuns(config: PilotConfig, store: Store, now = Date.now()): number {
  const runs = join(config.stateDirectory, 'runs') + sep;
  const expired = store.expireRuns(now - RUN_RETENTION_DAYS * 86_400_000);
  for (const directory of expired) if (directory.startsWith(runs)) rmSync(directory, { recursive: true, force: true });
  if (expired.length) process.stderr.write(`atmin review: deleted ${expired.length} run records older than ${RUN_RETENTION_DAYS} days in repository ${config.repositoryId}\n`);
  return expired.length;
}

// `previous` is the artifact of an earlier completed review of the same PR, when the
// worker has one to build on; the claim run decides whether it can be used.
export type Runner = (job: Job, signal: AbortSignal, previous?: string | null) => Promise<string>;
export function childEnvironment(home: string, credentials: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home, GH_CONFIG_DIR: join(home, 'gh'), LANG: 'C.UTF-8', ...credentials };
}
export function child(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const proc = spawn(process.execPath, [fileURLToPath(new URL('./task.js', import.meta.url)), ...args], {
      env, cwd: env.HOME!, stdio: 'ignore', detached: process.platform !== 'win32',
    });
    let killTimer: NodeJS.Timeout | undefined;
    let stopped = false;
    const kill = (kind: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, kind); else proc.kill(kind); } catch { /* Already exited. */ }
    };
    const cancel = () => {
      if (stopped) return;
      stopped = true; kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const deadline = setTimeout(cancel, deadlineMs);
    signal.addEventListener('abort', cancel, { once: true });
    const cleanup = () => { clearTimeout(deadline); clearTimeout(killTimer); signal.removeEventListener('abort', cancel); };
    proc.once('error', () => { cleanup(); reject(new Error('Review child failed to start')); });
    proc.once('exit', code => { cleanup(); if (code === 0 && !stopped) resolve(); else reject(new Error('Review child interrupted or failed')); });
  });
}
export function engineRunner(config: PilotConfig, github: GitHub, settings?: ReviewSettings): Runner {
  const runs = join(config.stateDirectory, 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  return async (job, signal, previous) => {
    const directory = join(runs, job.id);
    const profile = settings?.profile() ?? readProfile(config.profile);
    const home = mkdtempSync(join(config.stateDirectory, 'job-home-'));
    try {
      const token = await github.readToken();
      trimSourceCache(join(config.stateDirectory, 'source-cache.git'));
      await child(['capture', `https://github.com/${config.repository}/pull/${job.pr}`, directory, join(config.stateDirectory, 'source-cache.git')],
        childEnvironment(home, { GH_TOKEN: token }), signal, 130_000);
      const earlier = previous ? previousReview(previous) : null;
      if (earlier) writeFileSync(join(directory, 'previous.json'), JSON.stringify(earlier), { mode: 0o600, flag: 'wx' });
      const profilePath = join(directory, 'profile.json');
      writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
      const keyName = profile.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
      const key = process.env[keyName];
      if (!key) throw new Error('Configured model credential unavailable');
      // Rung 3 (Jev) is part of the configuration that was measured; without its key the
      // claim run still completes and records that the rung was off.
      const jev = process.env.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY } : {};
      await child(['investigate', directory, profilePath], childEnvironment(home, { [keyName]: key, ...jev }), signal, profile.deadlineMs + 30_000);
      const packet = parsePacket(JSON.parse(readFileSync(join(directory, 'packet.json'), 'utf8')));
      const checks = config.localChecks?.filter(check => check.repositoryId === config.repositoryId && packet.policy.requiredChecks.includes(check.name)) ?? [];
      if (checks.length) {
        const checksPath = join(directory, 'local-checks.json');
        writeFileSync(checksPath, JSON.stringify(checks), { mode: 0o600, flag: 'wx' });
        await child(['verify', directory, checksPath], childEnvironment(home, {}), signal, checks.length * 120_000 + 30_000);
      }
      return directory;
    } finally {
      rmSync(home, { recursive: true, force: true });
      // Only the run itself reads its snapshot, which borrows the repository's shared copy.
      // Publication, CI refreshes, push reviews and the dashboard read the JSON records beside it.
      rmSync(join(directory, 'source.git'), { recursive: true, force: true });
    }
  };
}

// How long a runner may take over one review before it is taken back. Hosted reviews stop at
// their profile's deadline; a subscription CLI is slower per call.
export const RUNNER_DEADLINE_MS = 60 * 60_000;
// Offers a job to the PR author's own runner: a read-only token for this one repository, which
// expires within the hour, and the earlier review a push review builds on.
export function selfRun(config: PilotConfig, github: GitHub, settings: ReviewSettings, runners: Runners): SelfRun {
  return {
    runner: (_job, author) => settings.current().selfRun ? runners.online(author) : null,
    async run(job, runner, directory, signal, previous) {
      runners.offer(job.id, runner.user, config.repositoryId, directory, { job: job.id, repository: config.repository, pr: job.pr,
        token: await github.readToken(), previous: previous ? previousReview(previous) : null });
      return runners.wait(job.id, signal, Date.now() + RUNNER_DEADLINE_MS);
    },
  };
}
