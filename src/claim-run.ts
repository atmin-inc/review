import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadReview, sourceText } from './snapshot.js';
import { revisionFrom } from './symbolic.js';
import { investigateClaims, type ClaimInvestigation } from './investigator.js';
import { verifyClaims, type CrossFamilyRung, type Verification, type VerifyOptions } from './lifecycle.js';
import { contributionOf, recordedRung, type RungContribution } from './ablation.js';
import { askJev } from './jev.js';
import { BALANCED } from './policy.js';
import { price, subscription, type Model, type Profile } from './investigation.js';
import { openAIModel } from './openai-model.js';
import { openRouterModel } from './openrouter-model.js';
import { parseLocation, type Claim } from './claim.js';
import type { Rung } from './evidence.js';
import type { Packet } from './contracts.js';

// The whole lifecycle over one prepared snapshot: a wide pass emits claims, a separate
// pass settles them against the same frozen revision, and code composes the verdict.
// The two passes share no state but the claims, which is the point.
// `claims` is everything verified: carried claims first on an incremental run, then the
// ones this run emitted, which are also `investigation.claims`.
export interface ClaimReview { claims: Claim[]; investigation: ClaimInvestigation; verification: Verification }

// How rung 3 is answered for this run. 'none' leaves it silent, which is what every
// run before this one did. 'jev' asks the TypeSafe API once per surviving claim,
// before verification, and the verifier then replays those answers — see jev.ts for
// why the asking is its own phase.
export type CrossFamilySource = 'none' | 'jev';

// The whole diff goes into every turn of the claim pass. 128 KB refused 29% of the PRs on
// the first real repository measured (mason-v1, 2026-09-24); 512 KB refuses 7%. A diff
// this size needs a profile whose input cap leaves room to read beside it: the OpenRouter
// adapter counts serialized bytes, not tokens, and the diff is escaped twice on the way,
// so a diff counts about 1.2 times its size (measured on a 471 KB mason-v1 diff). The
// production profile allows 1,000,000, under Luna's 1.05M-token window (`profiles/review-luna-openrouter.json`).
export const MAX_DIFF_BYTES = 512 * 1024;

// An incremental review reads only the commits pushed since an earlier review of the same
// PR, and re-verifies that review's surviving claims against the new revision instead of
// asking a model to find them again. `diff` is the diff from `since` to the new head;
// verification still runs against the merge base, so every claim remains a claim about
// the whole change. `changed` is the paths the pushed commits touch.
export interface IncrementalScope { since: string; diff: Buffer; carried: Claim[]; changed: string[] }

// A carried claim is re-verified on the propositions it was recorded with, and a fix can
// remove a premise none of them states. Measured 2026-09-24 on a real push (mason-v1):
// the fix wrapped a read-then-delete in an advisory lock, every recorded proposition (the
// read, the comparison, the delete by name) stayed true, and the fixed race was confirmed
// again. So a claim whose file the push changed, or a file one of its checks names, is not
// carried on its own: the model is shown it and records it again only if it still holds.
// A fix made in a file the claim never names still escapes this.
export function touchedBy(claim: Claim, changed: ReadonlySet<string>): boolean {
  const checked = claim.evidenceToCheck.flatMap(item => item.check && 'path' in item.check ? [item.check.path] : []);
  return [parseLocation(claim.location).path, ...checked].some(path => changed.has(path));
}

