import { ReviewInputError, parsePacket, parseResult, PRIORITIES, type Packet, type Result, type Finding } from './contracts.js';
import { rate, type Rating } from './rating.js';

export function validateFix(finding: Finding): void {
  const fix = finding.fix;
  if (!fix) return;
  if (finding.anchor.side !== 'head') throw new ReviewInputError('Fixes must replace source in the head version of the finding file');
  if (fix.endLine < fix.startLine || fix.endLine - fix.startLine >= 20
    || fix.original.split('\n').length !== fix.endLine - fix.startLine + 1) throw new ReviewInputError('The fix range must contain 1–20 existing source lines');
  if (fix.replacement.split('\n').length > 20) throw new ReviewInputError('The replacement must contain at most 20 lines');
  if (fix.original === fix.replacement) throw new ReviewInputError('The replacement is identical to the original source; no change was proposed');
  if (fix.replacement.endsWith('\n')) throw new ReviewInputError('Omit the terminating newline from replacement; GitHub adds the line ending');
  if ([fix.original, fix.replacement].some(text => /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]|`{3}/.test(text))) {
    throw new ReviewInputError('Control characters, CRLF and Markdown code fences are unsupported in a fix');
  }
}

export type Freshness = { status: 'current' | 'superseded' | 'unverified'; reason: string; checkedAt: string | null };
export const unverified = (): Freshness => ({ status: 'unverified', reason: 'Live PR state has not been checked for this rendering.', checkedAt: null });
export type ValidationCheck = { name: string; status: Result['validation'][number]['status']; reason: string; url?: string };
export interface Assessment {
  rating: Rating;
  outcome: 'Changes needed' | 'Review incomplete' | 'Validation needed' | 'Superseded' | 'Unverified' | 'Suggestions' | 'No issues found';
  findingsVerdict: 'Changes needed' | 'Review incomplete' | 'Suggestions' | 'No issues found';
  scope: 'complete' | 'partial' | 'unavailable';
  validation: 'passed' | 'failed' | 'missing' | 'not-applicable';
  freshness: Freshness;
  validationChecks: ValidationCheck[];
  findings: Finding[];
  hiddenOptionalCount: number;
  reasons: string[];
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
export function validateEvidence(packet: Packet, result: Result): void {
  parsePacket(packet);
  parseResult(result);
  if (packet.headSha !== result.headSha || packet.baseSha !== result.baseSha || packet.policyHash !== result.policyHash) {
    throw new Error('Result does not match snapshot commits and policy');
  }
  unique(packet.changedFiles.map(f => f.path), 'changed path');
  unique(result.coverage.map(c => c.path), 'coverage path');
  unique(result.validation.map(c => c.name), 'validation name');
  unique(result.evidence.map(e => e.id), 'evidence ID');
  unique(result.findings.map(f => f.id), 'finding root-cause ID');
  const inventory = new Map(packet.changedFiles.map(f => [f.path, f]));
  if (result.coverage.length !== inventory.size || result.coverage.some(c => !inventory.has(c.path))) {
    throw new Error('Coverage must account for every changed path exactly once');
  }
  const evidence = new Map(result.evidence.map(e => [e.id, e]));
  if (result.status === 'not-started' && (result.findings.length || result.evidence.length
    || result.coverage.some(c => c.status === 'reviewed') || result.validation.some(c => c.status !== 'not-run'))) {
    throw new Error('A not-started investigation cannot contain claimed review evidence');
  }
  const checkRefs = (refs: string[]) => {
    if (refs.some(id => !evidence.has(id))) throw new Error('Unknown evidence reference');
  };
  if (result.quality) {
    if (result.status === 'not-started') throw new ReviewInputError('A not-started investigation cannot contain a quality assessment');
    for (const criterion of Object.values(result.quality.criteria)) {
      checkRefs(criterion.evidenceIds);
      if (criterion.status !== 'unknown' && (!criterion.evidenceIds.length
        || criterion.evidenceIds.some(id => evidence.get(id)?.provenance !== 'controller-captured'))) {
        throw new ReviewInputError('Quality judgments must cite captured source reads; use unknown when evidence is missing');
      }
    }
    if (result.quality.criteria.documentedConventions.status === 'concern' && !result.quality.conventionRules.length) {
      throw new ReviewInputError('A documented-convention violation must quote an explicit target-branch rule');
    }
  }
  for (const coverage of result.coverage) {
    checkRefs(coverage.evidenceIds);
    if (coverage.status === 'reviewed') {
      if (inventory.get(coverage.path)?.kind !== 'text') throw new Error('R01 cannot claim review coverage for non-text paths');
      if (!coverage.evidenceIds.some(id => evidence.get(id)?.anchors.some(a => a.path === coverage.path))) {
        throw new Error('Reviewed coverage needs evidence anchored to that path');
      }
    }
  }
  for (const check of result.validation) {
    checkRefs(check.evidenceIds);
    if (['pass', 'fail'].includes(check.status) && !check.evidenceIds.some(id => ['reproduction', 'ci'].includes(evidence.get(id)!.kind))) {
      throw new Error('A passed or failed check needs reproduction or CI evidence');
    }
  }
  for (const finding of result.findings) {
    validateFix(finding);
    checkRefs(finding.evidenceIds);
    if (!inventory.has(finding.anchor.path)) throw new Error('Finding must anchor to a changed path; callers belong in supporting evidence');
    if ((finding.priority === 'P4') !== (finding.kind === 'improvement')) throw new Error('P4 is an optional improvement; P0–P3 are defects');
    if (!finding.evidenceIds.some(id => evidence.get(id)?.anchors.some(a => a.path === finding.anchor.path && a.side === finding.anchor.side))) {
      throw new Error('Finding needs evidence anchored to its changed path and side');
    }
    if (finding.fix && !finding.evidenceIds.some(id => {
      const item = evidence.get(id);
      return item?.provenance === 'controller-captured' && item.anchors[0]?.path === finding.anchor.path
        && item.anchors[0]?.side === 'head' && item.capture.revision === packet.headSha
        && item.capture.startLine <= finding.fix!.startLine && item.capture.endLine >= finding.fix!.endLine;
    })) throw new ReviewInputError('A fix must cite a captured head source read covering its entire replacement range');
  }
}

export function assess(packet: Packet, result: Result, freshness: Freshness = unverified(), ci: ValidationCheck[] = []): Assessment {
  validateEvidence(packet, result);
  const scope = result.status === 'not-started' ? 'unavailable'
    : result.status === 'completed' && result.coverage.every(c => c.status === 'reviewed') ? 'complete' : 'partial';
  unique(ci.map(c => c.name), 'CI check name');
  const checks = packet.policy.requiredChecks.map(name => ci.find(c => c.name === name)
    ?? result.validation.find(c => c.name === name)
    ?? { name, status: 'not-run' as const, reason: 'No evidence supplied.' });
  const validation = checks.some(c => c?.status === 'fail') ? 'failed'
    : checks.some(c => !c || c.status === 'not-run') ? 'missing'
    : checks.some(c => c?.status === 'pass') ? 'passed' : 'not-applicable';
  const findings = result.findings.filter(f => f.priority !== 'P4' || packet.policy.includeOptional)
    .toSorted((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.id.localeCompare(b.id));
  const blocking = findings.some(f => ['P0', 'P1', 'P2'].includes(f.priority));
  const findingsVerdict = blocking ? 'Changes needed' : findings.length ? 'Suggestions'
    : scope !== 'complete' ? 'Review incomplete' : 'No issues found';
  // These are advisory results, not GitHub approvals or a protected merge check.
  const outcome = freshness.status === 'superseded' ? 'Superseded'
    : blocking ? 'Changes needed'
    : scope !== 'complete' ? 'Review incomplete'
    : ['failed', 'missing'].includes(validation) ? 'Validation needed'
    : freshness.status !== 'current' ? 'Unverified' : findingsVerdict;
  const reasons = [freshness.reason];
  if (blocking) reasons.push('At least one substantiated P0–P2 defect needs a change under rubric v1.');
  if (scope !== 'complete') reasons.push('Investigation is not complete across the captured changed-file inventory.');
  if (validation === 'failed' || validation === 'missing') reasons.push(`Required validation is ${validation}.`);
  return { outcome, findingsVerdict, scope, validation, freshness, validationChecks: checks, findings, hiddenOptionalCount: result.findings.length - findings.length, reasons,
    rating: rate(packet, result, { scope, freshness, validation }) };
}
