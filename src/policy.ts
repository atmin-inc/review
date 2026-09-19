import type { Priority } from './contracts.js';
import type { ClaimType } from './claim.js';
import type { Chain, Confidence } from './evidence.js';

// The verdict is composed by code from typed signals a model supplied. It is not a
// model's judgment. SMOKE_TEST_JEV.md is the evidence: factual checks were sharp,
// composite judgments clustered around a coin flip. See spec/verdict-policy.md.
export type ReviewVerdict = 'block' | 'security_review' | 'nits' | 'merge';

const CONFIDENCE_ORDER: Confidence[] = ['low', 'moderate', 'high'];

// Severity is listed explicitly rather than compared, because "severity <= P2" reads
// two opposite ways depending on whether P0 or P4 is the top of the order.
export interface FindingMatch {
  severityIn?: Priority[];
  typeIn?: ClaimType[];
  minConfidence?: Confidence;
  confidenceIs?: Confidence;
}
export type Rule = { name: string; verdict: ReviewVerdict } &
  ({ any: FindingMatch } | { atLeast: number; match: FindingMatch } | { otherwise: true });
export interface Policy { name: string; rules: Rule[] }

export interface Finding {
  claimId: string;
  type: ClaimType;
  severity: Priority;
  confidence: Confidence;
}

// Only a confirmed claim is a finding. Refuted and inconclusive claims keep their
// chains for audit but never drive a verdict.
export function findingsFrom(chains: Chain[], typeOf: (claimId: string) => ClaimType): Finding[] {
  return chains.filter(chain => chain.verdict === 'confirmed').map(chain => ({
    claimId: chain.claimId, type: typeOf(chain.claimId),
    severity: chain.finalSeverity!, confidence: chain.verifierConfidence,
  }));
}

export function matches(finding: Finding, match: FindingMatch): boolean {
  if (match.severityIn && !match.severityIn.includes(finding.severity)) return false;
  if (match.typeIn && !match.typeIn.includes(finding.type)) return false;
  if (match.confidenceIs && finding.confidence !== match.confidenceIs) return false;
  if (match.minConfidence
    && CONFIDENCE_ORDER.indexOf(finding.confidence) < CONFIDENCE_ORDER.indexOf(match.minConfidence)) return false;
  return true;
}

export interface Decision { verdict: ReviewVerdict; rule: string; policy: string; matched: string[] }

// Ordered and first-match: rule order is the policy, and the output names the rule
// that fired, because "blocked by rule 1" beats a score nobody can reconstruct.
export function decide(findings: Finding[], policy: Policy): Decision {
  for (const rule of policy.rules) {
    if ('otherwise' in rule) return { verdict: rule.verdict, rule: rule.name, policy: policy.name, matched: [] };
    const match = 'any' in rule ? rule.any : rule.match;
    const hit = findings.filter(finding => matches(finding, match));
    if ('any' in rule ? hit.length > 0 : hit.length >= rule.atLeast) {
      return { verdict: rule.verdict, rule: rule.name, policy: policy.name, matched: hit.map(f => f.claimId) };
    }
  }
  // Totality is a property of the policy, not of this loop: a policy without a
  // fallback would silently answer nothing, so it is rejected rather than defaulted.
  throw new Error(`Policy ${JSON.stringify(policy.name)} has no fallback rule and is not total`);
}

export function policyRejection(policy: Policy): string | null {
  if (!policy.rules.length) return 'a policy needs at least one rule';
  const fallback = policy.rules.findIndex(rule => 'otherwise' in rule);
  if (fallback === -1) return 'a policy needs a fallback rule, or it is not total';
  if (fallback !== policy.rules.length - 1) return 'the fallback rule must be last, or the rules after it are dead';
  if (new Set(policy.rules.map(rule => rule.name)).size !== policy.rules.length) {
    return 'rule names must be unique, or a decision cannot name what fired';
  }
  return null;
}

export const BALANCED: Policy = {
  name: 'balanced',
  rules: [
    { name: 'catastrophic-defect', verdict: 'block', any: { severityIn: ['P0'], minConfidence: 'moderate' } },
    { name: 'serious-defect-established', verdict: 'block', any: { severityIn: ['P1'], confidenceIs: 'high' } },
    { name: 'security-surface', verdict: 'security_review', any: { typeIn: ['injection_risk', 'auth_bypass', 'hardcoded_secret'] } },
    { name: 'serious-defect-probable', verdict: 'security_review', any: { severityIn: ['P1'], confidenceIs: 'moderate' } },
    { name: 'several-localized-defects', verdict: 'nits', atLeast: 2, match: { severityIn: ['P0', 'P1', 'P2'] } },
    { name: 'any-remaining-finding', verdict: 'nits', any: {} },
    { name: 'nothing-survived-verification', verdict: 'merge', otherwise: true },
  ],
};