// The target's own AGENTS.md files: the root one and one in each directory above a changed
// path, read from the target branch so a change cannot rewrite the rules it is reviewed
// against. The older engine loaded these (investigation.ts); the claim pipeline had not,
// and on mason-v1 #4590 (2026-09-24) 5 of CodeRabbit's 12 items came from house rules the
// claim pass was never shown. Shallowest first, so the root rules are the last to be cut;
// a file that does not fit is named, never silently dropped.
export const MAX_GUIDANCE_BYTES = 32 * 1024;
export function targetGuidance(repository: string, packet: Packet): { guidance: { path: string; text: string }[]; omitted: string[] } {
  const paths = new Set(['AGENTS.md']);
  for (const { path } of packet.changedFiles) {
    const parts = path.split('/'); parts.pop();
    for (; parts.length; parts.pop()) paths.add(`${parts.join('/')}/AGENTS.md`);
  }
  const guidance: { path: string; text: string }[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const path of [...paths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    const text = sourceText(repository, packet.baseSha, path);
    if (text === null) continue;
    const size = Buffer.byteLength(text);
    if (bytes + size > MAX_GUIDANCE_BYTES) { omitted.push(path); continue; }
    bytes += size;
    guidance.push({ path, text });
  }
  return { guidance, omitted };
}

const idle = (): ClaimInvestigation => ({ claims: [], complete: true, limitations: [], toolErrors: [], stopReason: 'finished',
  spentUsd: 0, telemetry: { turns: 0, toolCalls: 0, toolCallsByName: {}, droppedTurns: 0, inputTokens: 0, outputTokens: 0,
    finishReason: null, failure: null } });

// The model a profile names, unless a test or benchmark injects one.
export function modelFor(profile: Profile, injectedModel?: Model): Model {
  if (subscription(profile) && !injectedModel) {
    throw new Error('Local subscription experiments require a benchmark adapter (Codex or Claude); hosted execution is not supported');
  }
  return injectedModel ?? (profile.provider === 'openrouter' ? openRouterModel(profile) : openAIModel(profile));
}

export async function runClaimReview(directory: string, profile: Profile,
  injectedModel?: Model, signal?: AbortSignal, crossFamily?: CrossFamilyRung,
  crossFamilySource: CrossFamilySource = 'none', verify: VerifyOptions = {},
  capture: { transcript?: boolean } = {}, incremental?: IncrementalScope): Promise<ClaimReview> {
  const { packet } = loadReview(directory);
  const model = modelFor(profile, injectedModel);
  const repository = join(directory, 'source.git');
  // Both sides, because a claim about a regression is a claim about the difference.
  const revisions = { head: revisionFrom(repository, packet.headSha), base: revisionFrom(repository, packet.mergeBaseSha) };
  const sourceOf = (path: string) => sourceText(repository, packet.headSha, path);

  const full = readFileSync(join(directory, 'change.diff'));
  const diff = incremental ? incremental.diff : full;
  if (diff.length > MAX_DIFF_BYTES) throw new Error('Diff exceeds 512 KB investigation limit');
  const changed = new Set(incremental?.changed ?? []);
  const recheck = (incremental?.carried ?? []).filter(claim => touchedBy(claim, changed));
  const { guidance, omitted } = targetGuidance(repository, packet);
  const guided = guidance.length ? { targetGuidance: guidance } : {};
  const context = incremental
    ? { packet, ...guided, diff: diff.toString('utf8'), incrementalSince: incremental.since,
      scope: `This diff holds only the commits pushed since an earlier review at ${incremental.since}. The whole change is listed in packet.changedFiles, and the earlier review's other findings are re-checked separately. Claim defects that these new commits introduce or expose; revision "base" still means the merge base.`
        + (recheck.length ? ' earlierFindings are findings from that review in files these commits changed. They are not carried forward on their own: read the new code, and record again, with the same type, location symbol and suspectedCondition, each one that still holds at the new head. Leave out any the new commits fixed.' : ''),
      ...(recheck.length ? { earlierFindings: recheck.map(({ type, location, description, suspectedCondition }) => ({ type, location, description, suspectedCondition })) } : {}) }
    : { packet, ...guided, diff: diff.toString('utf8') };

  // Nothing new to read, as when only the target branch moved: no model is asked.
  const investigation = incremental && !diff.length ? idle() : await investigateClaims(revisions, sourceOf, context, model, {
    maxTurns: profile.maxTurns, maxToolCalls: profile.maxToolCalls,
    maxInputTokens: profile.maxInputTokens, maxOutputTokens: profile.maxOutputTokens,
    maxUsd: profile.maxUsd, ...(capture.transcript ? { recordTranscript: true } : {}),
    costOf: (input, output) => subscription(profile) ? 0 : price(input, output, 0, profile.model),
  }, signal);
  // Earlier claims first, so a claim the model records again keeps the earlier wording
  // and checks; the verifier is then handed one list and cannot tell them apart.
  const emitted = new Set(investigation.claims.map(claim => claim.claimId));
  const carried = (incremental?.carried ?? []).filter(claim => !emitted.has(claim.claimId) && !touchedBy(claim, changed));
  if (omitted.length) investigation.limitations.push(`Repository guidance over ${MAX_GUIDANCE_BYTES / 1024} KB was left out, so these rules were not shown: ${omitted.join(', ')}.`);
  if (recheck.length) investigation.limitations.push(`${recheck.length} earlier finding(s) were in files this push changed, so they were re-asked rather than carried; ${recheck.filter(claim => emitted.has(claim.claimId)).length} were recorded again.`);
  const claims = [...carried, ...investigation.claims];

  const persist = (name: string, value: unknown) => {
    const temporary = join(directory, `${name}.pending`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, join(directory, name));
  };
  persist('claims.json', investigation.claims);
  if (incremental) persist('carried-claims.json', carried);
  // Opt-in, for the emission bench only: this is provider and repository text.
  if (investigation.transcript) persist('transcript.json', investigation.transcript);
  // Written as its own file rather than folded into the verification, because it is about
  // the run and not about any claim, and because a run that emits nothing still needs to
  // leave an explanation behind. Counts and allowlisted enums only -- see ClaimTelemetry.
  // Both are written before verification, because a verification that throws must not
  // take the claims and the spend down with it: seen 2026-09-23, when a grep overflow did
  // exactly that on a live run.
  persist('telemetry.json', { ...investigation.telemetry, stopReason: investigation.stopReason,
    complete: investigation.complete, claims: investigation.claims.length, spentUsd: investigation.spentUsd,
    toolErrors: investigation.toolErrors, limitations: investigation.limitations });

  // The verifier is handed the claims and the revision, and nothing else. Whatever the
  // investigator believed does not travel with them.
  let rung = crossFamily;
  // A claim whose Jev call fails is skipped, which the lifecycle reads as unsettled, and
  // that is the honest outcome. What was not honest was saying nothing about it: seen
  // 2026-09-21, a run asked zero questions where seven claims needed them, every claim
  // came out inconclusive, and the report gave no hint that the rung had never answered.
  // The count is reported and the reason is not, because provider text can carry
  // repository content.
  let unreached: string[] = [];
  if (!rung && crossFamilySource === 'jev' && claims.length) {
    const asked = await askJev(claims, revisions, full.toString('utf8'), { signal, verify });
    rung = recordedRung(asked.log);
    unreached = [...new Set(asked.skippedClaims)];
  }
  const verification = verifyClaims(claims, revisions, BALANCED, rung, undefined, verify);
  if (unreached.length) {
    verification.limitations.push(unreached.length === claims.length
      ? `The cross-family rung answered nothing: all ${unreached.length} claim(s) failed to reach it, so any proposition only it could settle is unsettled.`
      : `The cross-family rung did not reach ${unreached.length} of ${claims.length} claim(s), so any proposition only it could settle is unsettled for those.`);
  }
  persist('verification.json', { ...verification, stopReason: investigation.stopReason, spentUsd: investigation.spentUsd });
  return { claims, investigation, verification };
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
