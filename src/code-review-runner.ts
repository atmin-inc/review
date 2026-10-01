import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { claudeModels, parseProfile, type Profile } from './investigation.js';
import { claudeModel } from './models/claude-cli.js';
import { runClaimReviewAsResult } from './claim-result.js';
import { child, childEnvironment, hostedReview } from './github/runner.js';
import type { Offer } from './github/runners.js';

// atmin-code-review-runner: reviews the PRs you author with the Claude Code CLI you are signed
// in to, on your own machine or server, and hands the result to atmin, which posts it. Your
// code and your Claude login stay here; atmin sends a one-hour read-only token per review.
const help = `atmin-code-review-runner — review your own PRs with your own Claude Code subscription

  atmin-code-review-runner login [--server https://review.atmin.ai]
  atmin-code-review-runner setup [--model claude-sonnet-5]
  atmin-code-review-runner [start]
  atmin-code-review-runner start --pool <name>

login   signs this runner in as you, with a GitHub device code.
setup   checks the claude CLI is installed and signed in, and picks the model.
start   waits for reviews of PRs you author and runs them. Keep it running (tmux, launchd,
        systemd). Needs Node 24, git, gh, and claude signed in. A repository admin must turn
        on "Members' own runners" in atmin; otherwise atmin reviews those PRs itself.
        A first Ctrl-C finishes the review in progress, a second stops at once.
--pool  runs as one of atmin's own runners, on the service's host: any review, with the
        service's model key. Reads ATMIN_RUNNER_POOL_TOKEN, OPENROUTER_API_KEY, TYPESAFE_API_KEY,
        ATMIN_REVIEW_CONFIG (for the service's port) and ATMIN_RUNNER_CACHE.
`;
export interface RunnerConfig { server: string; token: string; login: string; cli?: 'claude'; model?: string }
// How a runner reaches atmin: a member's runner by its own token; one of atmin's own runners by
// the shared pool token and its name.
type Connection = Pick<RunnerConfig, 'server' | 'token'> & { pool?: string };
const configPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'atmin', 'code-review-runner.json');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
const say = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

