import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, loadReview } from './snapshot.js';
import { parseProfile, type Receipt } from './investigation.js';

// Read-only export: include failed/partial runs and unsettled reservations so
// cheap failures cannot masquerade as low-cost completed reviews.
export function costReport(directory: string) {
  const { packet, result } = loadReview(directory);
  const receipt: Receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  parseProfile(receipt.profile);
  const number = (n: number) => { if (!Number.isFinite(n) || n < 0) throw new Error('Invalid receipt quantity'); return n; };
  const sum = (field: 'meteredUsd' | 'reservedUsd' | 'inputTokens' | 'outputTokens') => receipt.calls.reduce((total, call) => total + number(call[field] ?? 0), 0);
  const unknown = receipt.calls.filter(c => c.meteredUsd === null);
  const stat = git(join(directory, 'source.git'), ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--numstat', '-z', packet.mergeBaseSha, packet.headSha, '--']).toString('utf8');
  let addedLines = 0, deletedLines = 0, binaryFiles = 0;
  for (const entry of stat.split('\0').filter(Boolean)) {
    const [added, deleted] = entry.split('\t');
    if (added === '-' || deleted === '-') binaryFiles++;
    else { addedLines += number(Number(added)); deletedLines += number(Number(deleted)); }
  }
  const source = result.evidence.filter(e => e.provenance === 'controller-captured');
  return { repository: packet.repository, pr: packet.pr, headSha: packet.headSha, baseSha: packet.baseSha,
    model: receipt.profile.model, rateCard: receipt.rateCard, profile: receipt.profile,
    engineVersion: receipt.engineVersion, promptHash: receipt.promptHash, toolHash: receipt.toolHash,
    status: result.status, stopReason: receipt.stopReason, finished: receipt.stopReason === 'finished' && result.status === 'completed',
    changedFiles: packet.changedFiles.length, addedLines, deletedLines, binaryFiles,
    inspectedFiles: new Set(source.flatMap(e => e.anchors.map(a => a.path))).size,
    sourceReads: source.length, modelCalls: receipt.calls.length, toolCalls: receipt.toolCalls,
    // Pending input quantities are estimates, not billed input usage.
    actualInputTokens: receipt.calls.filter(c => c.outputTokens !== null).reduce((n, c) => n + number(c.inputTokens), 0),
    actualOutputTokens: sum('outputTokens'), knownCostUsd: sum('meteredUsd'),
    unsettledCalls: unknown.length, unsettledReservedUsd: unknown.reduce((n, c) => n + number(c.reservedUsd), 0),
    totalCostUsd: unknown.length ? null : sum('meteredUsd'),
    elapsedMs: receipt.finishedAt ? number(Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)) : null,
    findings: result.findings.length, complexity: 'unlabelled',
    limits: 'Source-only inference cost. Code size and inspection breadth are proxies, not measured complexity. Compute, funding fees and human grading are excluded.' };
}
