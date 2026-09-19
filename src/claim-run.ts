import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadReview, sourceText } from './snapshot.js';
import { revisionFrom } from './symbolic.js';
import { investigateClaims, type ClaimInvestigation } from './investigator.js';
import { verifyClaims, type Verification } from './lifecycle.js';
import { BALANCED } from './policy.js';
import { price, type Model, type Profile } from './investigation.js';
import { openAIModel } from './openai-model.js';
import { openRouterModel } from './openrouter-model.js';
import type { Claim } from './claim.js';

// The whole lifecycle over one prepared snapshot: a wide pass emits claims, a separate
// pass settles them against the same frozen revision, and code composes the verdict.
// The two passes share no state but the claims, which is the point.
export interface ClaimReview { claims: Claim[]; investigation: ClaimInvestigation; verification: Verification }

export async function runClaimReview(directory: string, profile: Profile,
  injectedModel?: Model, signal?: AbortSignal): Promise<ClaimReview> {
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
  const verification = verifyClaims(investigation.claims, revisions, BALANCED);
  const persist = (name: string, value: unknown) => {
    const temporary = join(directory, `${name}.pending`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, join(directory, name));
  };
  persist('claims.json', investigation.claims);
  persist('verification.json', { ...verification, stopReason: investigation.stopReason, spentUsd: investigation.spentUsd });
  return { claims: investigation.claims, investigation, verification };
}
