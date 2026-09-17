import { Ajv } from 'ajv';
import { ReviewInputError, text, type Packet } from './contracts.js';
import { sourceText } from './snapshot.js';

// RepositoryState v1: a maintained description of one branch at one exact
// commit. It is review context, never finding evidence; findings still cite
// captured source reads at the reviewed revisions.
export const SECTION_KINDS = ['purpose', 'subsystem', 'flow', 'contract', 'convention', 'commands', 'deployment', 'baseline-risk', 'fragile-area'] as const;
export interface StateSection {
  id: string;
  kind: typeof SECTION_KINDS[number];
  title: string;
  summary: string;
  paths: string[]; // Path prefixes the section applies to; empty means the whole repository.
  evidence: { path: string; line: number | null }[];
  basis: 'observed' | 'inferred';
}
export interface RepositoryState {
  schemaVersion: 1;
  repository: string;
  branch: string;
  commit: string;
  generator: { name: string; version: string };
  createdAt: string;
  complete: boolean;
  limitations: string[];
  sections: StateSection[];
}
export type StateContext =
  | { status: 'stale'; commit: string; reason: string }
  | { status: 'current'; commit: string; generator: RepositoryState['generator']; createdAt: string; complete: boolean; limitations: string[];
    guidance: string; sections: StateSection[] };

const object = <T extends Record<string, object>>(properties: T) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const path = { type: 'string', minLength: 1, maxLength: 500, pattern: '^[^\\u0000\\r\\n]+$' };
export const sectionSchema = object({
  id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
  kind: { type: 'string', enum: SECTION_KINDS },
  title: { ...text, maxLength: 200 },
  summary: { ...text, maxLength: 2000 },
  paths: { type: 'array', items: path, maxItems: 20, uniqueItems: true },
  evidence: { type: 'array', minItems: 1, maxItems: 10, items: object({ path, line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } }) },
  basis: { type: 'string', enum: ['observed', 'inferred'] },
});
export const repositoryStateSchema = object({
  schemaVersion: { const: 1 },
  repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
  branch: text,
  commit: { type: 'string', pattern: '^[a-f0-9]{40}$' },
  generator: object({ name: { ...text, maxLength: 200 }, version: { ...text, maxLength: 100 } }),
  createdAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' },
  complete: { type: 'boolean' },
  limitations: { type: 'array', items: text, maxItems: 50 },
  sections: { type: 'array', items: sectionSchema, maxItems: 60 },
});
const ajv = new Ajv({ allErrors: true, strict: true });
const validateState = ajv.compile<RepositoryState>(repositoryStateSchema);
export function parseRepositoryState(value: unknown): RepositoryState {
  if (!validateState(value)) throw new Error(`Invalid repository state: ${ajv.errorsText(validateState.errors)}`);
  if (new Set(value.sections.map(section => section.id)).size !== value.sections.length) throw new Error('Invalid repository state: duplicate section ID');
  return value;
}

export const stateGuidance = 'Repository state is maintained context about the target branch, not evidence. It can be wrong or stale. Use it to choose what to investigate; every finding must still cite captured source reads at the reviewed revisions. Sections marked inferred are the generator’s conclusions rather than documented facts.';
const applies = (section: StateSection, changed: string) =>
  section.paths.length === 0 || section.paths.some(prefix => changed === prefix || changed.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
// State describes the current target commit only. A different commit is
// withheld rather than substituted, because sections may already be wrong.
export function selectRepositoryState(state: RepositoryState, packet: Packet): StateContext {
  if (state.repository.toLowerCase() !== packet.repository.toLowerCase() || state.commit !== packet.baseSha) {
    return { status: 'stale', commit: state.commit, reason: `Repository state describes ${state.repository} at ${state.commit}, not the target ${packet.repository} at ${packet.baseSha}; sections withheld.` };
  }
  return { status: 'current', commit: state.commit, generator: state.generator, createdAt: state.createdAt, complete: state.complete,
    limitations: state.limitations, guidance: stateGuidance,
    sections: state.sections.filter(section => packet.changedFiles.some(file => applies(section, file.path))) };
}
// Every reference must resolve to a text line at the state commit; a hand-edited
// or drifted artifact cannot point the reviewer at source that does not exist.
export function verifyStateEvidence(repository: string, state: RepositoryState): void {
  for (const section of state.sections) for (const reference of section.evidence) {
    const content = sourceText(repository, state.commit, reference.path);
    if (content === null) throw new ReviewInputError(`Repository state section ${section.id} cites a missing path`);
    const lineCount = content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    if (reference.line !== null && reference.line > lineCount) throw new ReviewInputError(`Repository state section ${section.id} cites a line outside its file`);
  }
}