function readConfig(): RunnerConfig {
  if (!existsSync(configPath())) throw new Error('Not signed in. Run `atmin-code-review-runner login` first.');
  return JSON.parse(readFileSync(configPath(), 'utf8')) as RunnerConfig;
}
function saveConfig(config: RunnerConfig): void {
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
// The same limits the Claude profiles were benchmarked with.
export const profileFor = (model: string): Profile => parseProfile({ provider: 'claude-local', model, maxUsd: 0, maxTurns: 60, maxToolCalls: 200,
  maxInputTokens: 150000, maxOutputTokens: 8192, deadlineMs: 1_800_000 });

async function call(config: Connection, path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(`${config.server}/api/runner/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}), ...(config.pool ? { 'x-atmin-runner-pool': config.pool } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`atmin ${response.status}: ${typeof data.error === 'string' ? data.error : 'request failed'}`);
  return data;
}

async function login(server: string): Promise<void> {
  const { clientId } = await call({ server, token: '' }, '/config') as { clientId: string };
  const form = (values: Record<string, string>) => ({ method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
  const device = await (await fetch('https://github.com/login/device/code', form({ client_id: clientId }))).json() as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number };
  if (!device.device_code || !device.user_code) throw new Error('GitHub did not start a device sign-in. The atmin app may not have device flow enabled yet.');
  say(`Open ${device.verification_uri} and enter ${device.user_code}`);
  let interval = (device.interval ?? 5) * 1000;
  for (;;) {
    await sleep(interval);
    const answer = await (await fetch('https://github.com/login/oauth/access_token', form({ client_id: clientId, device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }))).json() as { access_token?: string; error?: string; interval?: number };
    if (answer.access_token) {
      const { token, login: user } = await call({ server, token: '' }, '/login', { githubToken: answer.access_token }) as { token: string; login: string };
      saveConfig({ server, token, login: user });
      say(`Signed in as ${user}. Next: atmin-code-review-runner setup`);
      return;
    }
    if (answer.error === 'slow_down') interval = (answer.interval ?? interval / 1000 + 5) * 1000;
    else if (answer.error !== 'authorization_pending') throw new Error(`GitHub sign-in ended: ${answer.error ?? 'no token'}`);
  }
}

async function setup(model: string | undefined): Promise<void> {
  const config = readConfig();
  let claude: string;
  try { claude = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim(); }
  catch { throw new Error('The claude CLI is not installed or not on PATH. Install Claude Code and sign in with `claude` first.'); }
  say(`Found Claude Code ${claude}.`);
  if (!model) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    claudeModels.forEach((m, i) => say(`  ${i + 1}. ${m}${m === 'claude-sonnet-5' ? ' (default)' : ''}`));
    const answer = (await prompt.question('Model [claude-sonnet-5]: ')).trim();
    prompt.close();
    model = answer === '' ? 'claude-sonnet-5' : claudeModels[Number(answer) - 1] ?? answer;
  }
  if (!(claudeModels as readonly string[]).includes(model)) throw new Error(`Choose one of: ${claudeModels.join(', ')}`);
  // One tiny request proves the CLI is signed in before any review depends on it.
  try { execFileSync('claude', ['-p', '--tools', '', '--setting-sources', '', '--model', model, 'Reply with OK.'], { encoding: 'utf8', timeout: 120_000, cwd: tmpdir() }); }
  catch { throw new Error('claude did not answer. Run `claude` once and sign in, then try setup again.'); }
  saveConfig({ ...config, cli: 'claude', model });
  say(`Ready: reviews of PRs by ${config.login} will run on Claude Code / ${model}. Start with: atmin-code-review-runner`);
  say('Reviews from atmin are not benchmarked on this model yet; atmin measured only its hosted model.');
}

// Why a review failed, in the words the service accepts; atmin then reviews the PR itself.
type Failure = 'capture' | 'model' | 'usage-limit' | 'signed-out' | 'cancelled' | 'other';
export type Review = (offer: Offer, directory: string, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; reason: Failure }>;

export function reviewWith(profile: Profile, cache: string): Review {
  return async (offer, directory, signal) => {
    const home = mkdtempSync(join(tmpdir(), 'atmin-runner-home-'));
    try {
      const cacheFor = join(cache, offer.repository.replace('/', '__'));
      mkdirSync(cacheFor, { recursive: true, mode: 0o700 });
      try {
        // Source capture runs in its own process with only the read-only token.
        await child(['capture', `https://github.com/${offer.repository}/pull/${offer.pr}`, directory, join(cacheFor, 'source-cache.git')],
          childEnvironment(home, { GH_TOKEN: offer.token }), signal, 130_000);
      } catch { return { ok: false, reason: signal.aborted ? 'cancelled' : 'capture' }; }
      if (offer.previous) writeFileSync(join(directory, 'previous.json'), JSON.stringify(offer.previous), { mode: 0o600, flag: 'wx' });
      const model = claudeModel(profile);
      try {
        const { investigation } = await runClaimReviewAsResult(directory, profile, signal, model);
        if (investigation.stopReason === 'finished') return { ok: true };
        const kind = investigation.telemetry.failure?.kind;
        return { ok: false, reason: signal.aborted ? 'cancelled' : kind === 'rate-limit' ? 'usage-limit' : kind === 'authentication' ? 'signed-out' : 'model' };
      } finally { model.close(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  };
}

// One of atmin's own runners: the same review the service ran before it had runners.
export function poolReview(cache: string): Review {
  return async (offer, directory, signal) => {
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    try { await hostedReview(offer, directory, join(cache, `${offer.repository.replace('/', '__')}.git`), signal); }
    catch { return { ok: false, reason: signal.aborted ? 'cancelled' : 'other' }; }
    return { ok: true };
  };
}

// Every record of a run except the source copy, which atmin's own runners send.
const recordName = /^[a-z0-9][a-z0-9.-]{0,60}\.(json|ndjson|diff)$/;
function records(directory: string): Record<string, string> {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && recordName.test(entry.name) && entry.name !== 'packet.json' && entry.name !== 'result.json')
    .map(entry => [entry.name, readFileSync(join(directory, entry.name), 'utf8')]));
}

