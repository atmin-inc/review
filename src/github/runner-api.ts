import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parsePacket, parseResult } from '../contracts.js';
import { MAX_UPLOAD_BYTES, type Cli, type RunnerRow, type Runners } from './runners.js';

// The API `atmin-code-review-runner` calls. Everything is outbound from the runner: it signs
// in once with a GitHub device code, then polls for jobs, heartbeats, and uploads results.
const version = 'atmin.runner.v1';
const json = (response: ServerResponse, code: number, body: unknown) => {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify({ version, ...(body as object) }));
};
const log = (message: string) => process.stderr.write(`atmin review: runner ${message}\n`);
const clis: Cli[] = ['claude', 'codex'];
const failures = ['capture', 'model', 'usage-limit', 'signed-out', 'cancelled', 'other'] as const;
// Long polls hold a request open this long when no job is waiting.
export const POLL_MS = 25_000;

async function body(request: IncomingMessage, limit: number): Promise<{ value: unknown } | { error: number }> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) return { error: 413 }; chunks.push(chunk); }
  try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }; }
  catch { return { error: 400 }; }
}

export function runnerApi(runners: Runners, clientId: string, fetcher: typeof fetch = fetch,
  sleep = (ms: number) => new Promise(done => setTimeout(done, ms)), pollMs = POLL_MS) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = (request.url ?? '').split('?')[0]!;
    if (!path.startsWith('/api/runner/v1/')) return false;
    try {
      // The GitHub App's client id, for the device flow; it is public.
      if (request.method === 'GET' && path === '/api/runner/v1/config') { json(response, 200, { clientId }); return true; }
      if (request.method === 'POST' && path === '/api/runner/v1/login') {
        // The runner's own GitHub user token from the device flow proves who it runs for. It is
        // used once, to read the user, and never stored.
        const input = await body(request, 4096);
        if ('error' in input) { json(response, input.error, { error: 'Invalid sign-in.' }); return true; }
        const githubToken = (input.value as { githubToken?: unknown })?.githubToken;
        if (typeof githubToken !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(githubToken)) { json(response, 400, { error: 'Invalid sign-in.' }); return true; }
        const user = await fetcher('https://api.github.com/user', { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'atmin-review' },
          signal: AbortSignal.timeout(8000) });
        const data = user.ok ? await user.json() as { id?: unknown; login?: unknown } : null;
        if (!data || !Number.isSafeInteger(data.id) || (data.id as number) < 1 || typeof data.login !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(data.login)) {
          log(`sign-in refused: GitHub ${user.status}`); json(response, 401, { error: 'GitHub did not confirm this sign-in.' }); return true;
        }
        const token = runners.register(data.id as number, data.login);
        log(`signed in for GitHub user ${data.id}`);
        json(response, 200, { token, login: data.login });
        return true;
      }
      const authorization = request.headers.authorization ?? '';
      const runner = authorization.startsWith('Bearer ') ? runners.authenticate(authorization.slice(7)) : null;
      if (!runner) { json(response, 401, { error: 'Sign in again with `atmin-code-review-runner login`.' }); return true; }
      if (request.method === 'POST' && path === '/api/runner/v1/poll') {
        const input = await body(request, 4096);
        const value = 'value' in input ? input.value as { cli?: unknown; model?: unknown; version?: unknown } : null;
        if (!value || !clis.includes(value.cli as Cli) || typeof value.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,80}$/.test(value.model)
          || typeof value.version !== 'string' || !/^[A-Za-z0-9.+-]{1,40}$/.test(value.version)) { json(response, 400, { error: 'Invalid runner description.' }); return true; }
        const until = Date.now() + pollMs;
        for (;;) {
          runners.seen(runner.id, value.cli as Cli, value.model, value.version);
          const offer = runners.claim(runner);
          if (offer) { log(`${runner.id} claimed review ${offer.job}`); json(response, 200, { offer }); return true; }
          if (Date.now() >= until || request.destroyed) { json(response, 200, { offer: null }); return true; }
          await sleep(1000);
        }
      }
      const match = /^\/api\/runner\/v1\/jobs\/([0-9a-f-]{36})\/(heartbeat|result|fail)$/.exec(path);
      if (request.method !== 'POST' || !match) { json(response, 404, { error: 'Not found.' }); return true; }
      const [, job, action] = match as unknown as [string, string, string];
      const claimed = runners.claimed(runner, job);
      if (!claimed) { json(response, 409, { error: 'This review is no longer yours to report on.' }); return true; }
      if (action === 'heartbeat') { runners.heartbeat(runner, job); json(response, 200, {}); return true; }
      if (action === 'fail') {
        const input = await body(request, 4096);
        const reason = 'value' in input ? (input.value as { reason?: unknown })?.reason : null;
        const known = failures.includes(reason as typeof failures[number]) ? reason as string : 'other';
        runners.finish(runner, job, 'failed', known);
        log(`${runner.id} failed review ${job}: ${known}`);
        json(response, 200, {}); return true;
      }
      return await upload(request, response, runners, runner, job, claimed.directory);
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.name : 'non-error'}`);
      if (!response.headersSent) json(response, 500, { error: 'The review service could not handle this request.' });
      return true;
    }
  };
}

// Only the two records publication reads are accepted, checked against the contracts, and
// written under fixed names into the run directory this service chose.
async function upload(request: IncomingMessage, response: ServerResponse, runners: Runners, runner: RunnerRow, job: string, directory: string): Promise<boolean> {
  const input = await body(request, MAX_UPLOAD_BYTES);
  if ('error' in input) {
    runners.finish(runner, job, 'failed', input.error === 413 ? 'upload-too-large' : 'upload-unreadable');
    log(`${runner.id} upload for review ${job} refused: ${input.error}`);
    json(response, input.error, { error: 'Upload refused.' }); return true;
  }
  const value = input.value as { packet?: unknown; result?: unknown };
  let packet, result;
  try { packet = parsePacket(value?.packet); result = parseResult(value?.result); }
  catch {
    runners.finish(runner, job, 'failed', 'upload-invalid');
    log(`${runner.id} upload for review ${job} refused: invalid records`);
    json(response, 400, { error: 'Upload refused: the review records are not valid.' }); return true;
  }
  writeFileSync(join(directory, 'packet.json'), JSON.stringify(packet), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  runners.finish(runner, job, 'done');
  log(`${runner.id} delivered review ${job} (${result.findings.length} findings)`);
  json(response, 200, {});
  return true;
}
