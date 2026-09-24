import { PRIORITIES, QUALITY_CRITERIA, type EvidenceAnchor, type Finding, type Packet, type Result } from './contracts.js';
import { reviewSummary, type Assessment } from './assessment.js';
import type { Verification } from './verification.js';
import { criterionLabels } from './rating.js';

export function escapeMarkdown(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('@', '@\u200b').replace(/([\\`*_{}[\]()#+!|])/g, '\\$1');
}
// The icons live in assets/review-icons and are served from this public repository at a
// fixed commit, so a published comment never changes under a later edit to the files.
const ICONS = 'https://cdn.jsdelivr.net/gh/atmin-inc/review@34dba7bb15d80703385036ecd258efd0900c1fda/assets/review-icons';
const icon = (name: string, size: number) => `<img src="${ICONS}/${name}.svg" width="${size}" height="${size}" alt="">`;
function sourceLink(packet: Packet, anchor: EvidenceAnchor): string {
  const revision = anchor.side === 'head' ? packet.headSha : packet.mergeBaseSha;
  const path = anchor.path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  const line = anchor.line === null ? '' : `#L${anchor.line}`;
  const label = escapeMarkdown(anchor.path.replaceAll('\n', '\\n')) + (anchor.line === null ? '' : `:${anchor.line}`);
  return `[${label}](https://github.com/${packet.repository}/blob/${revision}/${path}${line})`;
}
export function renderFinding(packet: Packet, f: Finding, showFix = true): string {
  const e = escapeMarkdown;
  // Without a proposed change the consequence leads, once, instead of a placeholder fix.
  const lines = [`### ${icon(f.priority.toLowerCase(), 20)} ${f.priority} · ${e(f.title)}${f.priority === 'P4' ? ' (optional)' : ''}`, '',
    f.suggestion ? `**${f.priority === 'P4' ? 'Optional' : 'Fix'}:** ${e(f.suggestion)}` : e(f.consequence), '', sourceLink(packet, f.anchor), '',
    '<details><summary>Review details</summary>', '',
    `- Trigger: ${e(f.trigger)}`, ...(f.suggestion ? [`- Consequence: ${e(f.consequence)}`] : []),
    `- Priority rationale: ${e(f.priorityReason)}`, `- Counterevidence checked: ${e(f.counterEvidence)}`,
    `- Evidence: ${f.evidenceIds.map(e).join(', ')}`, ''];
  if (showFix && f.fix) lines.push('**Reviewed code**', '', '```', f.fix.original, '```', '',
    '**Proposed change**', '', '```', f.fix.replacement, '```', '',
    'Source range verified. Execution is unverified unless fix check results are shown below. GitHub commit controls appear on eligible inline suggestions.', '');
  return [...lines, '</details>', ''].join('\n');
}
export function renderMarkdown(packet: Packet, result: Result, assessment: Assessment, detailsUrl?: string, verification?: Verification): string {
  const e = escapeMarkdown;
  const required = assessment.findings.filter(f => ['P0', 'P1', 'P2'].includes(f.priority)).length;
  const headline = assessment.freshness.status === 'superseded' ? 'Outdated review'
    : assessment.freshness.status === 'unverified' ? 'Current PR not verified'
    : assessment.scope !== 'complete' ? 'Review incomplete'
    : required ? `${required} ${required === 1 ? 'fix' : 'fixes'} before merge`
    : assessment.validation === 'failed' ? 'Required checks failed'
    : assessment.validation === 'missing' ? 'Waiting for required checks'
    : assessment.rating.score === 5 ? 'No changes requested' : assessment.outcome;
  // Green only for a 5/5 with nothing outstanding; a score held back by anything else,
  // missing checks included, is amber.
  const score = assessment.rating.score;
  const status = score === null ? 'unscored' : score <= 2 ? '1'
    : score === 5 && ['passed', 'not-applicable'].includes(assessment.validation) ? '5' : '3';
  const reviewed = result.coverage.filter(c => c.status === 'reviewed').length;
  const validation = { passed: 'Required checks passed', failed: 'Required checks failed', missing: 'Required checks not verified', 'not-applicable': 'No required checks apply' }[assessment.validation];
  const lines = [
    `## ${icon(status, 24)} ${assessment.rating.score === null ? 'Not rated' : `${assessment.rating.score}/5`} — ${headline}`, '',
    '| P0 | P1 | P2 | P3 | P4 |', '| :---: | :---: | :---: | :---: | :---: |',
    `| ${PRIORITIES.map(p => { const n = assessment.findings.filter(f => f.priority === p).length; return n ? `**${n}**` : '0'; }).join(' | ')} |`, '',
    `**${reviewed}/${packet.changedFiles.length} files reviewed** · ${validation}.`, '',
    `**${e(assessment.rating.policy.label)}** · ${e(assessment.rating.reasons.at(-1)!)}`, '',
  ];
  if (assessment.freshness.status !== 'current') lines.push(`**${assessment.freshness.status === 'superseded' ? 'Historical result' : 'Freshness unverified'}:** ${e(assessment.freshness.reason)}`, '');
  if (assessment.scope !== 'complete') lines.push('**Review incomplete:** unresolved work remains; zero findings is not a clean result.', '');
  for (const f of assessment.findings) {
    lines.push('---', '', renderFinding(packet, f));
    const checks = verification?.fixes.find(fix => fix.findingId === f.id)?.checks;
    if (checks?.length) lines.push(`**Proposed fix checks:** ${checks.map(check => `${e(check.name)}: ${check.status}`).join(' · ')}. Tests ran on this patch in an isolated checkout; passing checks are evidence, not proof of correctness.`, '');
  }
  if (assessment.hiddenOptionalCount) lines.push(`${assessment.hiddenOptionalCount} optional P4 suggestion(s) hidden by target-branch policy.`, '');
  lines.push('---', '');
  if (detailsUrl && /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?\/\?repository=\d+#review\/[a-zA-Z0-9-]+$/.test(detailsUrl)) {
    lines.push(`[View full review on atmin](${detailsUrl})`, '');
  }
  lines.push('<details><summary>Rating policy and rationale</summary>', '',
    `Preset: **${e(assessment.rating.policy.label)}**. Scores are subjective assessments, not a probability of correctness or merge approval.`, '',
    ...assessment.rating.reasons.map(reason => `- ${e(reason)}`), '',
    'A perfect score requires no P0–P2 findings, a complete review of the changed files, and current commits.', '');
  for (const [key, required] of Object.entries(assessment.rating.policy.perfectRequires)) {
    if (required) lines.push(`- ${key === 'passingChecks' ? 'Required checks pass or are not applicable' : key === 'noP3' ? 'No P3 findings' : criterionLabels[key as keyof typeof criterionLabels]}`);
  }
  if (result.quality) for (const key of QUALITY_CRITERIA) {
    const criterion = result.quality.criteria[key];
    lines.push('', `**${criterionLabels[key]}: ${criterion.status}.** ${e(criterion.reason)}`,
      `Evidence: ${criterion.evidenceIds.map(e).join(', ') || 'Not available'}`);
  }
  if (result.quality?.conventionRules.length) {
    lines.push('', '**Documented rules from the target branch**', '');
    for (const rule of result.quality.conventionRules) lines.push(`- ${sourceLink({ ...packet, mergeBaseSha: packet.baseSha }, { path: rule.path, side: 'base', line: null })}: ${e(rule.quote)}`);
  }
  lines.push('', 'Policy is read from `.atmin/review.json` on the target branch. Optional suggestions and missing patches do not independently lower the rating.', '', '</details>', '',
    '<details><summary>Run summary and checks</summary>', '', e(reviewSummary(assessment)), '', '### Required validation', '');
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
