import { propositionSide, type Claim, type Proposition } from './claim.js';
import type { PropositionStatus } from './evidence.js';
import { composeChain, llmSignal, DEFAULT_THRESHOLDS, type Chain, type Evidence, type PropositionRecord, type Thresholds } from './evidence.js';
import { runCheck, type Revisions, type Side, type SymbolicCheck } from './symbolic.js';
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
// The revision is passed, not implied. A rung that is sent both sides of a change and
// asked an unqualified sentence will answer for whichever side it reads as the subject,
// and it will not be wrong to do so.
export interface CrossFamilyRung { settle(proposition: string, claim: Claim, revision: Side): Evidence[] }
export interface Verification { chains: Chain[]; decision: Decision; limitations: string[]; crossFamilyLog: CrossFamilyAnswer[] }
// Off by default: `questionRefutations` reverses the rule that no rung argues with a
// deterministic refutation, and every claim it saves costs a model call on a claim that
// was meant to die on rung 1 for nothing. A flag rather than a change so the two can be
// compared over the same claims, which is the only way to say what it is worth.
export interface VerifyOptions { questionRefutations?: boolean }
// Every question the cross-family rung was asked and what it answered. Recording them
// is what makes the rung's contribution measurable: the same claims can be verified
// again with the rung replayed or switched off, exactly and for free, instead of a
// second run that spends money and answers differently.
export interface CrossFamilyAnswer { claimId: string; proposition: string; revision: Side; evidence: Evidence[] }

// A claim is an argument, and a check settles one step of it. Tracking the steps
// separately is the whole point: a grep establishes a syntactic fact, and a claim
// like "any account can update any record" needs several of those facts before it
// follows. Collapsing them let one hit stand in for the argument.
export interface PropositionOutcome {
  proposition: string; revision: Side; status: PropositionStatus; evidence: Evidence[]; limitations: string[];
}

// A miss refutes only when it rests on finding something. With `expect: 'absent'` it
// does: the pattern was there, which contradicts the proposition outright. With
// `expect: 'present'` it rests on NOT finding a literal string, and absence of a string
// is not absence of the property the proposition names — the comparison may have moved
// to a helper, or be spelled another way.
//
// That inference fails hardest in the one place a review looks. If the same pattern is
// on the other side of the change, the miss IS the change, and a claim about the change
// cannot be refuted by the change itself. Measured 2026-09-20 on PR #2: the proposition
// "the account object has an ownerId property" was checked as
// body_contains(renameAccount, "ownerId") at head, where the very deletion being
// reported guarantees the miss. That refuted a correct auth_bypass, and refuted is the
// strongest verdict there is — worse than the inconclusive an unsettled step gives,
// because it asserts the claim is false rather than unproven.
//
// So such a miss is downgraded to unsettled and handed to a later rung, which is what
// an unreached proposition has always meant. A miss that is not circular still refutes.
function removedByTheChange(revisions: Revisions, check: SymbolicCheck): boolean {
  if ((check.expect ?? 'present') !== 'present') return false;
  const otherSide: Side = check.revision === 'base' ? 'head' : 'base';
  const other = otherSide === 'base' ? revisions.base : revisions.head;
  return runCheck(other, { ...check, revision: otherSide }).evidence[0]?.result === 'hit';
}

export function settleProposition(revisions: Revisions, item: Proposition): PropositionOutcome {
  // Resolved once, here, and carried on the outcome, so rung 1 and rung 3 cannot end up
  // asking about different sides of the change. A check that omits the side inherits the
  // proposition's rather than silently defaulting to head, which is the case that used to
  // send rung 1 to the wrong revision without anything recording it.
  const revision = propositionSide(item);
  if (!item.check) {
    return { proposition: item.proposition, revision, status: 'unsettled', evidence: [], limitations: [] };
  }
  const check: SymbolicCheck = { ...item.check, revision };
  const outcome = runCheck(revision === 'base' ? revisions.base : revisions.head, check);
  const result = outcome.evidence[0]?.result;
  let status: PropositionStatus = result === 'hit' ? 'established' : result === 'miss' ? 'refuted' : 'unsettled';
  const limitations = [...outcome.limitations];
  if (status === 'refuted' && removedByTheChange(revisions, check)) {
    status = 'unsettled';
    limitations.push(`${outcome.evidence[0]!.check}: the pattern is present on the other side of the change, so this miss is the change itself and cannot refute a claim about it.`);
  }
  return { proposition: item.proposition, revision, status, evidence: outcome.evidence, limitations };
}

