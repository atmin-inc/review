import type { Claim, Proposition } from './claim.js';
import { climb, composeChain, DEFAULT_THRESHOLDS, type Chain, type Evidence, type Thresholds } from './evidence.js';
import { runCheck, sideOf, type Revisions } from './symbolic.js';
import { decide, findingsFrom, policyRejection, type Decision, type Policy } from './policy.js';

// The verification half of the lifecycle: a claim set in, a verdict composed in code
// out. The investigator is not here, and that is the point. This runs after a context
// reset, over claims alone, so nothing the investigator argued for survives except
// what a rung can establish about the code.
export interface CrossFamilyRung { check(claim: Claim): Evidence[] }
export interface Verification { chains: Chain[]; decision: Decision; limitations: string[] }

// A claim is an argument, and a check settles one step of it. Tracking the steps
// separately is the whole point: a grep establishes a syntactic fact, and a claim
// like "any account can update any record" needs several of those facts before it
// follows. Collapsing them let one hit stand in for the argument.
export type PropositionStatus = 'established' | 'refuted' | 'unsettled';
export interface PropositionOutcome {
  proposition: string; status: PropositionStatus; evidence: Evidence[]; limitations: string[];
}

export function settleProposition(revisions: Revisions, item: Proposition): PropositionOutcome {
  if (!item.check) {
    return { proposition: item.proposition, status: 'unsettled', evidence: [], limitations: [] };
  }
  const outcome = runCheck(sideOf(revisions, item.check), item.check);
  const result = outcome.evidence[0]?.result;
  const status: PropositionStatus = result === 'hit' ? 'established' : result === 'miss' ? 'refuted' : 'unsettled';
  return { proposition: item.proposition, status, evidence: outcome.evidence, limitations: outcome.limitations };
}

export function verifyClaim(claim: Claim, revisions: Revisions,
  crossFamily?: CrossFamilyRung, thresholds: Thresholds = DEFAULT_THRESHOLDS): { chain: Chain; limitations: string[] } {
  const outcomes = claim.evidenceToCheck.map(item => settleProposition(revisions, item));
  const collected = outcomes.flatMap(outcome => outcome.limitations);
  const symbolic = outcomes.flatMap(outcome => outcome.evidence);

  // One proposition shown false is enough: the argument cannot hold without it, and
  // no later rung is invited to argue with a deterministic fact.
  if (outcomes.some(outcome => outcome.status === 'refuted')) {
    return { chain: composeChain(claim.claimId, claim.severity, symbolic, thresholds), limitations: collected };
  }

  // An argument with an unsettled step is incomplete, not contested. Saying so keeps
  // an unfinished argument away from a person: the answer is to check the remaining
  // propositions, not to ask someone to adjudicate the ones that were checked.
  const unsettled = outcomes.filter(outcome => outcome.status === 'unsettled');
  if (unsettled.length || !outcomes.length) {
    return {
      chain: {
        claimId: claim.claimId, verdict: 'inconclusive', evidence: symbolic, verifierConfidence: 'low',
        suspectChecks: [],
        limitations: [symbolic.length
          ? `${unsettled.length} of ${outcomes.length} propositions were not settled, so the claim does not follow from what was established.`
          : 'No rung produced evidence for this claim.',
        ...unsettled.map(outcome => `Unsettled: ${JSON.stringify(outcome.proposition)}`)],
      },
      limitations: collected,
    };
  }

  // Every step established. Only now is the claim worth a model's opinion, which can
  // raise it to high or contradict a complete argument. Rung 2 is absent by
  // construction in v1: it reads CI output this corpus does not carry, and
  // composeChain records that rather than passing over it.
  const evidence = climb([
    { rung: 'symbolic', run: () => symbolic },
    { rung: 'cross_family_llm', run: () => crossFamily?.check(claim) ?? [] },
  ]);
  return { chain: composeChain(claim.claimId, claim.severity, evidence, thresholds), limitations: collected };
}

export function verifyClaims(claims: Claim[], revisions: Revisions, policy: Policy,
  crossFamily?: CrossFamilyRung, thresholds: Thresholds = DEFAULT_THRESHOLDS): Verification {
  const rejection = policyRejection(policy);
  if (rejection) throw new Error(`Policy ${JSON.stringify(policy.name)} is unusable: ${rejection}`);
  const verified = claims.map(claim => verifyClaim(claim, revisions, crossFamily, thresholds));
  const chains = verified.map(item => item.chain);
  const types = new Map(claims.map(claim => [claim.claimId, claim.type]));
  return {
    chains,
    decision: decide(findingsFrom(chains, id => types.get(id)!), policy),
    limitations: verified.flatMap(item => item.limitations),
  };
}