// One job: heartbeat while it runs, then upload the records or say why not.
export async function runOffer(config: Connection, offer: Offer, review: Review, signal: AbortSignal,
  fetcher: typeof fetch = fetch, heartbeatMs = 30_000): Promise<'done' | Failure> {
  const root = mkdtempSync(join(tmpdir(), 'atmin-runner-'));
  const directory = join(root, 'run');
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  signal.addEventListener('abort', stop, { once: true });
  const beat = setInterval(() => {
    // A 409 means atmin took the review back (a new push, or it reviewed it itself).
    call(config, `/jobs/${offer.job}/heartbeat`, {}, fetcher).catch(error => { if (/atmin 409/.test(String(error))) stopped.abort(); });
  }, heartbeatMs);
  try {
    const outcome = await review(offer, directory, stopped.signal).catch(() => ({ ok: false as const, reason: 'other' as const }));
    if (stopped.signal.aborted) { if (signal.aborted) await call(config, `/jobs/${offer.job}/fail`, { reason: 'cancelled' }, fetcher).catch(() => {}); return 'cancelled'; }
    const extra = config.pool ? { records: records(directory) } : {};
    if (!outcome.ok) { await call(config, `/jobs/${offer.job}/fail`, { reason: outcome.reason, ...extra }, fetcher).catch(() => {}); return outcome.reason; }
    const read = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
    await call(config, `/jobs/${offer.job}/result`, { packet: read('packet.json'), result: read('result.json'), ...extra }, fetcher);
    return 'done';
  } finally {
    clearInterval(beat); signal.removeEventListener('abort', stop);
    rmSync(root, { recursive: true, force: true });
  }
}

// The service's own address, for a runner on its host.
function localServer(): string {
  const path = process.env.ATMIN_REVIEW_CONFIG;
  if (!path) throw new Error('Set ATMIN_REVIEW_CONFIG, or pass --server.');
  const { host, port } = JSON.parse(readFileSync(path, 'utf8')) as { host?: string; port?: number };
  return `http://${!host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;
}

async function start(pool: string | undefined, server: string | undefined): Promise<void> {
  let connection: Connection, review: Review, described: unknown, who: string;
  if (pool) {
    if (!/^[a-z0-9-]{1,40}$/.test(pool)) throw new Error('A pool runner name is lowercase letters, digits and dashes.');
    const token = process.env.ATMIN_RUNNER_POOL_TOKEN;
    if (!token) throw new Error('Set ATMIN_RUNNER_POOL_TOKEN.');
    connection = { server: (server ?? localServer()).replace(/\/+$/, ''), token, pool };
    review = poolReview(process.env.ATMIN_RUNNER_CACHE ?? join(homedir(), '.cache', 'atmin', 'code-review-runner', `pool-${pool}`));
    described = {}; who = `any PR, as atmin runner ${pool}`;
  } else {
    const config = readConfig();
    if (config.cli !== 'claude' || !config.model) throw new Error('Run `atmin-code-review-runner setup` first.');
    connection = config;
    review = reviewWith(profileFor(config.model), join(homedir(), '.cache', 'atmin', 'code-review-runner'));
    described = { cli: 'claude', model: config.model, version }; who = `PRs by ${config.login} (Claude Code / ${config.model})`;
  }
  // The first signal lets the review in progress finish (a deploy restarts atmin's own runners);
  // a second stops it at once.
  const abort = new AbortController();
  let stopping = false;
  const signalled = () => {
    if (stopping) { abort.abort(); return; }
    stopping = true; say('Stopping after the review in progress. Signal again to stop now.');
  };
  process.on('SIGINT', signalled); process.on('SIGTERM', signalled);
  say(`Waiting for reviews of ${who} from ${connection.server}.`);
  while (!stopping) {
    let offer: Offer | null;
    try { offer = (await call(connection, '/poll', described) as { offer: Offer | null }).offer; }
    catch (error) {
      if (/atmin 401/.test(String(error))) throw new Error(pool ? 'atmin refused the pool token.' : 'atmin no longer accepts this runner. Run `atmin-code-review-runner login` again.');
      say(`Could not reach atmin (${error instanceof Error ? error.message : 'unknown'}); retrying in 15 s.`);
      await sleep(15_000); continue;
    }
    if (!offer) continue;
    say(`Reviewing ${offer.repository}#${offer.pr} (${offer.job})…`);
    const outcome = await runOffer(connection, offer, review, abort.signal);
    say(outcome === 'done' ? `Sent the review of ${offer.repository}#${offer.pr} to atmin.`
      : `Review of ${offer.repository}#${offer.pr} did not finish (${outcome})${pool ? '' : '; atmin reviews it instead'}.`);
  }
  process.off('SIGINT', signalled); process.off('SIGTERM', signalled);
}

export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true,
    options: { help: { type: 'boolean', short: 'h' }, server: { type: 'string' }, model: { type: 'string' }, pool: { type: 'string' } } });
  const [operation = 'start'] = positionals;
  if (values.help) { process.stdout.write(help); return; }
  if (operation === 'login') return login((values.server ?? 'https://review.atmin.ai').replace(/\/+$/, ''));
  if (operation === 'setup') return setup(values.model);
  if (operation === 'start') return start(values.pool, values.server);
  throw new Error('Unknown command; use --help');
}
