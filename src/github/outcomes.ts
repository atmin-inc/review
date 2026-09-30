import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePacket, parseResult, type Finding } from '../contracts.js';
import { assess } from '../assessment.js';
import type { GitHub, LivePull, ReviewComment } from './api.js';
import type { Job, Store } from './store.js';
import { failureCause } from './worker.js';

// What people did with each finding, read when its PR closes. `changed` means the flagged
// line or a line next to it was edited or removed between the head the finding was first
// published on and the PR's last head; `unchanged` means those three lines are still in the
// file as they were, ignoring indentation. A change is a sign the finding was acted on, not
// proof: an unrelated edit to the same lines also counts. Thumbs on the inline comments and
// replies to them are counted as people left them. Resolved conversations are not read,
// since GitHub reports them only through GraphQL.
export type CodeOutcome = 'changed' | 'unchanged' | 'unknown';

// Stable across the reviews of one PR: a carried finding keeps its path and title.
export const findingKey = (finding: Pick<Finding, 'anchor' | 'title'>): string =>
  createHash('sha256').update(`${finding.anchor.path}\0${finding.title}`).digest('hex').slice(0, 16);
// Hidden in each inline comment so its reactions can be tied back to the finding.
export const findingMarker = (finding: Pick<Finding, 'anchor' | 'title'>): string => `<!-- atmin-finding:${findingKey(finding)} -->`;

const trimmed = (text: string) => text.split('\n').map(line => line.trim());
function flagged(text: string, line: number): string[] | null {
  const lines = trimmed(text);
  return line >= 1 && line <= lines.length ? lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 1)) : null;
}
function contains(text: string, block: string[]): boolean {
  const lines = trimmed(text);
  for (let i = 0; i + block.length <= lines.length; i++) if (block.every((line, j) => lines[i + j] === line)) return true;
  return false;
}

