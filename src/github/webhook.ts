import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { PilotConfig } from './config.js';
import type { GitHub } from './api.js';
import type { Store } from './store.js';

export function validSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  return timingSafeEqual(Buffer.from(header.slice(7), 'hex'), createHmac('sha256', secret).update(body).digest());
}
export function webhook(config: PilotConfig, secret: string, store: Store, github: GitHub): Server {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    const reply = (code: number, text: string) => { response.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end(`${text}\n`); };
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
      if (payload.installation?.id !== config.installationId) { reply(202, 'ignored installation'); return; }
      if ((event === 'installation' && ['deleted', 'suspend'].includes(payload.action)) || (event === 'installation_repositories' && payload.repositories_removed?.some((repo: any) => repo.id === config.repositoryId))) {
        store.enable(false); reply(202, 'paused'); return;
      }
      if (payload.repository?.id !== config.repositoryId || payload.repository?.full_name !== config.repository) { reply(202, 'ignored repository'); return; }
      if (store.seen(delivery)) { reply(200, 'duplicate'); return; }
      if (event === 'check_run' && ['created', 'completed'].includes(payload.action)) {
        const check = payload.check_run;
        if (typeof check?.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(check.head_sha)
          || !config.trustedChecks?.some(c => c.name === check.name && c.appId === check.app?.id)) {
          reply(202, 'ignored check'); return;
        }
        // The payload wakes reconciliation; only the canonical API can attest CI results.
        store.refreshValidation(delivery, check.head_sha);
        reply(202, 'validation refresh recorded'); return;
      }
      if (event === 'push' && typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/')) {
        for (const number of store.branchPulls(payload.ref.slice(11))) store.enqueue(`${delivery}-${number}`, number);
        reply(202, 'tracked target branches reconciled'); return;
      }
      let pr: number | undefined;
      if (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'closed'].includes(payload.action)) pr = payload.number;
      if (event === 'pull_request' && payload.action === 'edited' && payload.changes?.base) pr = payload.number;
      if (event === 'issue_comment' && payload.action === 'created' && payload.issue?.pull_request && payload.comment?.body?.trim() === '/atmin review') {
        if (payload.comment.user?.type !== 'User' || payload.sender?.id !== payload.comment.user?.id) { reply(202, 'ignored actor'); return; }
        // GitHub expects a prompt acknowledgement. On timeout, accept nothing and allow redelivery.
        let timer: NodeJS.Timeout | undefined;
        let allowed: boolean;
        try {
          allowed = await Promise.race([github.canReview(payload.comment.user.login), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Permission lookup deadline')), 8000);
          })]);
        } finally { clearTimeout(timer); }
        if (!allowed) { reply(202, 'insufficient permission'); return; }
        pr = payload.issue.number;
      }
      if (!Number.isSafeInteger(pr) || pr! < 1) { reply(202, 'ignored event'); return; }
      const id = store.enqueue(delivery, pr!);
      reply(202, id ? 'queued' : 'paused or duplicate');
    } catch { reply(503, 'delivery not accepted; redeliver after recovery'); }
  });
}
