import type { EvidenceAnchor, Finding, Packet, Result } from './contracts.js';
import type { Assessment } from './assessment.js';

export function escapeMarkdown(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('@', '@\u200b').replace(/([\\`*_{}[\]()#+!|])/g, '\\$1');
}
function sourceLink(packet: Packet, anchor: EvidenceAnchor): string {
  const revision = anchor.side === 'head' ? packet.headSha : packet.mergeBaseSha;
  const path = anchor.path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  const line = anchor.line === null ? '' : `#L${anchor.line}`;
  const label = escapeMarkdown(anchor.path.replaceAll('\n', '\\n')) + (anchor.line === null ? '' : `:${anchor.line}`);
  return `[${label}](https://github.com/${packet.repository}/blob/${revision}/${path}${line})`;
}
export function renderFinding(packet: Packet, f: Finding): string {
  const e = escapeMarkdown;
  return [`#### ${f.priority} · ${e(f.title)}${f.priority === 'P4' ? ' (optional)' : ''}`, '',
    sourceLink(packet, f.anchor), '',
    `- Trigger: ${e(f.trigger)}`, `- Consequence: ${e(f.consequence)}`, `- Suggested change: ${e(f.suggestion)}`,
    '', '<details><summary>Reasoning and evidence</summary>', '', `- Priority rationale: ${e(f.priorityReason)}`, `- Counterevidence checked: ${e(f.counterEvidence)}`,
    `- Evidence: ${f.evidenceIds.map(e).join(', ')}`, '', '</details>', ''].join('\n');
}
export function renderMarkdown(packet: Packet, result: Result, assessment: Assessment): string {
  const e = escapeMarkdown;
  const headline = assessment.freshness.status === 'current' ? assessment.findingsVerdict : assessment.outcome;
  const icon = headline === 'No issues found' ? '✅' : headline === 'Changes needed' ? '🔴' : '⚠️';
  const count = (priorities: string[]) => assessment.findings.filter(f => priorities.includes(f.priority)).length;
  const reviewed = result.coverage.filter(c => c.status === 'reviewed').length;
  const validation = { passed: '✅ Passed', failed: '❌ Failed', missing: '⏳ Not verified', 'not-applicable': 'Not required' }[assessment.validation];
  const lines = [
    `## ${icon} ${headline}`, '',
    `**atmin review** · ${assessment.scope === 'complete' ? 'Source review complete' : 'Source review incomplete'}`, '',
    '| Changes needed · P0–P2 | Minor issues · P3 | Optional · P4 | Files reviewed |',
    '| :---: | :---: | :---: | :---: |',
    `| **${count(['P0', 'P1', 'P2'])}** | ${count(['P3'])} | ${count(['P4'])}${assessment.hiddenOptionalCount ? ` (${assessment.hiddenOptionalCount} hidden)` : ''} | ${reviewed} / ${packet.changedFiles.length} |`, '',
    `**Required validation: ${validation}.**${assessment.validation === 'missing' ? ' Repository tests have not been verified.' : ''}`, '',
    e(result.summary), '',
  ];
  if (assessment.freshness.status !== 'current') lines.push(`**${assessment.freshness.status === 'superseded' ? 'Historical result' : 'Freshness unverified'}:** ${e(assessment.freshness.reason)}`, '');
  if (assessment.scope !== 'complete') lines.push('**Review incomplete:** unresolved work remains; zero findings is not a clean result.', '');
  if (assessment.findings.length) lines.push('### Findings', '');
  for (const f of assessment.findings) {
    lines.push(renderFinding(packet, f));
  }
  if (assessment.hiddenOptionalCount) lines.push(`${assessment.hiddenOptionalCount} optional P4 suggestion(s) hidden by target-branch policy.`, '');
  lines.push('<details><summary>Validation and review evidence</summary>', '', '### Required validation', '');
  for (const check of assessment.validationChecks) {
    lines.push(`- ${e(check.name)}: **${check.status}** — ${e(check.reason)}${check.url ? ` [GitHub check](${check.url})` : ''}`);
  }
  lines.push('', '### Evidence', '');
  if (!result.evidence.length) lines.push('No investigation evidence recorded.');
  for (const item of result.evidence) lines.push(`- ${e(item.id)} · ${item.kind} · ${item.provenance}: ${e(item.summary)} ${item.anchors.map(a => sourceLink(packet, a)).join(', ')}`);
  lines.push('', '### Coverage and limitations', '');
  for (const file of packet.changedFiles) {
    const coverage = result.coverage.find(c => c.path === file.path)!;
    lines.push(`- ${e(file.path)} · ${file.change}/${file.kind} · ${coverage.status}`);
  }
  lines.push(...result.limitations.map(reason => `- Limitation: ${e(reason)}`), '',
    '</details>', '', '<details><summary>Run details</summary>', '',
    `Repository: ${e(packet.repository)} · PR ${packet.pr}`,
    `Head: \`${packet.headSha}\` · Target: \`${packet.baseSha}\` · Merge base: \`${packet.mergeBaseSha}\``,
    `Reviewer: ${e(result.reviewer.name)} · Model: ${e(result.reviewer.model)} · Context: ${result.reviewer.context}`, '',
    '**Advisory evidence.** Captured source ranges are checked against Git objects. Reasoning and declared test claims are not independently verified. This is not merge approval.', '',
    ...assessment.reasons.map(reason => `- ${e(reason)}`), '',
    `Rubric ${packet.policy.rubricVersion} · Policy digest \`${packet.policyHash}\``,
    `Captured: ${packet.createdAt} · Live check: ${assessment.freshness.checkedAt ?? 'not performed'}`, '', '</details>', '');
  return lines.join('\n');
}