export class Outcomes {
  constructor(private store: Store, private github: GitHub, private repositoryId: number) {}
  // Replaces the PR's outcomes, so a PR reopened and closed again is read at its last close.
  async record(pr: number, live: LivePull, now = Date.now()): Promise<void> {
    const first = new Map<string, { job: string; head: string; finding: Finding }>();
    let unreadable = 0;
    for (const job of this.store.db.prepare("SELECT * FROM jobs WHERE pr=? AND state='completed' AND artifact IS NOT NULL ORDER BY created, rowid").all(pr) as unknown as Job[]) {
      if (!existsSync(join(job.artifact!, 'result.json'))) continue;
      try {
        const packet = parsePacket(JSON.parse(readFileSync(join(job.artifact!, 'packet.json'), 'utf8')));
        const result = parseResult(JSON.parse(readFileSync(join(job.artifact!, 'result.json'), 'utf8')));
        for (const finding of assess(packet, result).findings) if (!first.has(findingKey(finding))) first.set(findingKey(finding), { job: job.id, head: packet.headSha, finding });
      } catch { unreadable++; }
    }
    // Thumbs and replies on every inline comment of the finding, across the PR's reviews.
    const reviews = new Set(this.store.db.prepare('SELECT inline_reviews.id FROM inline_reviews JOIN jobs ON jobs.id=inline_reviews.job WHERE jobs.pr=? AND inline_reviews.id IS NOT NULL').all(pr).map(row => Number(row.id)));
    let comments: ReviewComment[] | null = [], commentsFailed: string | null = null;
    if (reviews.size && first.size) try { comments = await this.github.reviewComments(pr); } catch (error) { comments = null; commentsFailed = failureCause(error); }
    const reactions = new Map<string, { up: number; down: number; replies: number }>();
    for (const comment of comments ?? []) {
      const key = comment.reviewId !== null && reviews.has(comment.reviewId) ? /<!-- atmin-finding:([a-f0-9]{16}) -->/.exec(comment.body)?.[1] : undefined;
      if (!key) continue;
      const counts = reactions.get(key) ?? { up: 0, down: 0, replies: 0 };
      counts.up += comment.up; counts.down += comment.down;
      counts.replies += comments!.filter(reply => reply.replyTo === comment.id && reply.human).length;
      reactions.set(key, counts);
    }
    const files = new Map<string, Promise<string | null>>();
    const read = (path: string, ref: string) => {
      if (!files.has(`${ref}:${path}`)) files.set(`${ref}:${path}`, this.github.file(path, ref));
      return files.get(`${ref}:${path}`)!;
    };
    const rows: { key: string; job: string; head: string; finding: Finding; code: CodeOutcome; note: string | null }[] = [];
    for (const [key, { job, head, finding }] of first) {
      let code: CodeOutcome = 'unknown', note: string | null = null;
      if (finding.anchor.side === 'base') note = 'the finding is on a line the PR removed';
      else if (head === live.headSha) code = 'unchanged';
      else try {
        const before = await read(finding.anchor.path, head), block = before === null ? null : flagged(before, finding.anchor.line);
        if (!block) note = before === null ? 'no file at that path at the reviewed head' : 'the line is outside the file at the reviewed head';
        else {
          const after = await read(finding.anchor.path, live.headSha);
          code = after !== null && contains(after, block) ? 'unchanged' : 'changed';
          if (after === null) note = 'the file was removed or renamed';
        }
      } catch (error) { note = failureCause(error); }
      rows.push({ key, job, head, finding, code, note });
    }
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM outcomes WHERE pr=?').run(pr);
      const insert = this.store.db.prepare('INSERT INTO outcomes(pr,finding,job,head,final,merged,priority,path,line,title,code,note,up,down,replies,recorded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const { key, job, head, finding, code, note } of rows) {
        const counts = comments === null ? null : reactions.get(key) ?? null;
        insert.run(pr, key, job, head, live.headSha, Number(live.merged), finding.priority, finding.anchor.path, finding.anchor.line, finding.title, code, note,
          counts?.up ?? null, counts?.down ?? null, counts?.replies ?? null, now);
      }
    });
    const tally = (code: CodeOutcome) => rows.filter(row => row.code === code).length, sum = (field: 'up' | 'down' | 'replies') => [...reactions.values()].reduce((n, counts) => n + counts[field], 0);
    const notes = [...new Set(rows.filter(row => row.note).map(row => row.note))];
    process.stderr.write(`atmin review: outcomes of PR ${pr} in repository ${this.repositoryId} (${live.merged ? 'merged' : 'closed unmerged'} at ${live.headSha.slice(0, 12)}): `
      + `${rows.length} finding(s), ${tally('changed')} changed, ${tally('unchanged')} unchanged, ${tally('unknown')} unknown; `
      + (comments === null ? `reactions not read: ${commentsFailed}` : `${sum('up')} thumbs up, ${sum('down')} thumbs down, ${sum('replies')} replies on inline comments`)
      + (unreadable ? `; ${unreadable} completed review(s) had unreadable results` : '') + (notes.length ? `; notes: ${notes.join('; ')}` : '') + '\n');
  }
}

// For operators: how findings fared on closed PRs, merged ones counted apart.
export function outcomeSummary(store: Store) {
  const rows = store.db.prepare(`SELECT merged, count(DISTINCT pr) AS pulls, count(*) AS findings, sum(code='changed') AS changed, sum(code='unchanged') AS unchanged,
    sum(code='unknown') AS unknown, sum(up) AS up, sum(down) AS down, sum(replies) AS replies FROM outcomes GROUP BY merged`).all();
  const side = (merged: number) => {
    const row = rows.find(row => Number(row.merged) === merged);
    return Object.fromEntries(['pulls', 'findings', 'changed', 'unchanged', 'unknown', 'up', 'down', 'replies'].map(field => [field, Number(row?.[field] ?? 0)])) as
      Record<'pulls' | 'findings' | 'changed' | 'unchanged' | 'unknown' | 'up' | 'down' | 'replies', number>;
  };
  return { merged: side(1), unmerged: side(0) };
}
