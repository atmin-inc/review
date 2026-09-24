import { Ajv } from 'ajv';

// Controller-authored validation messages only; never wrap provider or OS errors.
export class ReviewInputError extends Error {
  /** Schema paths behind a rejection, for telemetry; never shown to the model. */
  detail?: string;
}

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type Priority = typeof PRIORITIES[number];
export const RATING_PRESETS = ['balanced', 'correctness-first', 'strict-conventions'] as const;
export const QUALITY_CRITERIA = ['codebaseFit', 'simplicity', 'verification', 'documentedConventions'] as const;
export type QualityCriterion = typeof QUALITY_CRITERIA[number];
export interface RatingPolicy {
  preset: typeof RATING_PRESETS[number];
  perfectRequires?: Partial<Record<QualityCriterion | 'passingChecks' | 'noP3', boolean>>;
}
export interface QualityReview {
  score: number;
  rationale: string;
  criteria: Record<QualityCriterion, { status: 'satisfied' | 'concern' | 'unknown'; reason: string; evidenceIds: string[] }>;
  conventionRules: { path: string; quote: string }[];
}
export interface Policy {
  schemaVersion: 1;
  rubricVersion: '1';
  includeOptional: boolean;
  requiredChecks: string[];
  rating?: RatingPolicy;
}
export interface ChangedFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  kind: 'text' | 'binary' | 'symlink' | 'submodule';
}
export interface Packet {
  schemaVersion: 1;
  repository: string;
  pr: number;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  createdAt: string;
  policy: Policy;
  policyHash: string;
  diffHash: string;
  changedFiles: ChangedFile[];
}
export interface Anchor {
  path: string;
  side: 'head' | 'base'; // base is the captured merge base, not today's target.
  line: number;
}
export type EvidenceAnchor = Omit<Anchor, 'line'> & { line: number | null };
interface EvidenceBase {
  id: string;
  summary: string;
  anchors: EvidenceAnchor[]; // null line cites the whole file, including an empty file.
}
export type Evidence = EvidenceBase & (
  { kind: 'source-reasoning' | 'reproduction' | 'ci'; provenance: 'declared' }
  | { kind: 'source-read'; provenance: 'controller-captured'; capture: {
    revision: string; startLine: number; endLine: number; totalLines: number; contentHash: string;
  } }
);
export interface Finding {
  id: string;
  priority: Priority;
  kind: 'defect' | 'improvement';
  category: 'correctness' | 'security' | 'data-integrity' | 'reliability' | 'validation' | 'simplicity';
  title: string;
  trigger: string;
  consequence: string;
  priorityReason: string;
  counterEvidence: string;
  // Absent when the reviewer proposed no change, as with most claim-pipeline findings;
  // the report then leads with the consequence rather than a placeholder fix.
  suggestion?: string;
  anchor: Anchor;
  evidenceIds: string[];
  fix?: { startLine: number; endLine: number; original: string; replacement: string };
}
export interface Result {
  schemaVersion: 1;
  headSha: string;
  baseSha: string;
  policyHash: string;
  status: 'not-started' | 'partial' | 'completed';
  reviewer: { name: string; model: string; context: 'independent' | 'author' | 'unknown' };
  summary: string;
  coverage: { path: string; status: 'reviewed' | 'unreviewed'; evidenceIds: string[] }[];
  validation: { name: string; status: 'pass' | 'fail' | 'not-run' | 'not-applicable'; reason: string; evidenceIds: string[] }[];
  evidence: Evidence[];
  findings: Finding[];
  limitations: string[];
  quality?: QualityReview;
}

