import type { Assessment } from '../assessment.js';
import type { GitHub, CheckOutput } from './api.js';
import type { Job, Store } from './store.js';

export function assessmentCheck(assessment: Assessment): CheckOutput {
  const success = assessment.freshness.status === 'current' && assessment.scope === 'complete'
    && ['passed', 'not-applicable'].includes(assessment.validation) && assessment.findingsVerdict !== 'Changes needed';
  return { status: 'completed', conclusion: success ? 'success' : 'failure', output: {
    title: assessment.outcome, summary: `Rating: ${assessment.rating.score === null ? 'Not rated' : `${assessment.rating.score}/5`} · ${assessment.rating.policy.label}.\n\nScope: ${assessment.scope}. Required validation: ${assessment.validation}.\n\n${assessment.reasons.join('\n')}\n\nP0–P2 block this check; P3 and optional P4 do not. This is a review result, not merge approval.`,
  } };
}

// A creation attempt is durable before POST. On a lost response, reconcile by
// App identity + immutable head + job ID; never blindly create another check.
export class Checks {
  constructor(private store: Store, private github: GitHub) {
    store.db.exec('CREATE TABLE IF NOT EXISTS review_checks (job TEXT PRIMARY KEY, head TEXT NOT NULL, id INTEGER)');
  }
  async publish(job: Job, head: string, output: CheckOutput): Promise<void> {
    let row = this.store.db.prepare('SELECT head,id FROM review_checks WHERE job=?').get(job.id);
    if (row && row.head !== head) throw new Error('Check snapshot mismatch');
    let id = row?.id as number | null | undefined;
    if (id == null) {
      id = await this.github.findCheck(head, job.id);
      if (id == null) {
        if (row) throw new Error('Check creation uncertain; reconcile explicitly');
        this.store.db.prepare('INSERT INTO review_checks(job,head) VALUES(?,?)').run(job.id, head);
        id = await this.github.createCheck(head, job.id, output);
        this.store.db.prepare('UPDATE review_checks SET id=? WHERE job=?').run(id, job.id);
        return;
      }
      this.store.db.prepare('INSERT INTO review_checks(job,head,id) VALUES(?,?,?) ON CONFLICT(job) DO UPDATE SET id=excluded.id').run(job.id, head, id);
    }
    await this.github.updateCheck(id, output);
  }
  async stop(job: Job, conclusion: 'failure' | 'cancelled', title: string): Promise<void> {
    const row = this.store.db.prepare('SELECT head FROM review_checks WHERE job=?').get(job.id);
    if (row) await this.publish(job, String(row.head), { status: 'completed', conclusion, output: { title, summary: 'No current completed review is claimed. See the PR summary and operator status.' } });
  }
}
