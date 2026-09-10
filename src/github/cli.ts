#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig, requiredEnv } from './config.js';
import { Store } from './store.js';
import { AppGitHub } from './api.js';
import { webhook } from './webhook.js';
import { Worker } from './worker.js';
import { engineRunner } from './runner.js';
import { readProfile } from '../run.js';

async function main(): Promise<void> {
  const [operation, input, prInput] = process.argv.slice(2);
  if (!operation || operation === '--help') {
    process.stdout.write(`atmin review GitHub pilot\n\n  atmin-review-github serve|check <config.json>\n  atmin-review-github status|enable|pause <config.json>\n  atmin-review-github enqueue|reconcile <config.json> <pr-number>\n\nStarts paused. Operator controls are local only. Requires Node 24+, git and gh.\n`);
    return;
  }
  if (!input || !['serve', 'check', 'status', 'enable', 'pause', 'enqueue', 'reconcile'].includes(operation)) throw new Error('Invalid pilot command; use --help');
  const config = readConfig(resolve(input));
  process.umask(0o077);
  if (operation === 'check') {
    requiredEnv(readProfile(config.profile).provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY');
    if (Buffer.byteLength(requiredEnv('GITHUB_WEBHOOK_SECRET')) < 32) throw new Error('Use a webhook secret of at least 32 bytes');
    const github = new AppGitHub(config, requiredEnv('GITHUB_APP_ID'), readFileSync(requiredEnv('GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'));
    process.stdout.write(`${JSON.stringify(await github.verifyInstallation())}\n`);
    return;
  }
  const store = new Store(config.stateDirectory);
  if (operation !== 'serve') {
    try {
      if (operation === 'enable') store.enable(true);
      if (operation === 'pause') store.enable(false);
      if (operation === 'enqueue' || operation === 'reconcile') {
        const pr = Number(prInput);
        if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('Expected a positive PR number');
        if (!store.enabled()) throw new Error('Pilot is paused; enable it first');
        if (operation === 'enqueue' && !store.enqueue(`operator-${randomUUID()}`, pr)) throw new Error('Review was not queued');
        if (operation === 'reconcile' && !store.retryPublication(pr)) throw new Error('No current saved report to reconcile');
      }
      process.stdout.write(`${JSON.stringify(store.status(), null, 2)}\n`);
    } finally { store.close(); }
    return;
  }
  const secret = requiredEnv('GITHUB_WEBHOOK_SECRET');
  if (Buffer.byteLength(secret) < 32) throw new Error('Use a webhook secret of at least 32 bytes');
  const github = new AppGitHub(config, requiredEnv('GITHUB_APP_ID'), readFileSync(requiredEnv('GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'));
  const owner = randomUUID();
  if (!store.acquire(owner)) throw new Error('A pilot service already owns this state directory');
  const server = webhook(config, secret, store, github);
  const worker = new Worker(config, store, github, engineRunner(config, github), owner);
  let stopping = false;
  const stop = () => { stopping = true; worker.stop(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const heartbeat = setInterval(() => { if (!store.renew(owner)) stop(); }, 5000);
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(config.port, config.host, done); });
    process.stdout.write(`${JSON.stringify({ service: 'atmin review', repository: config.repository, enabled: store.enabled(), host: config.host, port: config.port })}\n`);
    while (!stopping) {
      const worked = await worker.tick();
      if (!worked && !stopping) await new Promise(done => setTimeout(done, 500));
    }
  } finally {
    clearInterval(heartbeat); stop();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    store.release(owner); store.close();
  }
}
try { await main(); }
catch {
  process.stderr.write('atmin review pilot could not complete the command. Check local configuration, credentials, port and service status.\n');
  process.exitCode = 1;
}
