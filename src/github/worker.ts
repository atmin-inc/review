import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePacket, parseResult, type Packet, type Finding } from '../contracts.js';
import { assess } from '../assessment.js';
import { compareCurrent } from '../snapshot.js';
import { readVerification, type Verification } from '../verification.js';
import { renderMarkdown, type ReviewPrice } from '../render.js';
import type { PilotConfig } from './config.js';
import { GitHubError, type GitHub, type LivePull } from './api.js';
import { DEFAULT_MIN_FREE_DISK_MB, freeDiskMb } from './runner.js';
import { Checks, assessmentCheck } from './checks.js';
import type { CheckOutput } from './api.js';
import { Store, AUTO_PAUSE_AFTER, type Job } from './store.js';
import type { ReviewSettings } from './settings.js';
import { dailyLimitReached, authorLimitReached, month } from './repositories.js';
import { InlineReviews } from './inline.js';
import { runnerLabel, type Outcome, type RunnerRow } from './runners.js';
import { Outcomes } from './outcomes.js';

// Why a job failed, kept on the job and in the log. On 2026-09-28 a finished 5/5 review's
// check turned "Review failed" after its comment was posted, and nothing said which step
// broke. A GitHub failure names its request; anything else is thrown by this code.
export function failureCause(error: unknown): string {
  if (error instanceof GitHubError) return `GitHub ${error.status || error.detail} on ${error.request}`;
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'non-error thrown';
}
const diskLow = 'The review service is low on disk space, so this review did not start. A maintainer can rerun with `/atmin review` once an atmin operator frees space. No inference was started.';
export const markerFor = (repo: number, pr: number): string => `<!-- atmin-review:${repo}:${pr} -->`;
// Where reviews run. The worker offers each review to a runner and collects its records on a
// later tick; it never waits on one. A runner is the PR author's own (`atmin-code-review-runner`,
// their own CLI subscription) or one of this service's (`--pool`, this service's model key).
export interface Dispatcher {
  ownRunner(author: number): RunnerRow | null;
  offer(job: Job, to: RunnerRow | 'pool', directory: string, previous: string | null): Promise<void>;
  // How the offer ended, or null while a runner may still deliver.
  poll(job: Job): Outcome | null;
  // Done with a job: collected, superseded, paused or failed. A runner holding it stops.
  close(job: Job): void;
  // Jobs of this repository offered to a runner and not yet closed.
  open(): string[];
}
const ranOn = (job: Job) => job.runner ? `\nRan on ${job.runner}, with the author's own subscription. atmin charged nothing for this review.\n`
  : job.modelKey === 'bedrock' ? `\nRan on this organization's own Amazon Bedrock key. atmin charged nothing for this review.\n` : '';
