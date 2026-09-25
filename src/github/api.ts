import { sign } from 'node:crypto';
import type { ValidationCheck } from '../assessment.js';
import type { PilotConfig } from './config.js';
import type { PullState } from '../snapshot.js';

export interface LivePull extends PullState { draft: boolean; }
export interface Comment { id: number; body: string; user: { login: string; type: string }; }
export interface PullFile { filename: string; previous_filename?: string; patch?: string; }
export interface InlineComment { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; start_line?: number; start_side?: 'RIGHT'; }
export interface CheckOutput { status: 'in_progress' | 'completed'; conclusion?: 'success' | 'failure' | 'cancelled'; output: { title: string; summary: string }; details_url?: string; }
export interface GitHub {
  pull(pr: number): Promise<LivePull>;
  canReview(login: string): Promise<boolean>;
  readToken(): Promise<string>;
  validation(head: string, names: string[]): Promise<ValidationCheck[]>;
  summary(pr: number, marker: string): Promise<Comment | null>;
  create(pr: number, body: string): Promise<number>;
  update(id: number, body: string): Promise<void>;
  files(pr: number): Promise<PullFile[]>;
  findReview(pr: number, head: string, marker: string): Promise<number | null>;
  createReview(pr: number, head: string, body: string, comments: InlineComment[]): Promise<number>;
  findCheck(head: string, externalId: string): Promise<number | null>;
  createCheck(head: string, externalId: string, output: CheckOutput): Promise<number>;
  updateCheck(id: number, output: CheckOutput): Promise<void>;
}
export class GitHubError extends Error {
  constructor(readonly status: number) { super(`GitHub request failed (${status})`); }
}
export function appJwt(appId: string, key: string, now = Date.now()): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: appId })}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`;
}
export class AppGitHub implements GitHub {
  private tokens = new Map<string, { token: string; expires: number }>();
  private login: string | undefined;
  constructor(private config: PilotConfig, private appId: string, private key: string, private transport: typeof fetch = fetch) {}
  private async request(path: string, token: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await this.transport(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'atmin-review-pilot', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => { throw new GitHubError(0); });
    if (!response.ok) throw new GitHubError(response.status);
    // API response bodies/errors never enter logs, especially access-token responses.
    try { return await response.json(); } catch { throw new GitHubError(0); }
  }
  private async token(write: boolean | 'checks'): Promise<string> {
    const scope = write === 'checks' ? 'checks' : write ? 'write' : 'read';
    const cached = this.tokens.get(scope);
    if (cached && cached.expires > Date.now() + 120_000) return cached.token;
    const result = await this.request(`/app/installations/${this.config.installationId}/access_tokens`, appJwt(this.appId, this.key), 'POST', {
      repository_ids: [this.config.repositoryId],
      permissions: write === 'checks' ? { checks: 'write' } : write ? { pull_requests: 'write' } : { contents: 'read', pull_requests: 'read' },
    });
    if (typeof result.token !== 'string' || !result.token || !Number.isFinite(Date.parse(result.expires_at))) throw new Error('Invalid installation token response');
    this.tokens.set(scope, { token: result.token, expires: Date.parse(result.expires_at) });
    return result.token;
  }
  readToken(): Promise<string> { return this.token(false); }
  async verifyInstallation(): Promise<{ repository: string; bot: string }> {
    const data = await this.request(`/repos/${this.config.repository}`, await this.token(false));
    if (data.id !== this.config.repositoryId || data.full_name !== this.config.repository) throw new Error('Installation repository identity mismatch');
    // Minting the narrower publisher token checks granted permission without posting anything.
    await this.token(true);
    await this.token('checks');
    return { repository: data.full_name, bot: await this.botLogin() };
  }
  async pull(pr: number): Promise<LivePull> {
    const token = await this.token(false);
    const data = await this.request(`/repos/${this.config.repository}/pulls/${pr}`, token);
    if (data.base?.repo?.id !== this.config.repositoryId || data.base?.repo?.full_name !== this.config.repository || data.number !== pr) throw new Error('PR repository identity mismatch');
    const ref = await this.request(`/repos/${this.config.repository}/git/ref/heads/${encodeURIComponent(data.base.ref)}`, token);
    if (![data.head?.sha, ref.object?.sha].every(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)) || typeof data.base.ref !== 'string' || !['open', 'closed'].includes(data.state) || typeof data.draft !== 'boolean') throw new Error('Invalid live PR state');
    return { repository: this.config.repository, pr, headSha: data.head.sha, baseSha: ref.object.sha, baseRef: data.base.ref, state: data.state, draft: data.draft };
  }
  async canReview(login: string): Promise<boolean> {
    if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login)) return false;
    try {
      const data = await this.request(`/repos/${this.config.repository}/collaborators/${encodeURIComponent(login)}/permission`, await this.token(false));
      return ['write', 'maintain', 'admin'].includes(data.permission);
    } catch (error) { if (error instanceof GitHubError && error.status === 404) return false; throw error; }
  }
  private async botLogin(): Promise<string> {
    if (!this.login) {
      const app = await this.request('/app', appJwt(this.appId, this.key));
      if (typeof app.slug !== 'string' || !/^[a-z\d-]+$/.test(app.slug)) throw new Error('Invalid App identity');
      this.login = `${app.slug}[bot]`;
    }
    return this.login;
  }
  async summary(pr: number, marker: string): Promise<Comment | null> {
    const login = await this.botLogin();
    const token = await this.token(false);
    let found: Comment | null = null;
    for (let page = 1; page <= 20; page++) {
      const comments = await this.request(`/repos/${this.config.repository}/issues/${pr}/comments?per_page=100&page=${page}`, token);
      if (!Array.isArray(comments)) throw new Error('Invalid comment listing');
      for (const comment of comments) {
        if (comment.user?.login === login && comment.user?.type === 'Bot' && typeof comment.body === 'string' && comment.body.startsWith(`${marker}\n`)) {
          if (found || !Number.isSafeInteger(comment.id)) throw new Error('Ambiguous bot summary; operator reconciliation required');
          found = comment;
        }
      }
      if (comments.length < 100) return found;
    }
    throw new Error('Comment scan limit reached; no new comment created');
  }
  async create(pr: number, body: string): Promise<number> {
    const result = await this.request(`/repos/${this.config.repository}/issues/${pr}/comments`, await this.token(true), 'POST', { body });
    if (!Number.isSafeInteger(result.id)) throw new Error('Uncertain comment creation');
    return result.id;
  }
  async update(id: number, body: string): Promise<void> {
    await this.request(`/repos/${this.config.repository}/issues/comments/${id}`, await this.token(true), 'PATCH', { body });
  }
  async files(pr: number): Promise<PullFile[]> {
    const files: PullFile[] = [];
    for (let page = 1; page <= 11; page++) {
      const data = await this.request(`/repos/${this.config.repository}/pulls/${pr}/files?per_page=100&page=${page}`, await this.token(false));
      if (!Array.isArray(data) || data.some(f => typeof f.filename !== 'string'
        || (f.patch !== undefined && typeof f.patch !== 'string')
        || (f.previous_filename !== undefined && typeof f.previous_filename !== 'string'))) throw new Error('Invalid PR file listing');
      files.push(...data);
      if (files.length > 1000) throw new Error('Inline file scan limit reached');
      if (data.length < 100) return files;
    }
    throw new Error('Inline file scan limit reached');
  }
  async findReview(pr: number, head: string, marker: string): Promise<number | null> {
    const login = await this.botLogin();
    let found: number | null = null;
    for (let page = 1; page <= 20; page++) {
      const reviews = await this.request(`/repos/${this.config.repository}/pulls/${pr}/reviews?per_page=100&page=${page}`, await this.token(false));
      if (!Array.isArray(reviews)) throw new Error('Invalid review listing');
      for (const review of reviews) {
        if (review.user?.login === login && review.user?.type === 'Bot' && review.commit_id === head
          && typeof review.body === 'string' && review.body.startsWith(`${marker}\n`)) {
          if (found !== null || !Number.isSafeInteger(review.id) || review.id < 1 || review.state !== 'COMMENTED') throw new Error('Ambiguous inline review');
          found = review.id;
        }
      }
      if (reviews.length < 100) return found;
    }
    throw new Error('Review scan limit reached');
  }
  async createReview(pr: number, head: string, body: string, comments: InlineComment[]): Promise<number> {
    const review = await this.request(`/repos/${this.config.repository}/pulls/${pr}/reviews`, await this.token(true), 'POST',
      { commit_id: head, event: 'COMMENT', body, comments });
    if (!Number.isSafeInteger(review.id) || review.id < 1) throw new Error('Uncertain inline review creation');
    return review.id;
  }
  async validation(head: string, names: string[]): Promise<ValidationCheck[]> {
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid CI commit');
    const checks: ValidationCheck[] = [];
    for (const trusted of this.config.trustedChecks ?? []) {
      if (!names.includes(trusted.name)) continue;
      const missing: ValidationCheck = { name: trusted.name, status: 'not-run', reason: 'No completed check from the trusted GitHub App on this exact head.' };
      // The review App cannot attest its own required validation.
      if (String(trusted.appId) === this.appId) { checks.push(missing); continue; }
      try {
        const query = new URLSearchParams({ check_name: trusted.name, app_id: String(trusted.appId), filter: 'latest', per_page: '100' });
        const data = await this.request(`/repos/${this.config.repository}/commits/${head}/check-runs?${query}`, await this.token('checks'));
        // One head can carry several runs of the same check from the same App: a workflow on
        // both push and pull_request runs once per event (atmin-inc/review PR 9, 2026-09-25).
        // Every run must be completed; any failure fails, and only all successes pass.
        const runs = data.check_runs;
        if (!Array.isArray(runs) || !runs.length || data.total_count !== runs.length
          || runs.some(run => run.name !== trusted.name || run.app?.id !== trusted.appId || run.head_sha !== head
            || !Number.isSafeInteger(run.id) || run.id < 1 || run.status !== 'completed')) {
          checks.push(missing); continue;
        }
        const statusOf = (run: { conclusion: string }) => run.conclusion === 'success' ? 'pass'
          : ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(run.conclusion) ? 'fail' : 'not-run';
        const status = runs.some(run => statusOf(run) === 'fail') ? 'fail' : runs.every(run => statusOf(run) === 'pass') ? 'pass' : 'not-run';
        const run = runs.find(run => statusOf(run) === status) ?? runs[0];
        const more = runs.length > 1 ? ` (and ${runs.length - 1} more run${runs.length > 2 ? 's' : ''} of it on this head)` : '';
        checks.push({ name: trusted.name, status, reason: `GitHub App ${trusted.appId}, check ${run.id}${more}: ${status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : 'did not establish a pass'}.`,
          url: `https://github.com/${this.config.repository}/runs/${run.id}` });
      } catch { checks.push({ ...missing, reason: 'GitHub CI evidence could not be retrieved. Validation remains unverified.' }); }
    }
    return checks;
  }
  async findCheck(head: string, externalId: string): Promise<number | null> {
    const token = await this.token('checks');
    for (let page = 1; page <= 20; page++) {
      const data = await this.request(`/repos/${this.config.repository}/commits/${head}/check-runs?check_name=atmin%20review&filter=all&per_page=100&page=${page}`, token);
      if (!Array.isArray(data.check_runs)) throw new Error('Invalid check listing');
      const found = data.check_runs.filter((r: any) => String(r.app?.id) === this.appId && r.external_id === externalId && r.head_sha === head);
      if (found.length > 1) throw new Error('Ambiguous check creation');
      if (found.length === 1 && Number.isSafeInteger(found[0].id)) return found[0].id;
      if (data.check_runs.length < 100) return null;
    }
    throw new Error('Check scan limit reached');
  }
  async createCheck(head: string, externalId: string, output: CheckOutput): Promise<number> {
    const data = await this.request(`/repos/${this.config.repository}/check-runs`, await this.token('checks'), 'POST',
      { name: 'atmin review', head_sha: head, external_id: externalId, ...output });
    if (!Number.isSafeInteger(data.id)) throw new Error('Uncertain check creation');
    return data.id;
  }
  async updateCheck(id: number, output: CheckOutput): Promise<void> {
    await this.request(`/repos/${this.config.repository}/check-runs/${id}`, await this.token('checks'), 'PATCH', output);
  }
}
