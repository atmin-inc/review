import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePacket } from '../contracts.js';
import { readProfile } from '../run.js';
import { parseProfile } from '../investigation.js';
import { tmpdir } from 'node:os';
import { previousReview } from '../claim-result.js';
import type { Dispatcher } from './worker.js';
import { POOL, type Offer, type Runners } from './runners.js';
import { runtimeMounts, type LocalCheck } from '../verification.js';
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
// A repository's copy on a runner is deleted once no review has used it for this long
// (Lors, 2026-10-03), so code sits on disk only while its repository is being worked on. The
// next review fetches it again in full.
export const REPOSITORY_IDLE_MS = 24 * 3_600_000;
// Every entry under a runner's cache directory is one repository's directory; its modified time
// is set when a review starts using it (see poolReview in src/code-review-runner.ts).
export function expireIdleCopies(root: string, now = Date.now(), idleMs = REPOSITORY_IDLE_MS): number {
  if (!existsSync(root)) return 0;
  let deleted = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (now - statSync(path).mtimeMs <= idleMs) continue;
    rmSync(path, { recursive: true, force: true }); deleted++;
  }
  if (deleted) process.stderr.write(`atmin review: deleted ${deleted} repository copies unused for ${idleMs / 3_600_000} hours from ${root}\n`);
  return deleted;
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

export function childEnvironment(home: string, credentials: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home, GH_CONFIG_DIR: join(home, 'gh'), LANG: 'C.UTF-8', ...credentials };
}
// What a review child on atmin's own runners can see: the system's programs, this release's
// code, network (it fetches from GitHub and calls the model), its own run and the one
// repository it reviews. Every runner and review runs as the same user, so without this a
// child broken by a hostile repository could read every other organization's code.
export interface Isolation { writable: string[]; readable: string[] }
const networkFiles = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/gitconfig', '/run/systemd/resolve'];
export function childSandbox(home: string, isolation: Isolation, app = realpathSync(fileURLToPath(new URL('../..', import.meta.url))), runtime = process.execPath): string[] {
  return ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', ...runtimeMounts(runtime),
    ...networkFiles.flatMap(path => ['--ro-bind-try', path, path]),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', app, app,
    ...isolation.readable.flatMap(path => ['--ro-bind', path, path]),
    ...[home, ...isolation.writable].flatMap(path => ['--bind', path, path]), '--chdir', home, '--'];
}
// Without isolation the child runs as this process does: a member's own runner on their own
// machine, which holds only their own code (and Bubblewrap is Linux-only).
export function child(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, deadlineMs: number, isolation?: Isolation): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const command = [process.execPath, fileURLToPath(new URL('./task.js', import.meta.url)), ...args];
    const [file, ...argv] = isolation ? ['bwrap', ...childSandbox(env.HOME!, isolation), ...command] : command;
    const proc = spawn(file!, argv, {
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

// One review on one of this service's own runners, with this service's model key: capture the
// PR with the offer's read-only token, investigate with the offer's profile, and run the local
// checks the PR's policy requires. Source and model credentials never share a process.
// Each child sees only this run and this repository's copy, which lives alone in its own
// directory (`cache`'s parent) so that capture may build and rename it there.
export async function hostedReview(offer: Offer, directory: string, cache: string, signal: AbortSignal, credentials: Record<string, string | undefined> = process.env): Promise<void> {
  const profile = parseProfile(offer.profile);
  const home = mkdtempSync(join(tmpdir(), 'atmin-runner-home-'));
  const run = dirname(directory), repository = dirname(cache);
  const reading: Isolation = { writable: [run], readable: [repository] };
  try {
    trimSourceCache(cache);
    await child(['capture', `https://github.com/${offer.repository}/pull/${offer.pr}`, directory, cache], childEnvironment(home, { GH_TOKEN: offer.token }), signal, 130_000, { writable: [run, repository], readable: [] });
    if (offer.previous) writeFileSync(join(directory, 'previous.json'), JSON.stringify(offer.previous), { mode: 0o600, flag: 'wx' });
    const profilePath = join(directory, 'profile.json');
    writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
    const keyName = profile.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
    const key = credentials[keyName];
    if (!key) throw new Error('Configured model credential unavailable');
    // Rung 3 (Jev) is part of the configuration that was measured; without its key the
    // claim run still completes and records that the rung was off.
    const jev = credentials.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: credentials.TYPESAFE_API_KEY } : {};
    await child(['investigate', directory, profilePath], childEnvironment(home, { [keyName]: key, ...jev }), signal, profile.deadlineMs + 30_000, reading);
    const packet = parsePacket(JSON.parse(readFileSync(join(directory, 'packet.json'), 'utf8')));
    const checks = (Array.isArray(offer.checks) ? offer.checks as LocalCheck[] : []).filter(check => packet.policy.requiredChecks.includes(check.name));
    if (checks.length) {
      const checksPath = join(directory, 'local-checks.json');
      writeFileSync(checksPath, JSON.stringify(checks), { mode: 0o600, flag: 'wx' });
      await child(['verify', directory, checksPath], childEnvironment(home, {}), signal, checks.length * 120_000 + 30_000, reading);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    // Only the run itself reads its snapshot, which borrows the repository's shared copy.
    rmSync(join(directory, 'source.git'), { recursive: true, force: true });
  }
}

// How long one of this service's runners may take over a review, past the profile's own
// deadline, and how long a member's own runner may take (a subscription CLI is slower per call).
export const POOL_MARGIN_MS = 10 * 60_000;
export const OWN_RUNNER_DEADLINE_MS = 60 * 60_000;
// The router: offers each review to the PR author's own runner when the repository allows it
// and one is online, and otherwise to this service's runners, with the repository's model
// profile, its local checks, a read-only token for this one repository, and the earlier review
// a push review builds on.
export function router(config: PilotConfig, github: GitHub, runners: Runners, settings?: ReviewSettings): Dispatcher {
  return {
    ownRunner: author => settings?.current().selfRun ? runners.online(author) : null,
    async offer(job, to, directory, previous) {
      const profile = settings?.profile() ?? readProfile(config.profile);
      const base = { job: job.id, repository: config.repository, pr: job.pr, token: await github.readToken(), previous: previous ? previousReview(previous) : null };
      if (to === 'pool') runners.offer(job.id, POOL, config.repositoryId, directory,
        { ...base, profile, checks: config.localChecks?.filter(check => check.repositoryId === config.repositoryId) ?? [] }, profile.deadlineMs + POOL_MARGIN_MS);
      else runners.offer(job.id, to.user, config.repositoryId, directory, base, OWN_RUNNER_DEADLINE_MS);
    },
    poll: job => runners.poll(job.id),
    close: job => runners.close(job.id),
    open: () => runners.open(config.repositoryId),
  };
}
