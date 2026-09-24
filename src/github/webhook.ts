import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PilotConfig } from './config.js';
import type { GitHub } from './api.js';
import type { Store } from './store.js';
import type { Repository } from './repositories.js';

export function validSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  return timingSafeEqual(Buffer.from(header.slice(7), 'hex'), createHmac('sha256', secret).update(body).digest());
}
export function webhook(config: PilotConfig, secret: string, store: Store, github: GitHub, dashboard?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>): Server {
  return webhookServer(secret, (event, delivery, payload) => repositoryEvent(config, store, github, event, delivery, payload), dashboard);
}

export function webhookServer(secret: string, dispatch: (event: string | string[] | undefined, delivery: string, payload: any) => Promise<[number, string]>, dashboard?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>): Server {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    const reply = (code: number, text: string) => { response.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end(`${text}\n`); };
    if (dashboard && await dashboard(request, response)) return;
    if (request.method === 'GET' && request.url === '/healthz') { reply(200, 'ok'); return; }
    if (request.method !== 'POST' || request.url !== '/webhooks/github') { reply(404, 'not found'); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_048_576) { reply(413, 'payload too large'); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const signature = request.headers['x-hub-signature-256'];
      if (typeof signature !== 'string' || !validSignature(body, signature, secret)) { reply(401, 'invalid signature'); return; }
      const delivery = request.headers['x-github-delivery'];
      if (typeof delivery !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(delivery)) { reply(400, 'invalid delivery'); return; }
      const event = request.headers['x-github-event'];
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { reply(400, 'invalid JSON'); return; }
      if (!payload || typeof payload !== 'object') { reply(400, 'invalid payload'); return; }
      if (event === 'ping') { reply(200, 'pong'); return; }
      const result = await dispatch(event, delivery, payload);
      reply(result[0], result[1]);
    } catch { reply(503, 'delivery not accepted; redeliver after recovery'); }
  });
}

export async function repositoryEvent(config: PilotConfig, store: Store, github: GitHub, event: string | string[] | undefined, delivery: string, payload: any): Promise<[number, string]> {
  if (payload.installation?.id !== config.installationId) { return [202, 'ignored installation']; }
  if ((event === 'installation' && ['deleted', 'suspend'].includes(payload.action)) || (event === 'installation_repositories' && payload.repositories_removed?.some((repo: any) => repo.id === config.repositoryId))) {
    store.enable(false); return [202, 'paused'];
  }
  if (payload.repository?.id !== config.repositoryId || payload.repository?.full_name !== config.repository) { return [202, 'ignored repository']; }
  if (store.seen(delivery)) { return [200, 'duplicate']; }
  if (event === 'check_run' && ['created', 'completed'].includes(payload.action)) {
    const check = payload.check_run;
    if (typeof check?.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(check.head_sha)
      || !config.trustedChecks?.some(c => c.name === check.name && c.appId === check.app?.id)) {
      return [202, 'ignored check'];
    }
    // The payload wakes reconciliation; only the canonical API can attest CI results.
    store.refreshValidation(delivery, check.head_sha);
    return [202, 'validation refresh recorded'];
  }
  if (event === 'push' && typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/')) {
    for (const number of store.branchPulls(payload.ref.slice(11))) store.enqueue(`${delivery}-${number}`, number);
    return [202, 'tracked target branches reconciled'];
  }
  let pr: number | undefined;
  if (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'closed'].includes(payload.action)) pr = payload.number;
  if (event === 'pull_request' && payload.action === 'edited' && payload.changes?.base) pr = payload.number;
  if (event === 'issue_comment' && payload.action === 'created' && payload.issue?.pull_request && payload.comment?.body?.trim() === '/atmin review') {
    if (payload.comment.user?.type !== 'User' || payload.sender?.id !== payload.comment.user?.id) { return [202, 'ignored actor']; }
    // GitHub expects a prompt acknowledgement. On timeout, accept nothing and allow redelivery.
    let timer: NodeJS.Timeout | undefined;
    let allowed: boolean;
    try {
      allowed = await Promise.race([github.canReview(payload.comment.user.login), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Permission lookup deadline')), 8000);
      })]);
    } finally { clearTimeout(timer); }
    if (!allowed) { return [202, 'insufficient permission']; }
    pr = payload.issue.number;
  }
  if (!Number.isSafeInteger(pr) || pr! < 1) { return [202, 'ignored event']; }
  const id = store.enqueue(delivery, pr!, event === 'issue_comment' ? 'command' : 'event');
  return [202, id ? 'queued' : 'paused or duplicate'];
}

export async function dispatchRepositories(entries: Map<number, Repository>, github: (entry: Repository) => GitHub, event: string | string[] | undefined, delivery: string, payload: any): Promise<[number, string]> {
  const matching = [...entries.values()].filter(entry => entry.config.installationId === payload.installation?.id);
  if (event === 'installation' || event === 'installation_repositories') {
    for (const entry of matching) await repositoryEvent(entry.config, entry.store, github(entry), event, delivery, payload);
    return [202, 'installation reconciled'];
  }
  const entry = matching.find(entry => entry.config.repositoryId === payload.repository?.id);
  return entry ? repositoryEvent(entry.config, entry.store, github(entry), event, delivery, payload) : [202, 'repository not connected'];
}
