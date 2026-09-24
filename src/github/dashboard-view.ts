import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readVerification } from '../verification.js';
import { parseProfile } from '../investigation.js';
import { parsePacket, parseResult } from '../contracts.js';
import { assess, reviewSummary, unverified, type ValidationCheck } from '../assessment.js';
import { compareCurrent } from '../snapshot.js';
import type { PilotConfig } from './config.js';
import type { Store, Job } from './store.js';

// Only this review-owned projection reads worker state. Raw provider responses,
// artifact paths, access tokens and operator errors never cross the HTTP boundary.
export function runView(config: PilotConfig, job: Job) {
  let head: string | null = null, verdict: string | null = null;
  try {
    const report = JSON.parse(job.report ?? 'null');
    if (/^[a-f0-9]{40}$/.test(report?.initial?.headSha)) head = report.initial.headSha;
    const title = report?.check?.output?.title;
    if (job.state === 'completed' && ['Changes needed', 'Review incomplete', 'Validation needed', 'Superseded', 'Unverified', 'Suggestions', 'No issues found'].includes(title)) verdict = title;
  } catch { /* Older interrupted runs may have no report. */ }
  let usage: { model: string; knownUsd: number; totalUsd: number | null; unsettledCalls: number; calls: number } | null = null;
  if (job.artifact) try {
    const bytes = readFileSync(join(job.artifact, 'receipt.json'));
    if (bytes.length > 2_000_000) throw new Error('Receipt too large');
    const receipt = JSON.parse(bytes.toString('utf8'));
    const profile = parseProfile(receipt.profile);
    if (!Array.isArray(receipt.calls)) throw new Error('Invalid receipt');
    let knownUsd = 0, unsettledCalls = 0;
    for (const call of receipt.calls) {
      if (call.meteredUsd === null) unsettledCalls++;
      else if (typeof call.meteredUsd === 'number' && Number.isFinite(call.meteredUsd) && call.meteredUsd >= 0) knownUsd += call.meteredUsd;
      else throw new Error('Invalid cost');
    }
    if (!Number.isFinite(knownUsd)) throw new Error('Invalid cost total');
    usage = { model: profile.model, knownUsd, totalUsd: unsettledCalls || !receipt.finishedAt ? null : knownUsd, unsettledCalls, calls: receipt.calls.length };
  } catch { /* Unknown is not zero, including interrupted receipt writes. */ }
  return { id: job.id, pr: job.pr, state: job.state, createdAt: new Date(job.created).toISOString(), started: job.started !== null,
    head, verdict, usage, url: `https://github.com/${config.repository}/pull/${job.pr}` };
}

export function history(config: PilotConfig, store: Store, pr?: number) {
  const jobs = (pr === undefined
    ? store.db.prepare('SELECT * FROM jobs ORDER BY created DESC, rowid DESC LIMIT 30').all()
    : store.db.prepare('SELECT * FROM jobs WHERE pr=? ORDER BY created DESC, rowid DESC LIMIT 30').all(pr)) as unknown as Job[];
  return jobs.map(job => runView(config, job));
}

