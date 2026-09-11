import { QUALITY_CRITERIA, type Packet, type Result, type QualityCriterion, type RatingPolicy } from './contracts.js';
import type { Assessment } from './assessment.js';

export const criterionLabels: Record<QualityCriterion, string> = {
  codebaseFit: 'Fits the codebase', simplicity: 'Complexity is justified',
  verification: 'Verification is appropriate', documentedConventions: 'Follows documented conventions',
};
const presetLabels = { balanced: 'Balanced', 'correctness-first': 'Correctness first', 'strict-conventions': 'Strict conventions' };
export function resolveRatingPolicy(input: RatingPolicy = { preset: 'balanced' }) {
  const holistic = input.preset !== 'correctness-first';
  return { preset: input.preset, label: presetLabels[input.preset], perfectRequires: {
    codebaseFit: holistic, simplicity: holistic, verification: holistic,
    documentedConventions: input.preset === 'strict-conventions', passingChecks: holistic, noP3: false,
    ...input.perfectRequires,
  } };
}
export interface Rating {
  score: number | null;
  policy: ReturnType<typeof resolveRatingPolicy>;
  reasons: string[];
}

// Model judgment proposes a holistic rating; deterministic caps enforce the team's
// requirements. Neither scores nor missing patches alter findings or severity.
export function rate(packet: Packet, result: Result, assessment: Pick<Assessment, 'scope' | 'freshness' | 'validation'>): Rating {
  const policy = resolveRatingPolicy(packet.policy.rating);
  const reasons: string[] = [];
  const unrated = (reason: string): Rating => ({ score: null, policy, reasons: [...reasons, reason] });
  if (assessment.scope !== 'complete') return unrated('The review must finish across all changed files before it can be rated.');
  if (assessment.freshness.status !== 'current') return unrated('The reviewed commits must match the current PR before it can be rated.');
  const holistic = policy.preset !== 'correctness-first';
  if (holistic && !result.quality) return unrated('A supported quality assessment is missing; no findings alone does not earn 5/5.');
  let score = holistic ? result.quality!.score : 5;
  reasons.push(holistic ? result.quality!.rationale : 'Correctness first rates completed reviews by established defects.');
  const cap = (maximum: number, reason: string) => {
    if (maximum <= score) { score = maximum; reasons.push(reason); }
  };
  const priorities = new Set(result.findings.map(f => f.priority));
  if (priorities.has('P0') || priorities.has('P1')) cap(1, 'A serious P0 or P1 defect caps the rating at 1/5.');
  else if (priorities.has('P2')) cap(3, 'A P2 defect requires meaningful changes and caps the rating at 3/5.');
  if (policy.perfectRequires.noP3 && priorities.has('P3')) cap(4, 'An unresolved P3 finding caps the rating at 4/5 under this policy.');
  for (const key of QUALITY_CRITERIA) {
    if (!policy.perfectRequires[key]) continue;
    const criterion = result.quality?.criteria[key];
    if (!criterion || criterion.status === 'unknown') return unrated(`${criterionLabels[key]}: ${criterion?.reason ?? 'not assessed'}`);
    if (criterion.status === 'concern') cap(4, `${criterionLabels[key]}: ${criterion.reason} (maximum 4/5).`);
  }
  if (policy.perfectRequires.passingChecks) {
    if (assessment.validation === 'missing') return unrated('Required check results are missing.');
    if (assessment.validation === 'failed') cap(4, 'A required check failed (maximum 4/5).');
  }
  return { score, policy, reasons };
}
