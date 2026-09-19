import type { Claim, Proposition } from './claim.js';
import { composeChain, llmSignal, DEFAULT_THRESHOLDS, type Chain, type Evidence, type Thresholds } from './evidence.js';
import { runCheck, sideOf, type Revisions } from './symbolic.js';
import { decide, findingsFrom, policyRejection, type Decision, type Policy } from './policy.js';

// The verification half of the lifecycle: a claim set in, a verdict composed in code
// out. The investigator is not here, and that is the point. This runs after a context
// reset, over claims alone, so nothing the investigator argued for survives except
// what a rung can establish about the code.
// Rung 3 answers one proposition at a time, never the claim. SMOKE_TEST_JEV.md is the
// reason: factual checks came back sharp, and composite judgments clustered around a
// coin flip. "Is this an auth bypass?" is the composite question. "Does any caller
// compare owner to account before update()?" is the factual one, and it is also the
// step rung 1 could not express.
export interface CrossFamilyRung { settle(proposition: string, claim: Claim): Evidence[] }
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
  const chain = (verdict: Chain['verdict'], verifierConfidence: Chain['verifierConfidence'],
    evidence: Evidence[], limitations: string[], suspectChecks: string[] = []): { chain: Chain; limitations: string[] } =>
    ({ chain: { claimId: claim.claimId, verdict, evidence, verifierConfidence, suspectChecks, limitations }, limitations: collected });

  // One proposition shown false is enough: the argument cannot hold without it, and no
  // later rung is invited to argue with a deterministic fact.
  if (outcomes.some(outcome => outcome.status === 'refuted')) {
    return { chain: composeChain(claim.claimId, claim.severity, symbolic, thresholds), limitations: collected };
  }

  // Rung 3 is asked about every proposition: the unsettled ones because it may be the
  // only rung that can reach them, and the established ones because a model that
  // contradicts a check is reporting on the check.
  const asked = outcomes.map(outcome => {
    const evidence = crossFamily?.settle(outcome.proposition, claim) ?? [];
    return { ...outcome, model: evidence, signal: llmSignal(evidence, thresholds) };
  });
  const modelEvidence = asked.flatMap(item => item.model);
  const evidence = [...symbolic, ...modelEvidence];

  // A model that disagrees with a check is not a vote against the code. It means the
  // check is a text proxy that may not mean what its proposition says, so the claim
  // does not ship and the check is recorded for tightening.
  const contradicted = asked.filter(item => item.status === 'established' && item.signal === 'disagrees');
  if (contradicted.length) {
    return chain('inconclusive', 'low', evidence,
      ['A check the model contradicts may not establish what its proposition says.'],
      contradicted.flatMap(item => item.evidence.map(one => one.check)));
  }

  const refuted = asked.filter(item => item.status === 'unsettled' && item.signal === 'disagrees');
  if (refuted.length) {
    return chain('refuted', 'moderate', evidence,
      refuted.map(item => `The model reports this proposition does not hold: ${JSON.stringify(item.proposition)}`));
  }

  const unsettled = asked.filter(item => item.status === 'unsettled' && item.signal !== 'agrees');
  if (unsettled.length || !asked.length) {
    return chain('inconclusive', 'low', evidence,
      [evidence.length
        ? `${unsettled.length} of ${asked.length} propositions were not settled, so the claim does not follow from what was established.`
        : 'No rung produced evidence for this claim.',
      ...unsettled.map(item => `Unsettled: ${JSON.stringify(item.proposition)}`)]);
  }

  // Every step holds. An argument is only as strong as its weakest one, so a claim
  // with a step no rung but a model could reach caps at moderate however the rest of
  // it was established. Rung 2 is absent by construction in v1: it reads CI output
  // this corpus does not carry, and composeChain records that rather than passing
  // over it.
  const modelOnly = asked.some(item => item.status === 'unsettled');
  return {
    chain: composeChain(claim.claimId, claim.severity, evidence, thresholds, claim.severity,
      modelOnly ? 'moderate' : 'high'),
    limitations: collected,
  };
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
