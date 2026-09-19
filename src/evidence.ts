import type { Priority } from './contracts.js';

// The evidence chain, and the confidence rules of spec/evidence-chain.md. These are
// policy evaluated in code, never by a model: the whole point of the ladder is that
// what a finding claims about itself is derived from what was actually run.
export type Rung = 'symbolic' | 'ci_output' | 'cross_family_llm';
export type Verdict = 'confirmed' | 'refuted' | 'inconclusive';
export type Confidence = 'low' | 'moderate' | 'high';

export interface Evidence { rung: Rung; check: string; result: 'hit' | 'miss' | number }
export interface Chain {
  claimId: string;
  verdict: Verdict;
  evidence: Evidence[];
  finalSeverity?: Priority;
  verifierConfidence: Confidence;
  // Symbolic checks the cross-family rung contradicted. A check is a text proxy for
  // a proposition, so a contradiction is a report about the proxy, not a dispute
  // about the code: the guard may simply have moved into a helper the grep cannot
  // see. These are calibration input for tightening the check catalogue.
  suspectChecks: string[];
  limitations: string[];
}

// A Noul returns the probability of yes and carries no separate confidence, so
// "agrees" needs a boundary the spec does not fix. The neutral band is not
// decoration: SMOKE_TEST_JEV.md found merge_ready at 0.49, 0.41 and 0.27 and called
// it almost no information, so a probability near the middle must not be read as
// either agreement or disagreement. These defaults are a starting point for
// calibration, not a measured result.
export interface Thresholds { agreeAtOrAbove: number; disagreeAtOrBelow: number }
export const DEFAULT_THRESHOLDS: Thresholds = { agreeAtOrAbove: 0.7, disagreeAtOrBelow: 0.3 };

type Signal = 'agrees' | 'disagrees' | 'uninformative' | 'absent';

function llmSignal(evidence: Evidence[], thresholds: Thresholds): Signal {
  const probabilities = evidence.filter(e => e.rung === 'cross_family_llm' && typeof e.result === 'number')
    .map(e => e.result as number);
  if (!probabilities.length) return 'absent';
  const highest = Math.max(...probabilities);
  if (highest >= thresholds.agreeAtOrAbove) return 'agrees';
  if (highest <= thresholds.disagreeAtOrBelow) return 'disagrees';
  return 'uninformative';
}

export const isRefutation = (item: Evidence): boolean => item.rung === 'symbolic' && item.result === 'miss';

export function composeChain(claimId: string, proposedSeverity: Priority, evidence: Evidence[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS, finalSeverity = proposedSeverity): Chain {
  if (!evidence.length) throw new Error(`Claim ${claimId} needs a chain even when refuted`);
  const limitations = evidence.some(e => e.rung === 'ci_output') ? []
    : ['Rung 2 did not fire: no CI output covered this claim, so it was not settled by execution.'];
  const chain = (verdict: Verdict, verifierConfidence: Confidence, suspectChecks: string[] = []): Chain => ({
    claimId, verdict, evidence, verifierConfidence, suspectChecks, limitations,
    ...(verdict === 'confirmed' ? { finalSeverity } : {}),
  });

  // Rule 4. A deterministic refutation is the strongest answer available, and it
  // does not become less certain because a model disagrees with it.
  if (evidence.some(isRefutation)) return chain('refuted', 'high');

  const hardHit = evidence.some(e => (e.rung === 'symbolic' || e.rung === 'ci_output') && e.result === 'hit');
  const signal = llmSignal(evidence, thresholds);

  if (hardHit) {
    // Rule 3. The majority does not win, and neither does a person: every way a
    // complete argument can be contradicted is a defect on our side. Either the
    // check is a proxy that does not mean what its proposition says, or the
    // propositions do not add up to the claim, or the model is wrong. None of those
    // is a question to hand someone, so the claim does not ship and the checks it
    // rested on are recorded as suspect.
    if (signal === 'disagrees') {
      return chain('inconclusive', 'low',
        evidence.filter(e => e.rung === 'symbolic' && e.result === 'hit').map(e => e.check));
    }
    // Rule 2. One rung alone never reaches high.
    return signal === 'agrees' ? chain('confirmed', 'high') : chain('confirmed', 'moderate');
  }
  // Rule 1. LLM-only evidence caps at moderate whatever the probability.
  if (signal === 'agrees') return chain('confirmed', 'moderate');
  if (signal === 'disagrees') return chain('refuted', 'moderate');
  return chain('inconclusive', 'low');
}

export interface RungRunner { rung: Rung; run(): Evidence[] }

// Rule 4 again, as control flow rather than as composition: later rungs are not run
// after a symbolic refutation. Spending rung 2 or rung 3 on a settled claim buys
// nothing and invites a model to argue with a deterministic fact.
export function climb(runners: RungRunner[]): Evidence[] {
  const collected: Evidence[] = [];
  for (const runner of runners) {
    const produced = runner.run();
    collected.push(...produced);
    if (produced.some(isRefutation)) break;
  }
  return collected;
}
