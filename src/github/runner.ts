import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProfile } from '../run.js';
import type { PilotConfig } from './config.js';
import type { GitHub } from './api.js';
import type { Job } from './store.js';

export type Runner = (job: Job, signal: AbortSignal) => Promise<string>;
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
export function engineRunner(config: PilotConfig, github: GitHub): Runner {
  const runs = join(config.stateDirectory, 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  return async (job, signal) => {
    const directory = join(runs, job.id);
    const home = mkdtempSync(join(config.stateDirectory, 'job-home-'));
    try {
      const token = await github.readToken();
      await child(['capture', `https://github.com/${config.repository}/pull/${job.pr}`, directory], childEnvironment(home, { GH_TOKEN: token }), signal, 130_000);
      const profile = readProfile(config.profile);
      const keyName = profile.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
      const key = process.env[keyName];
      if (!key) throw new Error('Configured model credential unavailable');
      await child(['investigate', directory, config.profile], childEnvironment(home, { [keyName]: key }), signal, profile.deadlineMs + 30_000);
      return directory;
    } finally { rmSync(home, { recursive: true, force: true }); }
  };
}
