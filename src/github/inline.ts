import type { Verification } from '../verification.js';
import type { Finding, Packet } from '../contracts.js';
import { renderFinding } from '../render.js';
import { validateFix } from '../assessment.js';
import type { GitHub, InlineComment, PullFile } from './api.js';
import type { Job, Store } from './store.js';

// GitHub's per-file patch avoids parsing quoted Git paths or guessing rename mappings.
function diffLines(patch: string) {
  const deleted = new Set<number>(), head = new Map<number, { text: string; hunk: number }>();
  let left = 0, right = 0, hunk = 0;
  for (const text of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { left = Number(header[1]); right = Number(header[2]); hunk++; continue; }
    if (!hunk) continue;
    if (text.startsWith('-')) deleted.add(left);
    if (text.startsWith('+') || text.startsWith(' ')) head.set(right, { text: text.slice(1), hunk });
    if (text.startsWith('-') || text.startsWith(' ')) left++;
    if (text.startsWith('+') || text.startsWith(' ')) right++;
  }
  return { deleted, head };
}

export function inlineComments(packet: Packet, findings: Finding[], files: PullFile[], verification?: Verification): InlineComment[] {
  const comments: InlineComment[] = [], proposed = new Set<string>();
  for (const finding of findings) {
    const { path, side, line } = finding.anchor;
    const file = files.find(f => (side === 'base' ? f.previous_filename ?? f.filename : f.filename) === path);
    if (!file?.patch) continue;
    const diff = diffLines(file.patch);
    if (!(side === 'base' ? diff.deleted.has(line) : diff.head.has(line))) continue;
    const rendered = renderFinding(packet, finding, false);
    const comment: InlineComment = { path: file.filename, side: side === 'base' ? 'LEFT' : 'RIGHT', line,
      body: rendered.length <= 8000 ? rendered : `${rendered.slice(0, 7800)}\n\nFinding shortened; see the full PR summary.` };
    if (finding.fix) {
      // Invalid, overlapping or unavailable patches never hide the underlying finding.
      try {
        validateFix(finding);
        const fix = finding.fix;
        const lines = Array.from({ length: fix.endLine - fix.startLine + 1 }, (_, i) => fix.startLine + i);
        const keys = lines.map(line => `${file.filename}:${line}`);
        const range = lines.map(line => diff.head.get(line));
        const checks = verification?.fixes.find(f => f.findingId === finding.id)?.checks;
        const execution = checks?.length ? `Isolated fix checks: ${checks.map(c => `${c.name}: ${c.status}`).join(', ')}. Passing checks do not prove correctness.` : 'Source range verified; fix not executed or tested.';
        const suggestion = `\n\n**Proposed minimal fix** · ${execution}\n\n\`\`\`suggestion\n${fix.replacement}\n\`\`\`\n\nUse GitHub’s **Apply suggestion** or add it to a batch. Review the change before committing; the new commit is reviewed through the repository’s normal GitHub triggers and limits.`;
        if (checks?.some(check => check.status === 'fail')) {
          comment.body += '\n\n**Proposed fix withheld:** an isolated check failed. See the full review for the attempted replacement and check results.';
        } else if (range.every(line => line && line.hunk === range[0]?.hunk)
          && range.map(line => line!.text).join('\n') === fix.original
          && !file.patch.includes('\\ No newline at end of file')
          && !keys.some(key => proposed.has(key)) && rendered.length + suggestion.length <= 8000) {
          comment.body = rendered + suggestion;
          comment.line = fix.endLine;
          if (fix.startLine !== fix.endLine) { comment.start_line = fix.startLine; comment.start_side = 'RIGHT'; }
          keys.forEach(key => proposed.add(key));
        }
      } catch { /* Retain the finding as ordinary review feedback. */ }
    }
    comments.push(comment);
    // ponytail: one bounded batch per run; all remaining findings stay in the summary.
    if (comments.length === 20) break;
  }
  return comments;
}

export class InlineReviews {
  constructor(private store: Store, private github: GitHub) {
    store.db.exec('CREATE TABLE IF NOT EXISTS inline_reviews (job TEXT PRIMARY KEY, head TEXT NOT NULL, id INTEGER)');
  }
  async publish(job: Job, packet: Packet, findings: Finding[], current: () => Promise<boolean>, verification?: Verification): Promise<void> {
    const row = this.store.db.prepare('SELECT head,id FROM inline_reviews WHERE job=?').get(job.id);
    if (row && row.head !== packet.headSha) throw new Error('Inline snapshot mismatch');
    if (row?.id != null || (!row && !findings.length)) return;
    const marker = `<!-- atmin-review-inline:${job.id} -->`;
    let id = await this.github.findReview(job.pr, packet.headSha, marker);
    if (id === null) {
      // Persist intent before POST. A lost response cannot cause a duplicate batch.
      if (row) throw new Error('Inline review creation uncertain; reconcile explicitly');
      const comments = inlineComments(packet, findings, await this.github.files(job.pr), verification);
      if (!comments.length || !await current()) return;
      this.store.db.prepare('INSERT INTO inline_reviews(job,head) VALUES(?,?)').run(job.id, packet.headSha);
      id = await this.github.createReview(job.pr, packet.headSha,
        `${marker}\natmin review findings for head \`${packet.headSha}\` against target \`${packet.baseSha}\`.\n\n`
        + `${comments.length} of ${findings.length} visible findings attached to diff lines. See the atmin review summary for the full report and current status. This is an advisory review.`, comments);
    }
    this.store.db.prepare('INSERT INTO inline_reviews(job,head,id) VALUES(?,?,?) ON CONFLICT(job) DO UPDATE SET id=excluded.id').run(job.id, packet.headSha, id);
  }
}