const same = (a: LivePull, b: LivePull) => a.headSha === b.headSha && a.baseSha === b.baseSha && a.baseRef === b.baseRef && a.state === b.state && a.draft === b.draft;
export class Worker {
  private checks: Checks;
  private inline: InlineReviews;
  private outcomes: Outcomes;
  private abort: AbortController | undefined;
  constructor(private config: PilotConfig, private store: Store, private github: GitHub, private dispatcher: Dispatcher, readonly owner: string, private settings?: ReviewSettings, private reserve: (job: Job, limit: number) => true | string = (job, limit) => store.reserve(job, owner, limit) || dailyLimitReached, private dashboardOrigin?: string,
    private price?: (job: Job) => ReviewPrice | null) {
    this.checks = new Checks(store, github); this.inline = new InlineReviews(store, github); this.outcomes = new Outcomes(store, github, config.repositoryId);
  }
  stop(): void { this.abort?.abort(); }
  async tick(): Promise<boolean> {
    // A review superseded or paused while a runner held it: the runner is told to stop, and the
    // check and summary say what happened, as for a review this worker was running.
    for (const id of this.dispatcher.open()) {
      const held = this.store.get(id) ?? { id } as Job;
      if (held.state === 'dispatched') continue;
      this.dispatcher.close(held);
      if (held.state === 'cancelled') await this.cancelled(held).catch(error => process.stderr.write(`atmin review: settling cancelled review ${id} failed: ${failureCause(error)}\n`));
    }
    for (const job of this.store.dispatched()) {
      if (!this.store.current(job, this.owner)) continue;
      const outcome = this.dispatcher.poll(job);
      if (outcome === null) continue;
      await this.guarded(job, async signal => { if (await this.collect(job, outcome, signal)) await this.publish(this.store.get(job.id), signal); });
      return true;
    }
    const job = this.store.next(this.owner);
    if (!job) return false;
    // How long a review waited to be started: the signal that the service needs more workers.
    if (job.state === 'running') process.stderr.write(`atmin review: review ${job.id} of repository ${this.config.repositoryId} started after ${Math.round((Date.now() - job.created) / 1000)} s in the queue\n`);
    await this.guarded(job, signal => this.work(job, signal));
    return true;
  }
  private async guarded(job: Job, step: (signal: AbortSignal) => Promise<void>): Promise<void> {
    this.abort = new AbortController();
    const monitor = setInterval(() => { if (!this.store.current(job, this.owner)) this.abort?.abort(); }, 250);
    try { await step(this.abort.signal); }
    catch (error) {
      const cause = failureCause(error);
      process.stderr.write(`atmin review: review ${job.id} of PR ${job.pr} failed: ${cause}\n`);
      if (this.store.current(job, this.owner)) this.store.update(job.id, { state: 'failed', error: `service-or-github-failure (${cause}); inspect private artifacts, rerun explicitly` });
      if (this.store.owns(this.owner)) await this.checks.stop(job, 'failure', 'Review failed').catch(() => {});
    } finally {
      clearInterval(monitor); this.abort = undefined;
      if (this.store.get(job.id).state === 'cancelled') { this.dispatcher.close(job); await this.cancelled(job); }
      if (this.store.owns(this.owner) && this.store.get(job.id).state === 'uncertain') await this.checks.stop(job, 'failure', 'Review publication uncertain').catch(() => {});
    }
  }
  private async cancelled(job: Job): Promise<void> {
    if (!this.store.owns(this.owner)) return;
    await this.checks.stop(job, 'cancelled', 'Review superseded or paused').catch(() => {});
    if (this.store.enabled()) return;
    const marker = markerFor(this.config.repositoryId, job.pr);
    const existing = await this.github.summary(job.pr, marker);
    if (existing && this.store.owns(this.owner) && !this.store.enabled()) {
      await this.github.update(existing.id, `${marker}\n# atmin review — review paused\n\nThe operator paused this review. No active review or completed result is claimed for this request. Previous findings are historical. After re-enabling the service, a maintainer can request a new run with \`/atmin review\`.`);
    }
  }
  private async work(job: Job, signal: AbortSignal): Promise<void> {
    const initial = await this.github.pull(job.pr);
    const detailsUrl = this.dashboardOrigin ? `${this.dashboardOrigin}/?repository=${this.config.repositoryId}#review/${job.id}` : undefined;
    if (!this.store.current(job, this.owner) || signal.aborted) return;
    this.store.track(job.pr, initial.baseRef, initial.state === 'open' && !initial.draft);
    if (job.author !== initial.author.id) this.store.update(job.id, { author: initial.author.id });
    const marker = markerFor(this.config.repositoryId, job.pr);
    if (initial.state !== 'open' || initial.draft) {
      const existing = await this.github.summary(job.pr, marker);
      if (existing && this.store.current(job, this.owner)) await this.github.update(existing.id, `${marker}\n# atmin review — inactive\n\nPR is ${initial.draft ? 'a draft' : 'closed'}. Previous findings are historical. No merge approval.`);
      if (this.store.current(job, this.owner)) this.store.update(job.id, { state: 'skipped', error: initial.draft ? 'draft' : 'closed' });
      // Only a closed PR shows what became of its findings. Reading it never fails the job.
      if (initial.state === 'closed' && this.store.owns(this.owner)) await this.outcomes.record(job.pr, initial)
        .catch(error => process.stderr.write(`atmin review: recording outcomes of PR ${job.pr} in repository ${this.config.repositoryId} failed: ${failureCause(error)}\n`));
      return;
    }
    if (job.state !== 'publishing' && job.trigger === 'event') {
      // Automatic reviews pause after AUTO_PAUSE_AFTER reviewed heads. The last summary stays,
      // under a banner saying which head it describes, because it is the most recent review.
      const heads = this.store.reviewedHeads(job.pr);
      if (heads.length >= AUTO_PAUSE_AFTER && !heads.includes(initial.headSha)) {
        const existing = await this.github.summary(job.pr, marker);
        if (existing && this.store.current(job, this.owner)) {
          const previous = existing.body.slice(marker.length + 1).replace(/^<!-- atmin-paused -->[\s\S]*?<!-- \/atmin-paused -->\n/, '');
          await this.github.update(existing.id, `${marker}\n<!-- atmin-paused -->\n> **Automatic reviews paused** after ${heads.length} reviews of this PR. The review below describes an earlier head, not \`${initial.headSha}\`. Comment \`/atmin review\` for a full review of the current head.\n<!-- /atmin-paused -->\n${previous}`);
        }
        if (this.store.current(job, this.owner)) this.store.update(job.id, { state: 'skipped', error: 'auto-paused' });
        return;
      }
    }
    if (job.state !== 'publishing') {
      // Retire an earlier verdict as soon as replacement work starts. Create only the final summary.
      const existing = await this.github.summary(job.pr, marker);
      if (existing && this.store.current(job, this.owner)) {
        this.store.creationConfirmed(job.pr, existing.id);
        await this.github.update(existing.id, `${marker}\n# atmin review — review pending\n\nA review was requested for head \`${initial.headSha}\` against target \`${initial.baseSha}\`. No completed report is available for this request. Previous findings are historical. This review is advisory.`);
      }
      if (!this.store.current(job, this.owner) || signal.aborted) return;
      let report: string;
      let check: CheckOutput = { status: 'completed', conclusion: 'failure', output: { title: 'Review incomplete', summary: 'No completed review is available. See the PR summary.' } };
      // Save interruption context before starting the remote check.
      this.store.update(job.id, { report: JSON.stringify({ initial, body: '# atmin review — interrupted\n\nReview did not finish.', check }) });
      await this.checks.publish(job, initial.headSha, { status: 'in_progress', output: { title: 'Review in progress', summary: `Reviewing head ${initial.headSha} against target ${initial.baseSha}.` } });
      if (!this.store.current(job, this.owner) || signal.aborted) return;
      const preferences = this.settings?.current(), now = Date.now();
      const freeMb = freeDiskMb(this.config.stateDirectory), floorMb = this.config.minFreeDiskMb ?? DEFAULT_MIN_FREE_DISK_MB;
      const disk = freeMb < floorMb ? { reason: diskLow, detail: `${freeMb} MB free on the state disk, below ${floorMb} MB` } : null;
      // The author's own runner costs this service nothing, so no plan, credit or author limit applies.
      const own = disk ? null : this.dispatcher.ownRunner(initial.author.id);
      const onOwn = own !== null && this.store.reserveOnRunner(job, this.owner, runnerLabel(own));
      if (disk) process.stderr.write(`atmin review: review ${job.id} of repository ${this.config.repositoryId} not started: ${disk.detail}\n`);
      const reserved = disk ? disk.reason : onOwn ? true : this.reserveHosted(job, initial, preferences, now);
      if (reserved !== true) {
        if (!this.store.current(job, this.owner)) return;
        this.store.update(job.id, { state: 'publishing', report: JSON.stringify({ initial, body: `# atmin review — review not run\n\n${reserved}${this.identity(initial, job)}`, check }) });
      } else {
        const artifact = join(this.config.stateDirectory, 'runs', job.id);
        mkdirSync(artifact, { recursive: true, mode: 0o700 });
        // A crash publishes this honest interruption report; it never starts another model request.
        this.store.update(job.id, { artifact, report: JSON.stringify({ initial, check,
          body: `# atmin review — interrupted\n\nThe worker stopped before it saved a validated report. No completed review is claimed. A maintainer can explicitly rerun.${this.identity(initial, job)}`,
        }) });
        // Read again: the reservation recorded whose model key the review runs on.
        await this.dispatcher.offer(this.store.get(job.id), own && onOwn ? own : 'pool', artifact, this.store.previous(job));
        if (!this.store.current(job, this.owner) || signal.aborted) return;
        this.store.update(job.id, { state: 'dispatched' });
        process.stderr.write(`atmin review: review ${job.id} of repository ${this.config.repositoryId} offered to ${own && onOwn ? `runner ${own.id}` : 'the hosted runners'}\n`);
        // A runner may already have delivered (tests deliver at once); otherwise a later tick collects.
        const outcome = this.dispatcher.poll(job);
        if (outcome === null || !await this.collect(this.store.get(job.id), outcome, signal)) return;
      }
      job = this.store.get(job.id);
    }
    await this.publish(job, signal);
  }
  // Header line that ties a report to the exact commits it describes.
  private identity(initial: LivePull, job: Job): string { return `\n\nHead: \`${initial.headSha}\` · Target: \`${initial.baseSha}\` · Run: \`${job.id}\`\n`; }
  // A hosted review counts toward the plan, credit and the repository's limits.
  private reserveHosted(job: Job, initial: LivePull, preferences: ReturnType<ReviewSettings['current']> | undefined, now: number): true | string {
    const perAuthor = preferences?.maxReviewsPerAuthor ?? null;
    const authorUsed = perAuthor === null ? 0 : this.store.authorReviews(initial.author.id, month(now).start);
    if (perAuthor !== null && authorUsed >= perAuthor) {
      process.stderr.write(`atmin review: review ${job.id} of repository ${this.config.repositoryId} not started: author ${initial.author.id} used ${authorUsed} of ${perAuthor} monthly reviews\n`);
      return authorLimitReached(initial.author.login, perAuthor, now);
    }
    return this.reserve(job, preferences?.maxReviewsPerDay ?? this.config.maxReviewsPerDay);
  }
  // Turns a runner's delivery into the report to publish. Returns false while the runner may
  // still deliver, or when the job was handed to this service's runners instead.
  private async collect(job: Job, outcome: Outcome, signal: AbortSignal): Promise<boolean> {
    const saved = JSON.parse(job.report!) as { initial: LivePull; check: CheckOutput };
    const { initial } = saved;
    let check = saved.check, report: string, refused = false;
    if (outcome !== 'done' && job.runner) {
      // Decision (Lors, 2026-10-01): a PR whose own runner does not deliver is reviewed by this
      // service's runners, as any other review.
      process.stderr.write(`atmin review: review ${job.id} of repository ${this.config.repositoryId} on ${job.runner}: ${outcome}; offering it to the hosted runners\n`);
      rmSync(job.artifact!, { recursive: true, force: true }); mkdirSync(job.artifact!, { recursive: true, mode: 0o700 });
      this.store.releaseRunner(job);
      const reserved = this.reserveHosted(job, initial, this.settings?.current(), Date.now());
      if (reserved === true) {
        await this.dispatcher.offer(this.store.get(job.id), 'pool', job.artifact!, this.store.previous(job));
        return false;
      }
      report = `# atmin review — review not run\n\n${reserved}`;
      refused = true;
    } else if (outcome !== 'done') {
      process.stderr.write(`atmin review: review ${job.id} of repository ${this.config.repositoryId}: hosted runner ${outcome}\n`);
      report = outcome === 'unclaimed'
        ? '# atmin review — review failed\n\nNo reviewer was free to take this review. No successful review or merge approval is claimed. A maintainer may request a new run with `/atmin review`.'
        : '# atmin review — review failed\n\nSource capture or investigation did not produce a validated report. No successful review or merge approval is claimed. A maintainer may request a new run with `/atmin review`; it uses a new budget reservation.';
    } else {
      try {
        const packet = parsePacket(JSON.parse(readFileSync(join(job.artifact!, 'packet.json'), 'utf8')));
        const result = parseResult(JSON.parse(readFileSync(join(job.artifact!, 'result.json'), 'utf8')));
        const live = await this.github.pull(job.pr);
        if (packet.repository !== this.config.repository || packet.pr !== job.pr || compareCurrent(packet, live).status !== 'current' || live.draft || !same(initial, live)) {
          this.cancel(job); return false;
        }
        const assessment = assess(packet, result, compareCurrent(packet, live));
        const detailsUrl = this.dashboardOrigin ? `${this.dashboardOrigin}/?repository=${this.config.repositoryId}#review/${job.id}` : undefined;
        report = renderMarkdown(packet, result, assessment, detailsUrl);
        check = assessmentCheck(assessment);
      } catch {
        report = '# atmin review — review failed\n\nSource capture or investigation did not produce a validated report. No successful review or merge approval is claimed. A maintainer may request a new run with `/atmin review`; it uses a new budget reservation.';
      }
    }
    this.dispatcher.close(job);
    if (!this.store.current(job, this.owner) || signal.aborted) return false;
    // Persist the report and its exact publication identity before any write.
    this.store.update(job.id, { state: 'publishing', artifact: refused ? null : job.artifact, report: JSON.stringify({ initial, body: report + this.identity(initial, job), check }) });
    return true;
  }
  private async publish(job: Job, signal: AbortSignal): Promise<void> {
    const marker = markerFor(this.config.repositoryId, job.pr);
    const detailsUrl = this.dashboardOrigin ? `${this.dashboardOrigin}/?repository=${this.config.repositoryId}#review/${job.id}` : undefined;
    const saved = JSON.parse(job.report!) as { initial: LivePull; body: string; check?: CheckOutput };
    let inline: { packet: Packet; findings: Finding[]; verification: Verification } | undefined;
    if (!same(saved.initial, await this.github.pull(job.pr))) { this.cancel(job); return; }
    // Reconciliation refreshes CI and formatting from saved source evidence, without inference.
    if (job.artifact && existsSync(join(job.artifact, 'packet.json')) && existsSync(join(job.artifact, 'result.json'))) {
      const packet = parsePacket(JSON.parse(readFileSync(join(job.artifact, 'packet.json'), 'utf8')));
      const result = parseResult(JSON.parse(readFileSync(join(job.artifact, 'result.json'), 'utf8')));
      const live = await this.github.pull(job.pr);
      if (packet.repository !== this.config.repository || packet.pr !== job.pr || !same(saved.initial, live)
        || compareCurrent(packet, live).status !== 'current') { this.cancel(job); return; }
      const ci = await this.github.validation(packet.headSha, packet.policy.requiredChecks);
      const verification = readVerification(job.artifact, packet, result.findings);
      const assessment = assess(packet, result, compareCurrent(packet, live), [...ci, ...verification.checks]);
      inline = { packet, findings: assessment.findings, verification };
      if (!this.store.current(job, this.owner) || signal.aborted) return;
      writeFileSync(join(job.artifact, 'validation.json'), JSON.stringify({ headSha: packet.headSha, baseSha: packet.baseSha,
        checkedAt: new Date().toISOString(), checks: [...ci, ...verification.checks] }, null, 2), { mode: 0o600 });
      saved.body = `${renderMarkdown(packet, result, assessment, detailsUrl, verification, this.price?.(job) ?? undefined)}${ranOn(job)}\nRun: \`${job.id}\`\n`;
      saved.check = assessmentCheck(assessment);
      this.store.update(job.id, { report: JSON.stringify(saved) });
    }
    const existing = await this.github.summary(job.pr, marker);
    if (!this.store.current(job, this.owner) || signal.aborted) return;
    // Listing comments can take time; recheck commits immediately before publication.
    if (!same(saved.initial, await this.github.pull(job.pr))) { this.cancel(job); return; }
    if (!this.store.current(job, this.owner) || signal.aborted) return;
    const limited = saved.body.length > 58_000 ? `${saved.body.slice(0, 58_000)}\n\n**Report truncated for GitHub. Full evidence remains in the operator’s private run artifacts.**` : saved.body;
    const body = `${marker}\n${limited}\n\nFreshness was checked immediately before publication at ${new Date().toISOString()}; GitHub writes are not atomic with PR updates.\n`;
    let comment: number;
    if (existing) {
      this.store.creationConfirmed(job.pr, existing.id);
      await this.github.update(existing.id, body);
      comment = existing.id;
    } else {
      if (this.store.uncertainCreate(job.pr)) {
        this.store.update(job.id, { state: 'uncertain', error: 'earlier-create-uncertain; reconcile publication without repeating inference' }); return;
      }
      this.store.update(job.id, { createStarted: 1 });
      try {
        comment = await this.github.create(job.pr, body);
        this.store.creationConfirmed(job.pr, comment);
      } catch {
        if (this.store.current(job, this.owner)) this.store.update(job.id, { state: 'uncertain', error: 'comment-create-uncertain; reconcile publication without repeating inference' });
        return;
      }
    }
    const after = await this.github.pull(job.pr);
    if (!this.store.current(job, this.owner) || !same(saved.initial, after)) {
      // This worker owns publication until the request completes. Do not write after losing its lease.
      if (this.store.owns(this.owner)) await this.github.update(comment, `${marker}\n# atmin review — superseded\n\nPR state changed during publication. Findings for head \`${saved.initial.headSha}\` are historical. Await a review of the current commits.`);
      this.cancel(job); return;
    }
    if (inline) await this.inline.publish(job, inline.packet, inline.findings, async () => {
      const live = await this.github.pull(job.pr);
      return this.store.current(job, this.owner) && !signal.aborted && same(saved.initial, live);
    }, inline.verification);
    if (!this.store.current(job, this.owner) || !same(saved.initial, await this.github.pull(job.pr))) {
      if (this.store.owns(this.owner)) await this.github.update(comment, `${marker}\n# atmin review — superseded\n\nPR state changed during inline publication. Findings for head \`${saved.initial.headSha}\` are historical. Await a review of the current commits.`);
      this.cancel(job); return;
    }
    await this.checks.publish(job, saved.initial.headSha, { ...(saved.check ?? { status: 'completed', conclusion: 'failure', output: { title: 'Review incomplete', summary: 'Saved review has no passing check assessment. See the PR summary.' } }), details_url: `https://github.com/${this.config.repository}/pull/${job.pr}#issuecomment-${comment}` });
    if (!this.store.current(job, this.owner) || !same(saved.initial, await this.github.pull(job.pr))) {
      if (this.store.owns(this.owner)) await this.github.update(comment, `${marker}\n# atmin review — superseded\n\nPR state changed during check publication. Findings for head \`${saved.initial.headSha}\` are historical. Await a review of the current commits.`);
      this.cancel(job); return;
    }
    this.store.update(job.id, { state: 'completed', error: null });
  }
  private cancel(job: Job): void {
    if (this.store.owns(this.owner)) this.store.update(job.id, { state: 'cancelled', error: 'superseded' });
  }
}
