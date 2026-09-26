import { Ajv } from 'ajv';
import { ProviderRequestError, type ProviderFailure } from './provider-error.js';
import type { Claim } from './claim.js';
import type { Model, ModelReply, TurnInput } from './investigation.js';

// Short titles for confirmed findings, written after verification (Lors, 2026-09-24).
// A claim's description is two or three sentences, and publishing it as the title made
// every finding heading a paragraph. This step sees only claims that already shipped, so
// it cannot change what is found, verified or rated: its whole effect is a heading. It
// is one call, and any failure leaves the description as the title and says why.

export const TITLE_MAX = 80;
const MAX_OUTPUT_TOKENS = 2048;

const tool = {
  name: 'record_titles',
  description: 'Record one short title per finding, in the order given.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['titles'],
    properties: { titles: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['claimId', 'title'],
      properties: {
        claimId: { type: 'string', minLength: 1, maxLength: 200 },
        title: { type: 'string', minLength: 3, maxLength: TITLE_MAX, pattern: '^[^\\r\\n]+$' },
      } } } },
  },
};
const valid = new Ajv({ strict: true }).compile<{ titles: { claimId: string; title: string }[] }>(tool.parameters);

const instructions = `You title code review findings. Each finding below was already verified; do not judge it.
For each, write a title of at most ${TITLE_MAX} characters that names the defect itself, the way an engineer would title a bug:
what goes wrong, in plain words, specific to this code. No priority, file name, line number or trailing period.
Do not hedge ("may", "might", "potential"). Examples of the shape: "Restore reports success when the copy fails",
"Delete can remove a sandbox another runtime just created", "Retry count lost under concurrent reminders".
Call record_titles once with every finding.`;

export interface Titling {
  titles: Record<string, string>;
  spentUsd: number;
  // The request was made and its charge is not known, so spentUsd is its reservation.
  unsettled: boolean;
  inputTokens: number;
  outputTokens: number;
  // Why no titles were written, as an allowlisted reason. Never provider text: it can
  // carry repository content.
  failure: 'budget' | 'invalid-reply' | 'incomplete' | 'aborted' | ProviderFailure['kind'] | 'error' | null;
}

export async function titleClaims(claims: Claim[], model: Model, costOf: (input: number, output: number) => number,
  charged: (reply: ModelReply) => number | null, budgetUsd: number, signal: AbortSignal): Promise<Titling> {
  const outcome: Titling = { titles: {}, spentUsd: 0, unsettled: false, inputTokens: 0, outputTokens: 0, failure: null };
  if (!claims.length) return outcome;
  const input: TurnInput = { instructions, transcript: [], tools: [tool] as unknown as TurnInput['tools'],
    context: JSON.stringify({ findings: claims.map(claim => ({ claimId: claim.claimId, type: claim.type,
      location: claim.location, description: claim.description, trigger: claim.suspectedCondition })) }) };
  try {
    const reservation = costOf(await model.count(input, signal), MAX_OUTPUT_TOKENS);
    if (reservation > budgetUsd) return { ...outcome, failure: 'budget' };
    // An unanswered request stays charged at its reservation, as in the claim pass.
    outcome.spentUsd = reservation; outcome.unsettled = true;
    const reply = await model.respond(input, MAX_OUTPUT_TOKENS, signal);
    const charge = charged(reply);
    outcome.spentUsd = charge ?? reservation; outcome.unsettled = charge === null;
    outcome.inputTokens = reply.inputTokens;
    outcome.outputTokens = reply.outputTokens;
    if (reply.status !== 'completed') return { ...outcome, failure: 'incomplete' };
    const call = reply.calls.find(item => item.name === tool.name);
    let data: unknown;
    try { data = call ? JSON.parse(call.arguments) : undefined; } catch { data = undefined; }
    if (!valid(data)) return { ...outcome, failure: 'invalid-reply' };
    const known = new Set(claims.map(claim => claim.claimId));
    for (const { claimId, title } of data.titles) if (known.has(claimId)) outcome.titles[claimId] = title.trim().replace(/\.$/, '');
    return outcome;
  } catch (error) {
    // A deadline or cancellation must not take the finished review down with it.
    if (signal.aborted) return { ...outcome, failure: 'aborted' };
    return { ...outcome, failure: error instanceof ProviderRequestError ? error.failure.kind : 'error' };
  }
}
