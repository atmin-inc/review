import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { claudeModels, parseProfile, type Profile } from './investigation.js';
import { claudeModel } from './models/claude-cli.js';
import { runClaimReviewAsResult } from './claim-result.js';
import { child, childEnvironment } from './github/runner.js';

// atmin-code-review-runner: reviews the PRs you author with the Claude Code CLI you are signed
// in to, on your own machine or server, and hands the result to atmin, which posts it. Your
// code and your Claude login stay here; atmin sends a one-hour read-only token per review.
const help = `atmin-code-review-runner — review your own PRs with your own Claude Code subscription

  atmin-code-review-runner login [--server https://review.atmin.ai]
  atmin-code-review-runner setup [--model claude-sonnet-5]
  atmin-code-review-runner [start]

login   signs this runner in as you, with a GitHub device code.
setup   checks the claude CLI is installed and signed in, and picks the model.
start   waits for reviews of PRs you author and runs them. Keep it running (tmux, launchd,
        systemd). Needs Node 24, git, gh, and claude signed in. A repository admin must turn
        on "Members' own runners" in atmin; otherwise atmin reviews those PRs itself.
`;
export interface RunnerConfig { server: string; token: string; login: string; cli?: 'claude'; model?: string }
export interface Offer { job: string; repository: string; pr: number; token: string; previous: unknown }
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

async function call(config: Pick<RunnerConfig, 'server' | 'token'>, path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(`${config.server}/api/runner/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
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

// One job: heartbeat while it runs, then upload the two records or say why not.
export async function runOffer(config: Pick<RunnerConfig, 'server' | 'token'>, offer: Offer, review: Review, signal: AbortSignal,
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
    if (stopped.signal.aborted) return 'cancelled';
    if (!outcome.ok) { await call(config, `/jobs/${offer.job}/fail`, { reason: outcome.reason }, fetcher).catch(() => {}); return outcome.reason; }
    const read = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
    await call(config, `/jobs/${offer.job}/result`, { packet: read('packet.json'), result: read('result.json') }, fetcher);
    return 'done';
  } finally {
    clearInterval(beat); signal.removeEventListener('abort', stop);
    rmSync(root, { recursive: true, force: true });
  }
}

async function start(): Promise<void> {
  const config = readConfig();
  if (config.cli !== 'claude' || !config.model) throw new Error('Run `atmin-code-review-runner setup` first.');
  const profile = profileFor(config.model);
  const cache = join(homedir(), '.cache', 'atmin', 'code-review-runner');
  const review = reviewWith(profile, cache);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
  say(`Waiting for reviews of PRs by ${config.login} (Claude Code / ${config.model}) from ${config.server}. Ctrl-C stops.`);
  while (!abort.signal.aborted) {
    let offer: Offer | null;
    try { offer = (await call(config, '/poll', { cli: 'claude', model: config.model, version }) as { offer: Offer | null }).offer; }
    catch (error) {
      if (/atmin 401/.test(String(error))) throw new Error('atmin no longer accepts this runner. Run `atmin-code-review-runner login` again.');
      say(`Could not reach atmin (${error instanceof Error ? error.message : 'unknown'}); retrying in 15 s.`);
      await sleep(15_000); continue;
    }
    if (!offer) continue;
    say(`Reviewing ${offer.repository}#${offer.pr}…`);
    const outcome = await runOffer(config, offer, review, abort.signal);
    say(outcome === 'done' ? `Sent the review of ${offer.repository}#${offer.pr} to atmin.` : `Review of ${offer.repository}#${offer.pr} did not finish (${outcome}); atmin reviews it instead.`);
  }
}

export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true,
    options: { help: { type: 'boolean', short: 'h' }, server: { type: 'string' }, model: { type: 'string' } } });
  const [operation = 'start'] = positionals;
  if (values.help) { process.stdout.write(help); return; }
  if (operation === 'login') return login((values.server ?? 'https://review.atmin.ai').replace(/\/+$/, ''));
  if (operation === 'setup') return setup(values.model);
  if (operation === 'start') return start();
  throw new Error('Unknown command; use --help');
}
