import { escapeMarkdown } from './render.js';
import type { Claim } from './claim.js';
import type { Chain } from './evidence.js';
import type { Verification } from './lifecycle.js';
import type { ClaimInvestigation } from './investigator.js';

// The user-facing end of the lifecycle. Everything here is derived: the verdict names
// the rule that produced it, and each surviving claim shows the propositions that were
// established and the checks that established them. Claim text is model-authored, so
// it is escaped like any other untrusted string.
const VERDICTS = { block: 'Blocked', security_review: 'Security review', nits: 'Comments', merge: 'No changes requested' };

// A check label is shown as code, so it must not be markdown-escaped — the escapes
// would render literally inside the span. Stripping backticks and control characters
// is what keeps it from breaking out of the span instead.
const code = (value: string): string => `\`${value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069`]/g, '')}\``;

function renderSurvivor(claim: Claim, chain: Chain): string {
  const e = escapeMarkdown;
  return ['', `### ${claim.severity} · ${e(claim.type)} · ${e(claim.location)}`, '',
    e(claim.description), '',
    `**Trigger:** ${e(claim.suspectedCondition)}`, '',
    `Confidence: ${chain.verifierConfidence}.`, '',
    '<details><summary>How this was established</summary>', '',
    'Propositions:', '',
    ...claim.evidenceToCheck.map(item => `- ${e(item.proposition)}`), '',
    'Checks run:', '',
    ...chain.evidence.map(item => `- ${code(item.check)} → ${e(String(item.result))}`), '',
    ...(chain.limitations.length ? [...chain.limitations.map(limit => `- Limitation: ${e(limit)}`), ''] : []),
    '</details>', ''].join('\n');
}

export function renderClaimReview(claims: Claim[], verification: Verification,
  investigation: ClaimInvestigation): string {
  const e = escapeMarkdown;
  const byId = new Map(claims.map(claim => [claim.claimId, claim]));
  const chains = verification.chains;
  const survivors = chains.filter(chain => chain.verdict === 'confirmed');
  const lines = ['# atmin review', '',
    `**${VERDICTS[verification.decision.verdict]}** — rule \`${e(verification.decision.rule)}\`, policy \`${e(verification.decision.policy)}\`.`, '',
    `${survivors.length} of ${chains.length} claim(s) survived verification.`, ''];

  if (survivors.length) {
    lines.push('## Findings', ...survivors.map(chain => renderSurvivor(byId.get(chain.claimId)!, chain)));
  }

  // The claims that died are shown, not hidden. A reviewer that emits widely and
  // verifies hard is only trustworthy if the discarding is visible.
  const discarded = chains.filter(chain => chain.verdict !== 'confirmed');
  if (discarded.length) {
    lines.push('', '## Claims that did not survive', '', '| Location | Type | Outcome |', '| --- | --- | --- |',
      ...discarded.map(chain => {
        const claim = byId.get(chain.claimId)!;
        const why = chain.verdict === 'refuted' ? 'refuted by the code' : 'not established';
        return `| ${e(claim.location)} | ${e(claim.type)} | ${why} |`;
      }), '');
  }

  const notes = [...investigation.limitations, ...verification.limitations,
    ...(investigation.complete ? [] : ['Emission did not finish, so this is not a complete pass over the change.']),
    'The cross-family rung did not run: no second-family model is configured, so no claim reached high confidence through agreement.'];
  lines.push('', '## Limitations', '', ...notes.map(note => `- ${e(note)}`), '',
    `Source inspection and literal search over the frozen revision. Nothing was executed. Model spend: $${investigation.spentUsd.toFixed(4)}.`, '');
  return lines.join('\n');
}