export function verifyClaim(claim: Claim, revisions: Revisions, crossFamily?: CrossFamilyRung,
  thresholds: Thresholds = DEFAULT_THRESHOLDS, options: VerifyOptions = {}): { chain: Chain; limitations: string[]; asked: CrossFamilyAnswer[] } {
  const outcomes = claim.evidenceToCheck.map(item => settleProposition(revisions, item));
  const collected = outcomes.flatMap(outcome => outcome.limitations);
  const symbolic = outcomes.flatMap(outcome => outcome.evidence);
  const log: CrossFamilyAnswer[] = [];
  const chain = (verdict: Chain['verdict'], verifierConfidence: Chain['verifierConfidence'], evidence: Evidence[],
    propositions: PropositionRecord[], limitations: string[], suspectChecks: string[] = []) =>
    ({ chain: { claimId: claim.claimId, verdict, evidence, verifierConfidence, propositions, suspectChecks, limitations },
      limitations: collected, asked: log });

  // One proposition shown false is enough: the argument cannot hold without it, and no
  // later rung is invited to argue with a deterministic fact.
  //
  // Except that refutation is the strongest verdict available and, by that rule, the
  // least protected one. `suspectChecks` exists to catch a check that does not mean what
  // its proposition says, and returning here means it only ever guards propositions a
  // check ESTABLISHED. A mismatched check is just as wrong when it refutes. Measured
  // 2026-09-20: "there is no other function or middleware that enforces ownership" was
  // checked with referenced_outside(renameAccount, expect: 'absent'), which asks whether
  // the function is called at all; the test file calls it, so the check missed and a
  // correct auth_bypass died with no rung able to see the mismatch.
  //
  // `questionRefutations` asks rung 3 before letting that happen, and is off by default
  // because it reverses the rule above and costs a call. It is narrow on purpose: only
  // when a single check carries the whole refutation is there one point of failure worth
  // paying for. If the model agrees the proposition holds, the check is contradicted and
  // the claim becomes inconclusive rather than false — the same treatment an established
  // check gets. Otherwise the refutation stands exactly as it would have, so the flag
  // either reverses a refutation or changes nothing.
  const refuted = outcomes.filter(outcome => outcome.status === 'refuted');
  if (refuted.length) {
    const sole = options.questionRefutations && refuted.length === 1 && refuted[0]!.evidence.length === 1
      ? refuted[0]! : null;
    const questioned = sole ? crossFamily?.settle(sole.proposition, claim, sole.revision) ?? [] : [];
    if (questioned.length) log.push({ claimId: claim.claimId, proposition: sole!.proposition, revision: sole!.revision, evidence: questioned });
    if (sole && llmSignal(questioned, thresholds) === 'agrees') {
      const records: PropositionRecord[] = outcomes.map(outcome => outcome === sole
        ? { proposition: outcome.proposition, status: 'unsettled' as const, settledBy: null }
        : { proposition: outcome.proposition, status: outcome.status, settledBy: outcome.status === 'unsettled' ? null : 'symbolic' });
      return chain('inconclusive', 'low', [...symbolic, ...questioned], records,
        ['A check the model contradicts may not establish what its proposition says.'],
        sole.evidence.map(one => one.check));
    }
    const records: PropositionRecord[] = outcomes.map(outcome =>
      ({ proposition: outcome.proposition, status: outcome.status, settledBy: outcome.status === 'unsettled' ? null : 'symbolic' }));
    return { chain: { ...composeChain(claim.claimId, claim.severity, symbolic, thresholds), propositions: records }, limitations: collected, asked: log };
  }

  // Rung 3 is asked about every proposition: the unsettled ones because it may be the
  // only rung that can reach them, and the established ones because a model that
  // contradicts a check is reporting on the check.
  const asked = outcomes.map(outcome => {
    const evidence = crossFamily?.settle(outcome.proposition, claim, outcome.revision) ?? [];
    if (evidence.length) log.push({ claimId: claim.claimId, proposition: outcome.proposition, revision: outcome.revision, evidence });
    return { ...outcome, model: evidence, signal: llmSignal(evidence, thresholds) };
  });
  const evidence = [...symbolic, ...asked.flatMap(item => item.model)];
  const records: PropositionRecord[] = asked.map(item => item.status !== 'unsettled'
    ? { proposition: item.proposition, status: item.status, settledBy: 'symbolic' }
    : item.signal === 'agrees' ? { proposition: item.proposition, status: 'established', settledBy: 'cross_family_llm' }
    : item.signal === 'disagrees' ? { proposition: item.proposition, status: 'refuted', settledBy: 'cross_family_llm' }
    : { proposition: item.proposition, status: 'unsettled', settledBy: null });

  // A model that disagrees with a check is not a vote against the code. It means the
  // check is a text proxy that may not mean what its proposition says, so the claim
  // does not ship and the check is recorded for tightening.
  const contradicted = asked.filter(item => item.status === 'established' && item.signal === 'disagrees');
  if (contradicted.length) {
    return chain('inconclusive', 'low', evidence, records,
      ['A check the model contradicts may not establish what its proposition says.'],
      contradicted.flatMap(item => item.evidence.map(one => one.check)));
  }

  const denied = records.filter(record => record.status === 'refuted');
  if (denied.length) {
    return chain('refuted', 'moderate', evidence, records,
      denied.map(record => `The model reports this proposition does not hold: ${JSON.stringify(record.proposition)}`));
  }

  const unsettled = records.filter(record => record.status === 'unsettled');
  if (unsettled.length || !records.length) {
    return chain('inconclusive', 'low', evidence, records,
      [evidence.length
        ? `${unsettled.length} of ${records.length} propositions were not settled, so the claim does not follow from what was established.`
        : 'No rung produced evidence for this claim.',
      ...unsettled.map(record => `Unsettled: ${JSON.stringify(record.proposition)}`)]);
  }

  // Every step holds. An argument is only as strong as its weakest one, so a claim
  // with a step no rung but a model could reach caps at moderate however the rest of
  // it was established. Rung 2 is absent by construction in v1: it reads CI output
  // this corpus does not carry, and composeChain records that rather than passing
  // over it.
  const modelOnly = records.some(record => record.settledBy === 'cross_family_llm');
  return {
    chain: { ...composeChain(claim.claimId, claim.severity, evidence, thresholds, claim.severity,
      modelOnly ? 'moderate' : 'high'), propositions: records },
    limitations: collected, asked: log,
  };
}

export function verifyClaims(claims: Claim[], revisions: Revisions, policy: Policy, crossFamily?: CrossFamilyRung,
  thresholds: Thresholds = DEFAULT_THRESHOLDS, options: VerifyOptions = {}): Verification {
  const rejection = policyRejection(policy);
  if (rejection) throw new Error(`Policy ${JSON.stringify(policy.name)} is unusable: ${rejection}`);
  const verified = claims.map(claim => verifyClaim(claim, revisions, crossFamily, thresholds, options));
  const chains = verified.map(item => item.chain);
  const types = new Map(claims.map(claim => [claim.claimId, claim.type]));
  return {
    chains,
    decision: decide(findingsFrom(chains, id => types.get(id)!), policy),
    limitations: verified.flatMap(item => item.limitations),
    crossFamilyLog: verified.flatMap(item => item.asked),
  };
}
