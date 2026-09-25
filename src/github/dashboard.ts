import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PilotConfig } from './config.js';
import type { Store } from './store.js';
import type { Repositories } from './repositories.js';
import type { DashboardConfig, ReviewSettings } from './settings.js';

import { history, pullViews, readReview, livePulls, latestJobs, verifiedRepositories } from './dashboard-view.js';
export { history } from './dashboard-view.js';

const version = 'atmin.review.v1';
const sessionCookie = '__Host-atmin-review';
const flowCookie = '__Host-atmin-review-oauth';
const random = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
const cookies = (request: IncomingMessage) => new Map((request.headers.cookie ?? '').split(';').map(part => part.trim().split('=')) as [string, string][]);
const json = (response: ServerResponse, code: number, body: unknown) => {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(body));
};
const redirect = (response: ServerResponse, location: string) => {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end();
};
class Denied extends Error {}
interface User { id: number; login: string; }
interface Session { token: string; user: User; expires: number; }
interface Flow { verifier: string; expires: number; returnTo: string; }

export function dashboard(config: PilotConfig, options: DashboardConfig, store: Store, settings: ReviewSettings, fetcher: typeof fetch = fetch, repositories?: Repositories) {
  // ponytail: one pilot process, bounded in-memory sessions; restart signs everyone out.
  // Tokens never touch disk. Add shared encrypted sessions only with multiple web workers.
  const sessions = new Map<string, Session>();
  const flows = new Map<string, Flow>();
  const callback = `${options.origin}/auth/github/callback`;
  const initial = { config, store, settings };
  const api = async (path: string, token: string, repositoryId = config.repositoryId): Promise<any> => {
    const response = await fetcher(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    // GitHub redirects old names to an immutable repository ID after a rename.
    // Follow only this configured ID on api.github.com, never an arbitrary Location.
    if (response.status === 301 && /^\/repos\/[^/]+\/[^/?]+$/.test(path)
      && response.headers.get('location') === `https://api.github.com/repositories/${repositoryId}`) {
      return api(`/repositories/${repositoryId}`, token, repositoryId);
    }
    if ([401, 403, 404].includes(response.status)) throw new Denied();
    if (!response.ok) throw new Error('GitHub unavailable');
    return response.json();
  };
  const operator = (user: User) => (options.operators ?? []).includes(user.id);
  const listed = async (token: string, installationId: number) => {
    const repositories: { id: number; full_name: string; organization: boolean; installationId: number }[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await api(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, token);
      if (!Array.isArray(result.repositories)) throw new Error('Invalid GitHub response');
      for (const repo of result.repositories) {
        if (!Number.isSafeInteger(repo.id) || repo.id < 1 || typeof repo.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)) throw new Error('Invalid GitHub repository');
        repositories.push({ id: repo.id, full_name: repo.full_name, organization: repo.owner?.type === 'Organization', installationId });
      }
      if (result.repositories.length < 100) return repositories;
    }
    throw new Error('Installation exceeds pilot repository listing limit');
  };
  // Hosted mode: installation IDs come only from GitHub's list for this user, never from a
  // request or the install callback. An installation is approved once an operator connects
  // one of its repositories; operators also see installations nobody has approved yet.
  const installations = async (token: string, all: boolean) => {
    const approved = repositories!.installations(), ids: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await api(`/user/installations?per_page=100&page=${page}`, token);
      if (!Array.isArray(result.installations)) throw new Error('Invalid GitHub response');
      for (const installation of result.installations) {
        if (!Number.isSafeInteger(installation?.id) || installation.id < 1) throw new Error('Invalid GitHub installation');
        if (all || approved.has(installation.id)) ids.push(installation.id);
      }
      if (result.installations.length < 100) break;
      if (page === 3) throw new Error('User exceeds pilot installation listing limit');
    }
    // The bootstrap installation stays first, so existing defaults and links are unchanged.
    return ids.sort((a, b) => Number(b === config.installationId) - Number(a === config.installationId)).slice(0, 20);
  };
  const available = async (token: string, all = false) => {
    if (!repositories) return listed(token, config.installationId);
    const found = [];
    for (const id of await installations(token, all)) found.push(...await listed(token, id));
    return found;
  };
  const authorize = async (token: string, target = config, all = false) => {
    // Names and callback installation_id are never authority. Check canonical
    // identity, current admin permission, and user/installation intersection.
    const repo = await api(`/repos/${target.repository}`, token, target.repositoryId);
    if (repo.id !== target.repositoryId || repo.full_name !== target.repository || repo.permissions?.admin !== true) throw new Denied();
    if (!(await available(token, all)).some(r => r.id === target.repositoryId && r.full_name === target.repository && r.installationId === target.installationId)) throw new Denied();
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    let url: URL;
    try { url = new URL(request.url ?? '/', options.origin); }
    catch { json(response, 400, { error: 'Invalid request URL.' }); return true; }
    if (!url.pathname.startsWith('/api/review/') && !url.pathname.startsWith('/auth/github')) return false;
    for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
    for (const [key, value] of flows) if (value.expires <= Date.now()) flows.delete(key);
    const jar = cookies(request), sessionId = hash(jar.get(sessionCookie) ?? ''), session = sessions.get(sessionId);
    try {
      if (request.method === 'GET' && url.pathname === '/auth/github') {
        if (flows.size >= 100) { json(response, 429, { error: 'Sign-in is busy. Try again shortly.' }); return true; }
        const state = random(), verifier = random();
        const repository = url.searchParams.get('repository') ?? '', review = url.searchParams.get('review') ?? '';
        const returnTo = url.searchParams.getAll('repository').length === 1 && url.searchParams.getAll('review').length === 1
          && /^[1-9][0-9]{0,15}$/.test(repository) && /^[a-zA-Z0-9-]{1,100}$/.test(review)
          ? `/?repository=${repository}#review/${review}` : '/';
        flows.set(hash(state), { verifier, expires: Date.now() + 600_000, returnTo });
        response.setHeader('Set-Cookie', cookie(flowCookie, state, 600));
        const query = new URLSearchParams({ client_id: options.clientId, redirect_uri: callback, state,
          code_challenge: hash(verifier), code_challenge_method: 'S256' });
        redirect(response, `https://github.com/login/oauth/authorize?${query}`); return true;
      }
      if (request.method === 'GET' && url.pathname === '/auth/github/callback') {
        const state = url.searchParams.get('state') ?? '', code = url.searchParams.get('code');
        const flow = flows.get(hash(state));
        if (!flow || state !== jar.get(flowCookie) || !code || code.length > 500 || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
          redirect(response, '/?signin=expired'); return true;
        }
        flows.delete(hash(state));
        response.setHeader('Set-Cookie', cookie(flowCookie, '', 0));
        if (sessions.size >= 100) { redirect(response, '/?signin=busy'); return true; }
        const exchanged = await fetcher('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, code, redirect_uri: callback, code_verifier: flow.verifier, ...(repositories ? {} : { repository_id: String(initial.config.repositoryId) }) }), redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!exchanged.ok) throw new Error('Token exchange failed');
        const grant = await exchanged.json();
        if (typeof grant.access_token !== 'string' || !/^ghu_[a-zA-Z0-9]{10,255}$/.test(grant.access_token)
          || grant.token_type?.toLowerCase() !== 'bearer' || (grant.expires_in !== undefined && (!Number.isSafeInteger(grant.expires_in) || grant.expires_in < 1))) throw new Denied();
        const user = await api('/user', grant.access_token);
        if (!Number.isSafeInteger(user.id) || user.id < 1 || typeof user.login !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(user.login)) throw new Denied();
        if (repositories) {
          if (!operator(user) && !(await installations(grant.access_token, false)).length) throw new Denied();
        } else await authorize(grant.access_token);
        const id = random(), seconds = Math.min(3600, grant.expires_in ?? 3600);
        sessions.delete(sessionId);
        sessions.set(hash(id), { token: grant.access_token, user: { id: user.id, login: user.login }, expires: Date.now() + seconds * 1000 });
        response.setHeader('Set-Cookie', [cookie(sessionCookie, id, seconds), cookie(flowCookie, '', 0)]);
        redirect(response, flow.returnTo); return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/review/v1/session' && !session) {
        json(response, 200, { version, user: null }); return true;
      }
      if (!session) { json(response, 401, { error: 'Sign in with GitHub to continue.' }); return true; }
      if (request.method === 'POST') {
        if (request.headers.origin !== options.origin || request.headers['content-type'] !== 'application/json') {
          json(response, 403, { error: 'Reload this page before trying again.' }); return true;
        }
        if (url.pathname === '/api/review/v1/logout') {
          sessions.delete(sessionId); response.setHeader('Set-Cookie', cookie(sessionCookie, '', 0)); json(response, 200, { ok: true }); return true;
        }
      }
      let { config, store, settings } = initial;
      let connections;
      const all = operator(session.user);
      if (repositories) {
        const visible = await available(session.token, all);
        const bootstrap = visible.find(repo => repo.installationId === config.installationId);
        connections = { installationId: config.installationId,
          manageUrl: bootstrap ? `https://github.com/${bootstrap.organization ? `organizations/${encodeURIComponent(bootstrap.full_name.split('/')[0]!)}/` : ''}settings/installations/${config.installationId}` : 'https://github.com/settings/installations',
          ...(options.appSlug ? { installUrl: `https://github.com/apps/${options.appSlug}/installations/new` } : {}),
          maxRepositories: 10,
          repositories: visible.map(repo => ({ id: repo.id, name: repo.full_name, installationId: repo.installationId, connected: repositories.entries.has(repo.id) })) };
        const selected = url.searchParams.get('repository');
        if (url.searchParams.getAll('repository').length > 1 || (selected !== null && !/^[1-9][0-9]{0,15}$/.test(selected))) {
          json(response, 400, { error: 'Choose a repository.' }); return true;
        }
        if (request.method === 'POST' && url.pathname === '/api/review/v1/connect') {
          const candidate = visible.find(repo => repo.id === Number(selected));
          if (!candidate) throw new Denied();
          await authorize(session.token, { ...config, repositoryId: candidate.id, repository: candidate.full_name, installationId: candidate.installationId }, all);
          if (!repositories.entries.has(candidate.id) && repositories.entries.size >= 10) { json(response, 409, { error: 'The private pilot supports ten repositories.' }); return true; }
          const entry = repositories.connect(candidate.id, candidate.full_name, candidate.installationId);
          process.stderr.write(`atmin review: repository ${candidate.id} connected from installation ${candidate.installationId} by GitHub user ${session.user.id}\n`);
          json(response, 200, { repository: { id: entry.config.repositoryId, name: entry.config.repository, enabled: entry.store.enabled() } }); return true;
        }
        const isSession = request.method === 'GET' && url.pathname === '/api/review/v1/session';
        if (selected === null && !isSession) { json(response, 400, { error: 'Choose a repository.' }); return true; }
        let id = selected === null ? undefined : Number(selected);
        if (selected === null) for (const candidate of visible) {
          const entry = repositories.entries.get(candidate.id);
          if (!entry) continue;
          try { await authorize(session.token, entry.config, all); id = candidate.id; break; }
          catch (error) { if (!(error instanceof Denied)) throw error; }
        }
        const entry = id === undefined ? undefined : repositories.entries.get(id);
        if (!entry || !visible.some(repo => repo.id === id && repo.full_name === entry.config.repository)) {
          if (selected !== null) { json(response, 404, { error: 'Repository not available.' }); return true; }
          json(response, 200, { version, user: session.user, repository: null, connections }); return true;
        }
        ({ config, store, settings } = entry);
      }
      await authorize(session.token, config, all);
      const scopedApi = (path: string) => api(path, session.token, config.repositoryId);
      if (request.method === 'GET' && ['/api/review/v1/session', '/api/review/v1/dashboard'].includes(url.pathname)) {
        const [live, repositories] = await Promise.all([
          livePulls(config, scopedApi),
          verifiedRepositories(config, latestJobs(store), scopedApi),
        ]);
        json(response, 200, { version, user: session.user, ...(connections ? { connections } : {}),
          repository: { id: config.repositoryId, name: config.repository, installationId: config.installationId, enabled: store.enabled() },
          settings: settings.current(), models: settings.models.map(m => ({ id: m.id, label: m.label, provider: m.profile.provider, model: m.profile.model, maxUsd: m.profile.maxUsd })),
          limits: { maxReviewsPerDay: config.maxReviewsPerDay }, runs: history(config, store), pulls: pullViews(config, store, live, repositories),
          pullLimit: 100, checkedAt: new Date().toISOString() }); return true;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/review/v1/reviews/')) {
        const id = url.pathname.slice('/api/review/v1/reviews/'.length);
        const job = /^[a-zA-Z0-9-]{1,100}$/.test(id) ? store.get(id) : undefined;
        if (!job) { json(response, 404, { error: 'Review not found.' }); return true; }
        const [live, repositories] = await Promise.all([
          livePulls(config, scopedApi),
          verifiedRepositories(config, [job], scopedApi),
        ]);
        json(response, 200, { version, ...readReview(config, job, live.find(p => p.pr === job.pr), repositories),
          runs: history(config, store, job.pr) }); return true;
      }
      if (request.method === 'POST' && ['/api/review/v1/settings', '/api/review/v1/enabled'].includes(url.pathname)) {
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { json(response, 413, { error: 'Request too large.' }); return true; } chunks.push(chunk); }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { json(response, 400, { error: 'Invalid settings.' }); return true; }
        if (url.pathname.endsWith('/enabled')) {
          if (!value || typeof value.enabled !== 'boolean' || Object.keys(value).length !== 1) { json(response, 400, { error: 'Invalid repository selection.' }); return true; }
          store.enable(value.enabled); json(response, 200, { enabled: store.enabled() }); return true;
        }
        try { settings.validate(value); }
        catch { json(response, 400, { error: 'Choose an available model and stay within the displayed limits.' }); return true; }
        json(response, 200, { settings: settings.save(value) });
        return true;
      }
      json(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof Denied) { sessions.delete(sessionId); response.setHeader('Set-Cookie', cookie(sessionCookie, '', 0)); }
      if (url.pathname === '/auth/github/callback') redirect(response, `/?signin=${error instanceof Denied ? 'denied' : 'unavailable'}`);
      else json(response, error instanceof Denied ? 403 : 503, { error: error instanceof Denied ? 'Repository administrator access is required. Sign in again if your access changed.' : 'GitHub or the review service is unavailable. Try again shortly.' });
    }
    return true;
  };
}