// Small schema constructors keep every object closed without a second schema framework.
// Explicit whole-string matching also works with provider grammar decoders.
export const text = { type: 'string', minLength: 1, maxLength: 16000, pattern: '^[\\s\\S]*\\S[\\s\\S]*$' };
const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const choice = (values: readonly string[]) => ({ type: 'string', enum: values });
const array = <T extends object>(items: T, minItems = 0) => ({ type: 'array', items, minItems, maxItems: 10000 });
const object = <T extends Record<string, object>>(properties: T) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const refs = { ...array(text), uniqueItems: true };
const anchor = object({ path: text, side: choice(['head', 'base']), line: { type: 'integer', minimum: 1 } });
export const fixSchema = object({
  startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
  original: { type: 'string', maxLength: 4000 }, replacement: { type: 'string', maxLength: 4000 },
});
const evidenceAnchor = object({ path: text, side: choice(['head', 'base']), line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } });
export const ratingPolicySchema = { ...object({
  preset: choice(RATING_PRESETS),
  perfectRequires: { ...object(Object.fromEntries([...QUALITY_CRITERIA, 'passingChecks', 'noP3'].map(key => [key, { type: 'boolean' }]))), required: [] },
}), required: ['preset'] };
export const qualitySchema = object({
  score: { type: 'integer', minimum: 1, maximum: 5 }, rationale: text,
  criteria: object(Object.fromEntries(QUALITY_CRITERIA.map(key => [key, object({
    status: choice(['satisfied', 'concern', 'unknown']), reason: text, evidenceIds: refs,
  })]))),
  conventionRules: { ...array(object({ path: text, quote: { ...text, maxLength: 2000 } })), maxItems: 20 },
});
const policyFields = object({
  schemaVersion: { const: 1 }, rubricVersion: { const: '1' },
  includeOptional: { type: 'boolean' }, requiredChecks: { ...array(text), uniqueItems: true },
});
export const policySchema = { ...policyFields, properties: { ...policyFields.properties, rating: ratingPolicySchema } };
export const packetSchema = object({
  schemaVersion: { const: 1 },
  repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
  pr: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  baseRef: text, headSha: sha, baseSha: sha, mergeBaseSha: sha,
  createdAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' },
  policy: policySchema, policyHash: digest, diffHash: digest,
  changedFiles: array(object({ path: text, change: choice(['added', 'modified', 'deleted']), kind: choice(['text', 'binary', 'symlink', 'submodule']) })),
});
export const findingSchema = object({
  id: text, priority: choice(PRIORITIES), kind: choice(['defect', 'improvement']),
  category: choice(['correctness', 'security', 'data-integrity', 'reliability', 'validation', 'simplicity']),
  title: text, trigger: text, consequence: text, priorityReason: text, counterEvidence: text,
  suggestion: text, anchor, evidenceIds: { ...refs, minItems: 1 },
});
const resultFields = object({
  schemaVersion: { const: 1 }, headSha: sha, baseSha: sha, policyHash: digest,
  status: choice(['not-started', 'partial', 'completed']),
  reviewer: object({ name: text, model: text, context: choice(['independent', 'author', 'unknown']) }),
  summary: text,
  coverage: array(object({ path: text, status: choice(['reviewed', 'unreviewed']), evidenceIds: refs })),
  validation: array(object({ name: text, status: choice(['pass', 'fail', 'not-run', 'not-applicable']), reason: text, evidenceIds: refs })),
  evidence: array({ oneOf: [object({
    id: text, kind: choice(['source-reasoning', 'reproduction', 'ci']), provenance: { const: 'declared' },
    summary: text, anchors: array(evidenceAnchor, 1),
  }), object({
    id: text, kind: { const: 'source-read' }, provenance: { const: 'controller-captured' },
    summary: text, anchors: { ...array(evidenceAnchor, 1), maxItems: 1 },
    capture: object({ revision: sha, startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 0 }, totalLines: { type: 'integer', minimum: 0 }, contentHash: digest }),
  })] }),
  findings: array({ ...findingSchema, properties: { ...findingSchema.properties, fix: fixSchema },
    required: findingSchema.required.filter(key => key !== 'suggestion') }),
  limitations: array(text),
});
export const resultSchema = { ...resultFields, properties: { ...resultFields.properties, quality: qualitySchema } };

const ajv = new Ajv({ allErrors: true, strict: true });
const validatePacketSchema = ajv.compile<Packet>(packetSchema);
const validateResultSchema = ajv.compile<Result>(resultSchema);
const validatePolicySchema = ajv.compile<Policy>(policySchema);
export function parsePacket(value: unknown): Packet {
  if (!validatePacketSchema(value)) throw new Error(`Invalid packet: ${ajv.errorsText(validatePacketSchema.errors)}`);
  return value;
}
export function parseResult(value: unknown): Result {
  if (!validateResultSchema(value)) throw new Error(`Invalid result: ${ajv.errorsText(validateResultSchema.errors)}`);
  return value;
}
export function parsePolicy(value: unknown): Policy {
  if (!validatePolicySchema(value)) throw new Error(`Invalid policy: ${ajv.errorsText(validatePolicySchema.errors)}`);
  // Fixed ordering provides stable hashing independent of JSON property order.
  const policy: Policy = { schemaVersion: 1, rubricVersion: '1', includeOptional: value.includeOptional, requiredChecks: value.requiredChecks };
  if (value.rating) {
    policy.rating = { preset: value.rating.preset };
    const overrides = value.rating.perfectRequires;
    if (overrides) {
      const keys = [...QUALITY_CRITERIA, 'passingChecks', 'noP3'] as const;
      policy.rating.perfectRequires = Object.fromEntries(keys.filter(key => overrides[key] !== undefined).map(key => [key, overrides[key]]));
    }
  }
  return policy;
}
export const defaultPolicy = (): Policy => ({ schemaVersion: 1, rubricVersion: '1', includeOptional: false, requiredChecks: ['change-validation'] });

export function initialResult(packet: Packet): Result {
  return {
    schemaVersion: 1, headSha: packet.headSha, baseSha: packet.baseSha, policyHash: packet.policyHash,
    status: 'not-started', reviewer: { name: 'unknown', model: 'unknown', context: 'unknown' },
    summary: 'The snapshot is captured. Investigation has not run.',
    coverage: packet.changedFiles.map(({ path }) => ({ path, status: 'unreviewed', evidenceIds: [] })),
    validation: packet.policy.requiredChecks.map(name => ({ name, status: 'not-run', reason: 'Required validation has not run.', evidenceIds: [] })),
    evidence: [], findings: [], limitations: ['Investigation has not started; no repository code has been executed.'],
  };
}
