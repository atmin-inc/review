import { verifyClaims, type CrossFamilyAnswer, type CrossFamilyRung, type Verification } from './lifecycle.js';
import type { Revisions } from './symbolic.js';
import type { Claim } from './claim.js';
import type { Chain, Confidence, Rung, Verdict } from './evidence.js';
import type { Policy, ReviewVerdict } from './policy.js';

// Whether a rung earns its place is a measurement, not an assumption. Verification is
// deterministic and free once the claims exist, so the same claim set can be verified
// again with a rung switched off and the difference read directly. The expensive half —
// emission — is not repeated, and the model answers are replayed rather than re-asked,
// so the comparison is exact rather than a second sample of a noisy process.

// Replays what the cross-family rung answered in a recorded run. Questions outside the
// log return nothing, which is what a rung that cannot reach a proposition looks like.
// Keyed on the claim and the proposition's text, deliberately not on its revision. The
// revision is part of the question now, but two propositions of one claim that read
// identically are the same question written twice, not two questions — and leaving the
// key alone keeps recorded runs from before the revision was carried replayable exactly,
// which is what makes a past run a measurement rather than an anecdote.
export function recordedRung(log: CrossFamilyAnswer[]): CrossFamilyRung {
  const answers = new Map(log.map(entry => [`${entry.claimId}\u0000${entry.proposition}`, entry.evidence]));
  return { settle: (proposition, claim) => answers.get(`${claim.claimId}\u0000${proposition}`) ?? [] };
}

export interface Tally {
  claims: number;
  verdicts: Record<Verdict, number>;
  // Confidence of the claims that became findings. A rung that only moves claims from
  // moderate to high changed what ships, not how much.
  confidence: Record<Confidence, number>;
  propositions: Record<Rung | 'unsettled', number>;
  suspectChecks: number;
  decision: ReviewVerdict;
  rule: string;
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;

export function tally(verification: Verification): Tally {
  const counts: Tally = {
    claims: verification.chains.length,
    verdicts: zero(['confirmed', 'refuted', 'inconclusive', 'withheld'] as const),
    confidence: zero(['low', 'moderate', 'high'] as const),
    propositions: zero(['symbolic', 'ci_output', 'cross_family_llm', 'unsettled'] as const),
    suspectChecks: 0,
    decision: verification.decision.verdict,
    rule: verification.decision.rule,
  };
  for (const chain of verification.chains) {
    counts.verdicts[chain.verdict]++;
    if (chain.verdict === 'confirmed') counts.confidence[chain.verifierConfidence]++;
    counts.suspectChecks += chain.suspectChecks.length;
    for (const record of chain.propositions) counts.propositions[record.settledBy ?? 'unsettled']++;
  }
  return counts;
}

export interface RungContribution {
  rung: Rung;
  without: Tally;
  with: Tally;
  // Claims that ship only with the rung, and claims it takes away. Both matter: a rung
  // that only removes findings is still earning its place if those findings were wrong.
  gained: string[];
  lost: string[];
  raised: string[];
  refuted: string[];
  suppressed: string[];
  decisionChanged: boolean;
}

const shipped = (chains: Chain[]) => new Map(chains.filter(chain => chain.verdict === 'confirmed')
  .map(chain => [chain.claimId, chain.verifierConfidence]));
const RANK: Confidence[] = ['low', 'moderate', 'high'];

// A claim with its checks removed: every proposition survives, and none of them can be
// settled symbolically. That is what rung 1 being switched off looks like from the
// claim's side, and it leaves the claim itself untouched so the comparison stays paired.
const withoutChecks = (claim: Claim): Claim =>
  ({ ...claim, evidenceToCheck: claim.evidenceToCheck.map(({ proposition }) => ({ proposition })) });

// One rung's contribution over one claim set, measured against the same claims verified
// without it. Every other rung is held fixed — the model answers are replayed on both
// sides — so the difference is this rung and nothing else.
export function contributionOf(rung: Rung, claims: Claim[], revisions: Revisions, policy: Policy,
  log: CrossFamilyAnswer[]): RungContribution {
  if (rung === 'ci_output') throw new Error('Rung 2 does not run in v1, so there is nothing to measure');
  const replay = recordedRung(log);
  const without = rung === 'symbolic'
    ? verifyClaims(claims.map(withoutChecks), revisions, policy, replay)
    : verifyClaims(claims, revisions, policy);
  const withRung = verifyClaims(claims, revisions, policy, replay);
  const before = shipped(without.chains);
  const after = shipped(withRung.chains);
  const verdictOf = (verification: Verification) => new Map(verification.chains.map(chain => [chain.claimId, chain.verdict]));
  const priorVerdict = verdictOf(without);
  return {
    rung,
    without: tally(without), with: tally(withRung),
    gained: [...after.keys()].filter(id => !before.has(id)),
    lost: [...before.keys()].filter(id => !after.has(id)),
    raised: [...after].filter(([id, level]) => before.has(id)
      && RANK.indexOf(level) > RANK.indexOf(before.get(id)!)).map(([id]) => id),
    refuted: withRung.chains.filter(chain => chain.verdict === 'refuted'
      && priorVerdict.get(chain.claimId) !== 'refuted').map(chain => chain.claimId),
    suppressed: withRung.chains.filter(chain => chain.suspectChecks.length).map(chain => chain.claimId),
    decisionChanged: without.decision.verdict !== withRung.decision.verdict,
  };
}

export function renderContribution(contribution: RungContribution): string {
  const { without: a, with: b } = contribution;
  const row = (label: string, left: number | string, right: number | string) =>
    `| ${label} | ${left} | ${right} |`;
  return ['| | without | with |', '| --- | --- | --- |',
    row('confirmed', a.verdicts.confirmed, b.verdicts.confirmed),
    row('refuted', a.verdicts.refuted, b.verdicts.refuted),
    row('inconclusive', a.verdicts.inconclusive, b.verdicts.inconclusive),
    row('propositions settled symbolically', a.propositions.symbolic, b.propositions.symbolic),
    row('propositions settled by the model', a.propositions.cross_family_llm, b.propositions.cross_family_llm),
    row('propositions unsettled', a.propositions.unsettled, b.propositions.unsettled),
    row('findings at high confidence', a.confidence.high, b.confidence.high),
    row('verdict', a.decision, b.decision), '',
    `Claims that ship only with the rung: ${contribution.gained.length}. Claims it takes away: ${contribution.lost.length}.`,
    `Claims it refuted outright: ${contribution.refuted.length}. Checks it called into question: ${b.suspectChecks}.`,
    contribution.decisionChanged ? 'The rung changed the verdict.' : 'The rung did not change the verdict.', ''].join('\n');
}

export const contributionOfCrossFamily = (claims: Claim[], revisions: Revisions, policy: Policy,
  log: CrossFamilyAnswer[]): RungContribution => contributionOf('cross_family_llm', claims, revisions, policy, log);