interface Pull {
  repository: string; pr: number; title: string; author: string; state: 'open' | 'closed';
  merged: boolean; draft: boolean; headSha: string; baseSha: string; baseRef: string;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export async function livePulls(config: PilotConfig, api: (path: string) => Promise<any>): Promise<Pull[]> {
  // ponytail: pilot lists the 100 most recently updated PRs. Add pagination when a workspace exceeds this window.
  const values = await api(`/repos/${config.repository}/pulls?state=all&sort=updated&direction=desc&per_page=100`);
  if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid PR list');
  const pulls = values.map(p => {
    if (!Number.isSafeInteger(p.number) || p.number < 1 || typeof p.title !== 'string' || p.title.length > 1000
      || typeof p.user?.login !== 'string' || !/^[a-zA-Z0-9-]{1,39}(?:\[bot\])?$/.test(p.user.login)
      || !['open', 'closed'].includes(p.state) || typeof p.draft !== 'boolean' || !sha(p.head?.sha)
      || typeof p.base?.ref !== 'string' || p.base.repo?.id !== config.repositoryId || p.base.repo?.full_name !== config.repository) throw new Error('Invalid PR');
    return { repository: config.repository, pr: p.number, title: p.title, author: p.user.login,
      state: p.state, merged: Boolean(p.merged_at), draft: p.draft, headSha: p.head.sha, baseSha: '', baseRef: p.base.ref } as Pull;
  });
  const bases = new Map<string, string>();
  await Promise.all([...new Set(pulls.filter(p => p.state === 'open').map(p => p.baseRef))].map(async ref => {
    const value = await api(`/repos/${config.repository}/git/ref/heads/${encodeURIComponent(ref)}`);
    if (value.object?.type !== 'commit' || !sha(value.object.sha)) throw new Error('Invalid target ref');
    bases.set(ref, value.object.sha);
  }));
  return pulls.map(p => ({ ...p, baseSha: bases.get(p.baseRef) ?? '' }));
}

function artifact(job: Job, file: string): any {
  if (!job.artifact) throw new Error('No artifact');
  const path = join(job.artifact, file);
  if (statSync(path).size > 16_000_000) throw new Error('Artifact too large');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function failureReason(job: Job): string {
  if (job.state === 'skipped' && job.error === 'auto-paused') return 'Automatic reviews paused after five reviews of this PR. Comment /atmin review for a full review.';
  if (job.state === 'skipped') return 'No review was started for this event. Draft and closed PRs do not trigger automatic reviews.';
  if (job.state === 'cancelled') return 'This run was cancelled. A newer commit or a pause can cancel a review.';
  if (job.state === 'uncertain') return 'GitHub publication could not be confirmed. Check the PR before requesting another review.';
  if (['queued', 'running', 'publishing'].includes(job.state)) return 'This review is still in progress. Refresh to check its status.';
  try {
    const receipt = artifact(job, 'receipt.json');
    const reasons: Record<string, string> = {
      funding: 'The model provider needs funding. Check API credits before requesting another review.',
      authentication: 'The model provider rejected access. The operator needs to check the configured key.',
      'rate-limit': 'The model provider reached its rate limit. Wait before requesting another review.',
      request: 'The model provider rejected the request. The operator needs to check model compatibility.',
      unavailable: 'The model provider was unavailable. Check its status before requesting another review.',
    };
    const providerReason = reasons[receipt.providerFailure?.kind];
    if (providerReason) return providerReason;
    const reason = typeof receipt.stopReason === 'string' ? receipt.stopReason : '';
    if (/^(Budget cannot|Provider exceeded)/.test(reason)) return 'The review reached its spending boundary before finishing. Inspect the budget in Repositories before trying again.';
    if (/^(Model turn limit|Tool call limit|Review deadline|Review cancelled)/.test(reason)) return 'The investigation reached a run limit or was interrupted before finishing.';
    if (/^Provider (response|returned)/.test(reason)) return 'The model did not return a complete usable response. Inspect the selected model before trying again.';
  } catch { /* Only fixed, controller-owned explanations cross this boundary. */ }
  return 'Complete review evidence is unavailable. Check the PR and service status before requesting another review.';
}

export function readReview(config: PilotConfig, job: Job, live?: Pull, repositories: ReadonlySet<string> = new Set([config.repository])) {
  const run = runView(config, job);
  try {
    const packet = parsePacket(artifact(job, 'packet.json')), result = parseResult(artifact(job, 'result.json'));
    if (!repositories.has(packet.repository) || packet.pr !== job.pr) throw new Error('Snapshot ownership mismatch');
    let checks: ValidationCheck[] = [], validationAt: string | null = null;
    try {
      const saved = artifact(job, 'validation.json');
      if (saved.headSha !== packet.headSha || saved.baseSha !== packet.baseSha || !Array.isArray(saved.checks)
        || typeof saved.checkedAt !== 'string' || !Number.isFinite(Date.parse(saved.checkedAt))) throw new Error('Invalid validation');
      checks = saved.checks.map((c: any) => {
        if (typeof c.name !== 'string' || typeof c.reason !== 'string' || !['pass', 'fail', 'not-run', 'not-applicable'].includes(c.status)) throw new Error('Invalid check');
        return { name: c.name, status: c.status, reason: c.reason };
      });
      validationAt = saved.checkedAt;
    } catch { /* Assessment falls back to the captured evidence, never invents a pass. */ }
    // A renamed repository is the same source only after GitHub confirms its numeric ID.
    // Keep captured evidence unchanged; normalize identity just for the live comparison.
    const assessment = assess(packet, result, live ? compareCurrent({ ...packet, repository: config.repository }, live) : unverified(), checks);
    const verification = readVerification(job.artifact!, packet, result.findings);
    const findings = assessment.findings.map(f => ({ ...f,
      ...(f.fix ? { fix: { ...f.fix, checks: verification.fixes.find(fix => fix.findingId === f.id)?.checks ?? [] } } : {}),
      url: `https://github.com/${config.repository}/blob/${f.anchor.side === 'head' ? packet.headSha : packet.mergeBaseSha}/${f.anchor.path.split('/').map(encodeURIComponent).join('/')}#L${f.anchor.line}`,
      evidence: result.evidence.filter(e => f.evidenceIds.includes(e.id)).map(e => ({ id: e.id, kind: e.kind, summary: e.summary })),
    }));
    return { run, pull: live ?? null, report: { summary: reviewSummary(assessment), reviewer: result.reviewer,
      head: packet.headSha, base: packet.baseSha, baseRef: packet.baseRef, assessment: { ...assessment, findings },
      coverage: result.coverage.map(c => ({ path: c.path, status: c.status })), validationAt, limitations: result.limitations },
      reason: result.status !== 'completed' || job.state !== 'completed' ? failureReason(job) : null };
  } catch {
    return { run, pull: live ?? null, report: null, reason: failureReason(job) };
  }
}

export function latestJobs(store: Store): Job[] {
  // A draft-push skip must not erase a prior review; a newer failed attempt must.
  return store.db.prepare(`SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY pr ORDER BY (state='skipped'), created DESC, rowid DESC) AS rank
    FROM jobs) WHERE rank=1 ORDER BY created DESC LIMIT 100`).all() as unknown as Job[];
}

export async function verifiedRepositories(config: PilotConfig, jobs: Job[], api: (path: string) => Promise<any>) {
  const names = new Set<string>();
  for (const job of jobs) try {
    const packet = parsePacket(artifact(job, 'packet.json'));
    if (packet.pr === job.pr && packet.repository !== config.repository) names.add(packet.repository);
  } catch { /* Missing or corrupt evidence is rendered unavailable. */ }
  const verified = new Set([config.repository]);
  await Promise.all([...names].map(async name => {
    const repo = await api(`/repos/${name}`);
    if (repo.id === config.repositoryId && repo.full_name === config.repository) verified.add(name);
  }));
  return verified;
}

export function pullViews(config: PilotConfig, store: Store, live: Pull[], repositories?: ReadonlySet<string>) {
  const jobs = latestJobs(store);
  const numbers = [...new Set([...live.map(p => p.pr), ...jobs.map(j => j.pr)])];
  return numbers.map(pr => {
    const pull = live.find(p => p.pr === pr), job = jobs.find(j => j.pr === pr);
    const detail = job ? readReview(config, job, pull, repositories) : null;
    const assessment = detail?.report?.assessment;
    const verdict = job?.state === 'completed' ? assessment?.outcome ?? 'Review incomplete' : null;
    return { pr, title: pull?.title ?? `Pull request #${pr}`, author: pull?.author ?? null,
      state: pull ? pull.merged ? 'merged' : pull.draft && pull.state === 'open' ? 'draft' : pull.state : 'unknown',
      url: `https://github.com/${config.repository}/pull/${pr}`, run: detail ? { ...detail.run, verdict } : null,
      counts: assessment ? Object.fromEntries(['P0', 'P1', 'P2', 'P3', 'P4'].map(p => [p, assessment.findings.filter(f => f.priority === p).length])) : null,
      coverage: detail?.report ? { reviewed: detail.report.coverage.filter(c => c.status === 'reviewed').length, total: detail.report.coverage.length } : null,
    };
  });
}
