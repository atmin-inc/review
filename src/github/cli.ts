#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readConfig, requiredEnv } from './config.js';
import { Store } from './store.js';
import { AppGitHub } from './api.js';
import { webhookServer, dispatchRepositories } from './webhook.js';
import { Repositories, type Repository } from './repositories.js';
import { Worker, failureCause } from './worker.js';
import { expireRuns, router } from './runner.js';
import { Runners } from './runners.js';
import { ModelKeys } from './model-keys.js';
import { runnerApi } from './runner-api.js';
import { dashboard } from './dashboard.js';
import { reviewPrice } from './dashboard-view.js';
import { site } from './site.js';
import { Billing, Stripe } from './billing.js';
import { ReviewSettings, readDashboardConfig } from './settings.js';
import { readProfile } from '../run.js';

async function main(): Promise<void> {
  const [operation, input, prInput] = process.argv.slice(2);
  if (!operation || operation === '--help') {
    process.stdout.write(`atmin review GitHub pilot\n\n  atmin-review-github serve|check <config.json>\n  atmin-review-github status|enable|pause <config.json>\n  atmin-review-github enqueue|reconcile <config.json> <pr-number>\n\nStarts paused. Operator controls are local; the optional dashboard requires GitHub admin access. Requires Node 24+, git and gh.\n`);
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
  const appId = requiredEnv('GITHUB_APP_ID'), key = readFileSync(requiredEnv('GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8');
  const dashboardConfig = process.env.REVIEW_DASHBOARD_CONFIG
    ? readDashboardConfig(process.env.REVIEW_DASHBOARD_CONFIG, requiredEnv('GITHUB_OAUTH_CLIENT_SECRET')) : undefined;
  const owner = randomUUID();
  if (!store.acquire(owner)) throw new Error('A pilot service already owns this state directory');
  // Buying credit needs a Stripe key; without one, reviews past the free ones run only on credit an operator adds.
  // Organizations' own model keys are sealed with ATMIN_REVIEW_KEY_SECRET; without it none can be set or used.
  const keys = new ModelKeys(store.db, process.env.ATMIN_REVIEW_KEY_SECRET);
  const repositories = dashboardConfig ? new Repositories(config, store, dashboardConfig.models, owner, process.env.STRIPE_SECRET_KEY ? dashboardConfig.origin : undefined, keys) : undefined;
  const billing = repositories && dashboardConfig && process.env.STRIPE_SECRET_KEY ? new Billing(new Stripe(process.env.STRIPE_SECRET_KEY), repositories, dashboardConfig.origin) : undefined;
  const initial: Repository = repositories?.entries.get(config.repositoryId) ?? { config, store, settings: new ReviewSettings(config, store) };
  const entries = repositories?.entries ?? new Map([[config.repositoryId, initial]]);
  // Every review runs on a runner: this service's own (`atmin-code-review-runner start --pool`,
  // sharing ATMIN_RUNNER_POOL_TOKEN), or a member's own, which needs the dashboard's sign-in.
  const runners = new Runners(store.db);
  const poolToken = process.env.ATMIN_RUNNER_POOL_TOKEN;
  if (!poolToken || Buffer.byteLength(poolToken) < 32) throw new Error('Set ATMIN_RUNNER_POOL_TOKEN to a secret of at least 32 bytes');
  const workers = new Map<number, { github: AppGitHub; worker: Worker }>();
  const runtime = (entry: Repository) => {
    let value = workers.get(entry.config.repositoryId);
    if (!value) {
      const github = new AppGitHub(entry.config, appId, key);
      value = { github, worker: new Worker(entry.config, entry.store, github, router(entry.config, github, runners, entry.settings, keys), owner, entry.settings,
        repositories ? (job, limit) => repositories.reserve(entry, job, owner, limit) : undefined, dashboardConfig?.origin,
        repositories ? job => reviewPrice(repositories, entry.config.installationId, job) : undefined) };
      workers.set(entry.config.repositoryId, value);
    }
    return value;
  };
  const runnerRoutes = runnerApi(runners, dashboardConfig?.clientId, poolToken);
  const api = dashboardConfig ? dashboard(config, dashboardConfig, store, initial.settings, fetch, repositories, { id: appId, key }, billing) : undefined;
  const pages = dashboardConfig ? site(fileURLToPath(new URL('../../web/dist', import.meta.url))) : undefined;
  const server = webhookServer(secret, (event, delivery, payload) => dispatchRepositories(entries, entry => runtime(entry).github, event, delivery, payload),
    api && pages ? async (request, response) => await runnerRoutes(request, response) || await api(request, response) || pages(request, response) : runnerRoutes);
  let stopping = false, cursor = 0, swept = 0;
  const stop = () => { stopping = true; for (const { worker } of workers.values()) worker.stop(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const heartbeat = setInterval(() => { for (const entry of entries.values()) if (!entry.store.renew(owner)) stop(); }, 5000);
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(config.port, config.host, done); });
    process.stdout.write(`${JSON.stringify({ service: 'atmin review', repository: config.repository, enabled: store.enabled(), host: config.host, port: config.port, billing: Boolean(billing) })}\n`);
    while (!stopping) {
      if (Date.now() - swept > 3_600_000) {
        swept = Date.now();
        for (const entry of entries.values()) {
          try { expireRuns(entry.config, entry.store); }
          catch (error) { process.stderr.write(`atmin review: deleting old run records in repository ${entry.config.repositoryId} failed: ${failureCause(error)}\n`); }
        }
        if (billing) await billing.reconcile().catch(error => process.stderr.write(`atmin review: checking credit payments with Stripe failed: ${failureCause(error)}\n`));
        if (billing) await billing.topUp().catch(error => process.stderr.write(`atmin review: auto top-up failed: ${failureCause(error)}\n`));
      }
      const ready = [...entries.values()];
      let worked = false;
      for (let i = 0; i < ready.length && !stopping; i++) {
        const entry = ready[cursor++ % ready.length]!;
        if (await runtime(entry).worker.tick()) { worked = true; break; }
      }
      // A finished review may have taken credit below the auto top-up threshold.
      if (worked && billing) await billing.topUp().catch(error => process.stderr.write(`atmin review: auto top-up failed: ${failureCause(error)}\n`));
      if (!worked && !stopping) await new Promise(done => setTimeout(done, 500));
    }
  } finally {
    clearInterval(heartbeat); stop();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    repositories?.close(); store.release(owner); store.close();
  }
}
try { await main(); }
catch {
  process.stderr.write('atmin review pilot could not complete the command. Check local configuration, credentials, port and service status.\n');
  process.exitCode = 1;
}
