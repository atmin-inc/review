import type { Claim } from './claim.js';
import { climb, composeChain, DEFAULT_THRESHOLDS, type Chain, type Evidence, type Thresholds } from './evidence.js';
import { runChecks, type Revision } from './symbolic.js';
import { decide, findingsFrom, policyRejection, type Decision, type Policy } from './policy.js';

// The verification half of the lifecycle: a claim set in, a verdict composed in code
// out. The investigator is not here, and that is the point. This runs after a context
// reset, over claims alone, so nothing the investigator argued for survives except
// what a rung can establish about the code.
export interface CrossFamilyRung { check(claim: Claim): Evidence[] }
export interface Verification { chains: Chain[]; decision: Decision; limitations: string[] }

export function verifyClaim(claim: Claim, revision: Revision,
  crossFamily?: CrossFamilyRung, thresholds: Thresholds = DEFAULT_THRESHOLDS): { chain: Chain; limitations: string[] } {
  const collected: string[] = [];
  const evidence = climb([
    { rung: 'symbolic', run: () => {
      const outcome = runChecks(revision, claim.symbolicChecks ?? []);
      collected.push(...outcome.limitations);
      return outcome.evidence;
    } },
    // Rung 2 is absent by construction in v1: it reads CI output that this corpus
    // does not carry. composeChain records that rather than passing over it.
    { rung: 'cross_family_llm', run: () => crossFamily?.check(claim) ?? [] },
  ]);
  if (!evidence.length) {
    // A claim no rung could touch is not refuted and not confirmed. Saying so is the
    // honest outcome; treating it as either would be the dishonest one.
    return {
      chain: { claimId: claim.claimId, verdict: 'inconclusive', evidence: [], verifierConfidence: 'low',
        routeToHuman: false, limitations: ['No rung produced evidence for this claim.'] },
      limitations: collected,
    };
  }
  return { chain: composeChain(claim.claimId, claim.severity, evidence, thresholds), limitations: collected };
}

export function verifyClaims(claims: Claim[], revision: Revision, policy: Policy,
  crossFamily?: CrossFamilyRung, thresholds: Thresholds = DEFAULT_THRESHOLDS): Verification {
  const rejection = policyRejection(policy);
  if (rejection) throw new Error(`Policy ${JSON.stringify(policy.name)} is unusable: ${rejection}`);
  const verified = claims.map(claim => verifyClaim(claim, revision, crossFamily, thresholds));
  const chains = verified.map(item => item.chain);
  const types = new Map(claims.map(claim => [claim.claimId, claim.type]));
  return {
    chains,
    decision: decide(findingsFrom(chains, id => types.get(id)!), policy),
    limitations: verified.flatMap(item => item.limitations),
  };
}
