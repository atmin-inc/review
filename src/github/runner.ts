import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePacket } from '../contracts.js';
import { readProfile } from '../run.js';
import { previousReview } from '../claim-result.js';
import type { PilotConfig } from './config.js';
import type { GitHub } from './api.js';
import type { ReviewSettings } from './settings.js';
import type { Job } from './store.js';

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
      await child(['capture', `https://github.com/${config.repository}/pull/${job.pr}`, directory], childEnvironment(home, { GH_TOKEN: token }), signal, 130_000);
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
    } finally { rmSync(home, { recursive: true, force: true }); }
  };
}
