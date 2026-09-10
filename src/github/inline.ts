import type { Finding, Packet } from '../contracts.js';
import { renderFinding } from '../render.js';
import type { GitHub, InlineComment, PullFile } from './api.js';
import type { Job, Store } from './store.js';

// GitHub's per-file patch avoids parsing quoted Git paths or guessing rename mappings.
// LEFT anchors deletions; RIGHT anchors additions and unchanged diff context.
export function inlineComments(packet: Packet, findings: Finding[], files: PullFile[]): InlineComment[] {
  const comments: InlineComment[] = [];
  for (const finding of findings) {
    const { path, side, line } = finding.anchor;
    const file = files.find(f => (side === 'base' ? f.previous_filename ?? f.filename : f.filename) === path);
    if (!file?.patch) continue;
    let left = 0, right = 0, inHunk = false, matched = false;
    for (const text of file.patch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); inHunk = true; continue; }
      if (!inHunk) continue;
      if ((side === 'base' && text.startsWith('-') && left === line)
        || (side === 'head' && ['+', ' '].includes(text[0] ?? '') && right === line)) { matched = true; break; }
      if (text.startsWith('-') || text.startsWith(' ')) left++;
      if (text.startsWith('+') || text.startsWith(' ')) right++;
    }
    if (!matched) continue;
    const body = renderFinding(packet, finding);
    comments.push({ path: file.filename, side: side === 'base' ? 'LEFT' : 'RIGHT', line,
      body: body.length <= 8000 ? body : `${body.slice(0, 7800)}\n\nFinding shortened; see the full PR summary.` });
    // ponytail: one bounded batch per run; all remaining findings stay in the summary.
    if (comments.length === 20) break;
  }
  return comments;
}

export class InlineReviews {
  constructor(private store: Store, private github: GitHub) {
    store.db.exec('CREATE TABLE IF NOT EXISTS inline_reviews (job TEXT PRIMARY KEY, head TEXT NOT NULL, id INTEGER)');
  }
  async publish(job: Job, packet: Packet, findings: Finding[], current: () => Promise<boolean>): Promise<void> {
    const row = this.store.db.prepare('SELECT head,id FROM inline_reviews WHERE job=?').get(job.id);
    if (row && row.head !== packet.headSha) throw new Error('Inline snapshot mismatch');
    if (row?.id != null || (!row && !findings.length)) return;
    const marker = `<!-- atmin-review-inline:${job.id} -->`;
    let id = await this.github.findReview(job.pr, packet.headSha, marker);
    if (id === null) {
      // Persist intent before POST. A lost response cannot cause a duplicate batch.
      if (row) throw new Error('Inline review creation uncertain; reconcile explicitly');
      const comments = inlineComments(packet, findings, await this.github.files(job.pr));
      if (!comments.length || !await current()) return;
      this.store.db.prepare('INSERT INTO inline_reviews(job,head) VALUES(?,?)').run(job.id, packet.headSha);
      id = await this.github.createReview(job.pr, packet.headSha,
        `${marker}\natmin review findings for head \`${packet.headSha}\` against target \`${packet.baseSha}\`.\n\n`
        + `${comments.length} of ${findings.length} visible findings attached to diff lines. See the atmin review summary for the full report and current status. This is an advisory review.`, comments);
    }
    this.store.db.prepare('INSERT INTO inline_reviews(job,head,id) VALUES(?,?,?) ON CONFLICT(job) DO UPDATE SET id=excluded.id').run(job.id, packet.headSha, id);
  }
}
