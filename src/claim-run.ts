import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadReview, sourceText } from './snapshot.js';
import { revisionFrom } from './symbolic.js';
import { investigateClaims, type ClaimInvestigation } from './investigator.js';
import { verifyClaims, type CrossFamilyRung, type Verification, type VerifyOptions } from './lifecycle.js';
import { contributionOf, recordedRung, type RungContribution } from './ablation.js';
import { askJev } from './jev.js';
import { BALANCED } from './policy.js';
import { price, type Model, type Profile } from './investigation.js';
import { openAIModel } from './openai-model.js';
import { openRouterModel } from './openrouter-model.js';
import type { Claim } from './claim.js';
import type { Rung } from './evidence.js';

// The whole lifecycle over one prepared snapshot: a wide pass emits claims, a separate
// pass settles them against the same frozen revision, and code composes the verdict.
// The two passes share no state but the claims, which is the point.
export interface ClaimReview { claims: Claim[]; investigation: ClaimInvestigation; verification: Verification }

// How rung 3 is answered for this run. 'none' leaves it silent, which is what every
// run before this one did. 'jev' asks the TypeSafe API once per surviving claim,
// before verification, and the verifier then replays those answers — see jev.ts for
// why the asking is its own phase.
export type CrossFamilySource = 'none' | 'jev';

export async function runClaimReview(directory: string, profile: Profile,
  injectedModel?: Model, signal?: AbortSignal, crossFamily?: CrossFamilyRung,
  crossFamilySource: CrossFamilySource = 'none', verify: VerifyOptions = {}): Promise<ClaimReview> {
  const { packet } = loadReview(directory);
  if (profile.provider === 'codex-local' && !injectedModel) {
    throw new Error('Local subscription experiments require the benchmark Codex adapter; hosted execution is not supported');
  }
  const model = injectedModel ?? (profile.provider === 'openrouter' ? openRouterModel(profile) : openAIModel(profile));
  const repository = join(directory, 'source.git');
  // Both sides, because a claim about a regression is a claim about the difference.
  const revisions = { head: revisionFrom(repository, packet.headSha), base: revisionFrom(repository, packet.mergeBaseSha) };
  const sourceOf = (path: string) => sourceText(repository, packet.headSha, path);

  const diff = readFileSync(join(directory, 'change.diff'));
  if (diff.length > 128000) throw new Error('Diff exceeds 128 KB investigation limit');
  const context = { packet, diff: diff.toString('utf8') };

  const investigation = await investigateClaims(revisions, sourceOf, context, model, {
    maxTurns: profile.maxTurns, maxToolCalls: profile.maxToolCalls,
    maxInputTokens: profile.maxInputTokens, maxOutputTokens: profile.maxOutputTokens,
    maxUsd: profile.maxUsd,
    costOf: (input, output) => profile.provider === 'codex-local' ? 0 : price(input, output, 0, profile.model),
  }, signal);

  // The verifier is handed the claims and the revision, and nothing else. Whatever the
  // investigator believed does not travel with them.
  let rung = crossFamily;
  if (!rung && crossFamilySource === 'jev' && investigation.claims.length) {
    rung = recordedRung((await askJev(investigation.claims, revisions, context.diff, { signal, verify })).log);
  }
  const verification = verifyClaims(investigation.claims, revisions, BALANCED, rung, undefined, verify);
  const persist = (name: string, value: unknown) => {
    const temporary = join(directory, `${name}.pending`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, join(directory, name));
  };
  persist('claims.json', investigation.claims);
  persist('verification.json', { ...verification, stopReason: investigation.stopReason, spentUsd: investigation.spentUsd });
  return { claims: investigation.claims, investigation, verification };
}

// The same claims, verified again with the cross-family rung switched off. Emission is
// not repeated and the model is not re-asked — the recorded answers are replayed — so
// the difference is the rung's contribution and nothing else.
export function ablate(directory: string, rung: Rung = 'cross_family_llm'): RungContribution {
  const { packet } = loadReview(directory);
  const repository = join(directory, 'source.git');
  const revisions = { head: revisionFrom(repository, packet.headSha), base: revisionFrom(repository, packet.mergeBaseSha) };
  const read = (name: string) => {
    const bytes = readFileSync(join(directory, name));
    if (bytes.length > 16_000_000) throw new Error(`${name} exceeds the 16 MB replay limit`);
    return JSON.parse(bytes.toString('utf8'));
  };
  const verification = read('verification.json') as Verification;
  if (!Array.isArray(verification.crossFamilyLog)) throw new Error('This run predates cross-family recording; re-run claim-review to measure the rung');
  return contributionOf(rung, read('claims.json'), revisions, BALANCED, verification.crossFamilyLog);
}
