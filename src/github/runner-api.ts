import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parsePacket, parseResult } from '../contracts.js';
import { MAX_POOL_UPLOAD_BYTES, MAX_UPLOAD_BYTES, POOL, Runners, type Cli, type RunnerRow } from './runners.js';

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

export function runnerApi(runners: Runners, clientId: string | undefined, poolToken: string | undefined, fetcher: typeof fetch = fetch,
  sleep = (ms: number) => new Promise(done => setTimeout(done, ms)), pollMs = POLL_MS) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = (request.url ?? '').split('?')[0]!;
    if (!path.startsWith('/api/runner/v1/')) return false;
    try {
      // The GitHub App's client id, for the device flow; it is public.
      if (request.method === 'GET' && path === '/api/runner/v1/config') { json(response, 200, { clientId: clientId ?? null }); return true; }
      if (request.method === 'POST' && path === '/api/runner/v1/login') {
        if (!clientId) { json(response, 404, { error: 'Sign-in is not available on this service.' }); return true; }
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
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const pool = request.headers['x-atmin-runner-pool'];
      const runner = typeof pool === 'string' ? Runners.hosted(token, poolToken, pool) : token ? runners.authenticate(token) : null;
      if (!runner) { json(response, 401, { error: 'Sign in again with `atmin-code-review-runner login`.' }); return true; }
      if (request.method === 'POST' && path === '/api/runner/v1/poll') {
        const input = await body(request, 4096);
        const value = 'value' in input ? input.value as { cli?: unknown; model?: unknown; version?: unknown } : null;
        if (runner.user === POOL) return await poll(response, runners, runner, pollMs, sleep);
        if (!value || !clis.includes(value.cli as Cli) || typeof value.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,80}$/.test(value.model)
          || typeof value.version !== 'string' || !/^[A-Za-z0-9.+-]{1,40}$/.test(value.version)) { json(response, 400, { error: 'Invalid runner description.' }); return true; }
        const described = { cli: value.cli as Cli, model: value.model, version: value.version };
        return await poll(response, runners, runner, pollMs, sleep, () => runners.seen(runner.id, described.cli, described.model, described.version));
      }
      const match = /^\/api\/runner\/v1\/jobs\/([0-9a-f-]{36})\/(heartbeat|result|fail)$/.exec(path);
      if (request.method !== 'POST' || !match) { json(response, 404, { error: 'Not found.' }); return true; }
      const [, job, action] = match as unknown as [string, string, string];
      const claimed = runners.claimed(runner, job);
      if (!claimed) { json(response, 409, { error: 'This review is no longer yours to report on.' }); return true; }
      if (action === 'heartbeat') { runners.heartbeat(runner, job); json(response, 200, {}); return true; }
      if (action === 'fail') {
        // This service's runners also send the records of a run that did not finish: its
        // receipt is what billing reads, and its telemetry says why.
        const pool = claimed.user === POOL;
        const input = await body(request, pool ? MAX_POOL_UPLOAD_BYTES : 4096);
        const value = 'value' in input ? input.value as { reason?: unknown; records?: unknown } : null;
        const known = failures.includes(value?.reason as typeof failures[number]) ? value!.reason as string : 'other';
        const records = pool ? readRecords(value?.records) : [];
        if (records) for (const [name, text] of records) writeFileSync(join(claimed.directory, name), text, { mode: 0o600, flag: 'wx' });
        runners.finish(runner, job, 'failed', known);
        log(`${runner.id} failed review ${job}: ${known}`);
        json(response, 200, {}); return true;
      }
      return await upload(request, response, runners, runner, job, claimed.directory, claimed.user === POOL);
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.name : 'non-error'}`);
      if (!response.headersSent) json(response, 500, { error: 'The review service could not handle this request.' });
      return true;
    }
  };
}

async function poll(response: ServerResponse, runners: Runners, runner: RunnerRow, pollMs: number,
  sleep: (ms: number) => Promise<unknown>, seen = () => {}): Promise<boolean> {
  const until = Date.now() + pollMs;
  // A runner that went away closes the response. Not `request.destroyed`: Node destroys a request
  // once its body is read, which ended every poll at once (2026-10-08: ~380 polls a second per idle runner).
  let gone = false;
  response.once('close', () => { gone = true; });
  for (;;) {
    seen();
    const offer = runners.claim(runner);
    if (offer) { log(`${runner.id} claimed review ${offer.job}`); json(response, 200, { offer }); return true; }
    if (Date.now() >= until || gone) { json(response, 200, { offer: null }); return true; }
    await sleep(1000);
  }
}

// A run's records: what publication, billing and the dashboard read. Never the source copy.
const record = /^[a-z0-9][a-z0-9.-]{0,60}\.(json|ndjson|diff)$/;
// The records a run sent besides packet.json and result.json, or null when any is not one.
function readRecords(value: unknown): [string, string][] | null {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([name, text]) => record.test(name) && !name.includes('..') && name !== 'packet.json' && name !== 'result.json' && typeof text === 'string')
    ? entries as [string, string][] : null;
}
// A user's runner may send only the two records publication reads; this service's own runners
// send every record of the run. Both are checked against the contracts and written under their
// own names into the run directory this service chose.
async function upload(request: IncomingMessage, response: ServerResponse, runners: Runners, runner: RunnerRow, job: string, directory: string, pool: boolean): Promise<boolean> {
  const input = await body(request, pool ? MAX_POOL_UPLOAD_BYTES : MAX_UPLOAD_BYTES);
  if ('error' in input) {
    runners.finish(runner, job, 'failed', input.error === 413 ? 'upload-too-large' : 'upload-unreadable');
    log(`${runner.id} upload for review ${job} refused: ${input.error}`);
    json(response, input.error, { error: 'Upload refused.' }); return true;
  }
  const value = input.value as { packet?: unknown; result?: unknown; records?: unknown };
  let packet, result;
  const records = pool ? readRecords(value?.records) : [];
  try {
    packet = parsePacket(value?.packet); result = parseResult(value?.result);
    if (!records) throw new Error('Invalid record');
  }
  catch {
    runners.finish(runner, job, 'failed', 'upload-invalid');
    log(`${runner.id} upload for review ${job} refused: invalid records`);
    json(response, 400, { error: 'Upload refused: the review records are not valid.' }); return true;
  }
  writeFileSync(join(directory, 'packet.json'), JSON.stringify(packet), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  for (const [name, text] of records) writeFileSync(join(directory, name), text, { mode: 0o600, flag: 'wx' });
  runners.finish(runner, job, 'done');
  log(`${runner.id} delivered review ${job} (${result.findings.length} findings, ${records.length} other records)`);
  json(response, 200, {});
  return true;
}
