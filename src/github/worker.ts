import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePacket, parseResult } from '../contracts.js';
import { assess } from '../assessment.js';
import { compareCurrent } from '../snapshot.js';
import { renderMarkdown } from '../render.js';
import type { PilotConfig } from './config.js';
import type { GitHub, LivePull } from './api.js';
import type { Runner } from './runner.js';
import { Checks, assessmentCheck } from './checks.js';
import type { CheckOutput } from './api.js';
import { Store, type Job } from './store.js';

export const markerFor = (repo: number, pr: number): string => `<!-- atmin-review:${repo}:${pr} -->`;
const same = (a: LivePull, b: LivePull) => a.headSha === b.headSha && a.baseSha === b.baseSha && a.baseRef === b.baseRef && a.state === b.state && a.draft === b.draft;
export class Worker {
  private checks: Checks;
  private abort: AbortController | undefined;
  constructor(private config: PilotConfig, private store: Store, private github: GitHub, private run: Runner, readonly owner: string) { this.checks = new Checks(store, github); }
  stop(): void { this.abort?.abort(); }
  async tick(): Promise<boolean> {
    const job = this.store.next(this.owner);
    if (!job) return false;
    this.abort = new AbortController();
    const monitor = setInterval(() => { if (!this.store.current(job, this.owner)) this.abort?.abort(); }, 250);
    try { await this.work(job, this.abort.signal); }
    catch {
      if (this.store.current(job, this.owner)) this.store.update(job.id, { state: 'failed', error: 'service-or-github-failure; inspect private artifacts, rerun explicitly' });
      if (this.store.owns(this.owner)) await this.checks.stop(job, 'failure', 'Review failed').catch(() => {});
    } finally {
      clearInterval(monitor); this.abort = undefined;
      if (this.store.owns(this.owner) && this.store.get(job.id).state === 'cancelled') {
        await this.checks.stop(job, 'cancelled', 'Review superseded or paused').catch(() => {});
        if (!this.store.enabled()) {
          const marker = markerFor(this.config.repositoryId, job.pr);
          const existing = await this.github.summary(job.pr, marker);
          if (existing && this.store.owns(this.owner) && !this.store.enabled()) {
            await this.github.update(existing.id, `${marker}\n# atmin review — review paused\n\nThe operator paused this review. No active review or completed result is claimed for this request. Previous findings are historical. After re-enabling the service, a maintainer can request a new run with \`/atmin review\`.`);
          }
        }
      }
      if (this.store.owns(this.owner) && this.store.get(job.id).state === 'uncertain') await this.checks.stop(job, 'failure', 'Review publication uncertain').catch(() => {});
    }
    return true;
  }
  private async work(job: Job, signal: AbortSignal): Promise<void> {
    const initial = await this.github.pull(job.pr);
    if (!this.store.current(job, this.owner) || signal.aborted) return;
    this.store.track(job.pr, initial.baseRef, initial.state === 'open' && !initial.draft);
    const marker = markerFor(this.config.repositoryId, job.pr);
    if (initial.state !== 'open' || initial.draft) {
      const existing = await this.github.summary(job.pr, marker);
      if (existing && this.store.current(job, this.owner)) await this.github.update(existing.id, `${marker}\n# atmin review — inactive\n\nPR is ${initial.draft ? 'a draft' : 'closed'}. Previous findings are historical. No merge approval.`);
      if (this.store.current(job, this.owner)) this.store.update(job.id, { state: 'skipped', error: initial.draft ? 'draft' : 'closed' });
      return;
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
      let artifact: string | null = null;
      if (!this.store.reserve(job, this.owner, this.config.maxReviewsPerDay)) {
        report = '# atmin review — review not run\n\nThe operator’s rolling 24-hour review limit was reached. A maintainer can rerun after capacity is available. No inference was started.';
      } else {
        artifact = join(this.config.stateDirectory, 'runs', job.id);
        // A crash publishes this honest interruption report; it never starts another model request.
        this.store.update(job.id, { artifact, report: JSON.stringify({ initial,
          body: `# atmin review — interrupted\n\nThe worker stopped before it saved a validated report. No completed review is claimed. A maintainer can explicitly rerun.\n\nHead: \`${initial.headSha}\` · Target: \`${initial.baseSha}\` · Run: \`${job.id}\``,
        }) });
        try {
          artifact = await this.run(job, signal);
          if (!this.store.current(job, this.owner) || signal.aborted) return;
          const packet = parsePacket(JSON.parse(readFileSync(join(artifact, 'packet.json'), 'utf8')));
          const result = parseResult(JSON.parse(readFileSync(join(artifact, 'result.json'), 'utf8')));
          const live = await this.github.pull(job.pr);
          if (packet.repository !== this.config.repository || packet.pr !== job.pr || compareCurrent(packet, live).status !== 'current' || live.draft || !same(initial, live)) {
            this.cancel(job); return;
          }
          const assessment = assess(packet, result, compareCurrent(packet, live));
          report = renderMarkdown(packet, result, assessment);
          check = assessmentCheck(assessment);
        } catch {
          if (!this.store.current(job, this.owner) || signal.aborted) return;
          report = '# atmin review — review failed\n\nSource capture or investigation did not produce a validated report. No successful review or merge approval is claimed. A maintainer may request a new run with `/atmin review`; it uses a new budget reservation.';
        }
      }
      report += `\n\nHead: \`${initial.headSha}\` · Target: \`${initial.baseSha}\` · Run: \`${job.id}\`\n`;
      // Persist the report and its exact publication identity before any write.
      if (!this.store.current(job, this.owner)) return;
      this.store.update(job.id, { state: 'publishing', artifact, report: JSON.stringify({ initial, body: report, check }) });
      job = this.store.get(job.id);
    }
    const saved = JSON.parse(job.report!) as { initial: LivePull; body: string; check?: CheckOutput };
    if (!same(saved.initial, await this.github.pull(job.pr))) { this.cancel(job); return; }
    // Reconciliation refreshes CI and formatting from saved source evidence, without inference.
    if (job.artifact && existsSync(join(job.artifact, 'packet.json')) && existsSync(join(job.artifact, 'result.json'))) {
      const packet = parsePacket(JSON.parse(readFileSync(join(job.artifact, 'packet.json'), 'utf8')));
      const result = parseResult(JSON.parse(readFileSync(join(job.artifact, 'result.json'), 'utf8')));
      const live = await this.github.pull(job.pr);
      if (packet.repository !== this.config.repository || packet.pr !== job.pr || !same(saved.initial, live)
        || compareCurrent(packet, live).status !== 'current') { this.cancel(job); return; }
      const ci = await this.github.validation(packet.headSha, packet.policy.requiredChecks);
      const assessment = assess(packet, result, compareCurrent(packet, live), ci);
      if (!this.store.current(job, this.owner) || signal.aborted) return;
      writeFileSync(join(job.artifact, 'validation.json'), JSON.stringify({ headSha: packet.headSha, baseSha: packet.baseSha,
        checkedAt: new Date().toISOString(), checks: ci }, null, 2), { mode: 0o600 });
      saved.body = `${renderMarkdown(packet, result, assessment)}\nRun: \`${job.id}\`\n`;
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
