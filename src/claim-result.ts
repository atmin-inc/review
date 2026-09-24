import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClaimReview, type ClaimReview, type IncrementalScope } from './claim-run.js';
import { parseLocation, type Claim, type ClaimType } from './claim.js';
import { parseResult, type Anchor, type Evidence, type Finding, type Packet, type Result } from './contracts.js';
import { git, loadReview, validateAnchor } from './snapshot.js';
import type { Chain } from './evidence.js';
import type { Model, Profile } from './investigation.js';

// The claim pipeline, written into the Result and receipt shapes the GitHub worker and
// the `review` command already publish from. This is the bridge that makes what ships
// the pipeline that was measured (2026-09-24: Luna, rung 3 on, P3 withheld) without
// rewriting publication, freshness, checks or inline comments, which do not depend on
// how the findings were produced.

const CATEGORY: Record<ClaimType, Finding['category']> = {
  injection_risk: 'security', hardcoded_secret: 'security', auth_bypass: 'security',
  race_condition: 'reliability', data_loss: 'data-integrity', contract_break: 'correctness',
  error_handling_gap: 'reliability', resource_leak: 'reliability',
};
const clip = (value: string, limit = 16000): string => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export interface ClaimRunSummary { claims: Claim[]; chains: Chain[]; verdict: string; rule: string; limitations: string[];
  complete: boolean; stopReason: string | null; model: string; scope?: string }

export function claimResult(packet: Packet, repository: string, run: ClaimRunSummary): Result {
  const byId = new Map(run.claims.map(claim => [claim.claimId, claim]));
  const changed = new Map(packet.changedFiles.map(file => [file.path, file]));
  const completed = run.complete && run.stopReason === 'finished';
  const evidence: Evidence[] = [];
  const findings: Finding[] = [];
  const limitations = [...run.limitations];

  // The whole diff is in the claim pass's first turn (under the 128 KB limit), so every
  // changed text file was in front of the model. That is what "reviewed" means here, and
  // only for a run that finished: a run that stopped early claims no coverage at all.
  const text = packet.changedFiles.filter(file => file.kind === 'text');
  if (completed && text.length) evidence.push({ id: 'change-diff', kind: 'source-reasoning', provenance: 'declared',
    summary: 'The complete change diff for this path was in the claim pass context.',
    anchors: text.map(file => ({ path: file.path, side: file.change === 'deleted' ? 'base' : 'head', line: null })) });

  const outside: string[] = [];
  run.chains.filter(chain => chain.verdict === 'confirmed').forEach((chain, index) => {
    const claim = byId.get(chain.claimId);
    if (!claim) return;
    let anchor: Anchor | undefined;
    try {
      const { path, line } = parseLocation(claim.location);
      anchor = { path, side: changed.get(path)?.change === 'deleted' ? 'base' : 'head', line };
      validateAnchor(repository, packet, anchor);
    } catch { anchor = undefined; }
    // A finding may sit outside the changed files, as a caller the change broke, but its
    // line must exist. A confirmed claim whose location does not resolve is still
    // reported, as a limitation, rather than dropped.
    if (!anchor) { outside.push(`${claim.severity} ${claim.type} at ${claim.location}: ${claim.description}`); return; }
    const id = `claim-${index + 1}`;
    const established = chain.propositions.filter(item => item.status === 'established');
    evidence.push({ id, kind: 'source-reasoning', provenance: 'declared', anchors: [anchor],
      summary: clip(`Verified at ${chain.verifierConfidence} confidence. ${established.length} of ${chain.propositions.length} proposition(s) established: `
        + established.map(item => `${item.proposition} [${item.settledBy ?? 'unsettled'}]`).join('; ')) });
    findings.push({ id, priority: claim.severity, kind: claim.severity === 'P4' ? 'improvement' : 'defect',
      category: CATEGORY[claim.type], title: clip(claim.description, 400), trigger: clip(claim.suspectedCondition),
      consequence: clip(claim.description),
      priorityReason: `Rated ${claim.severity} by the reviewer when it made the claim; type ${claim.type}.`,
      counterEvidence: clip(`Each proposition was checked against the frozen revision: ${chain.propositions
        .map(item => `${item.proposition} (${item.status})`).join('; ')}`),
      suggestion: clip(claim.shouldBe?.text ?? 'The reviewer did not propose a specific change; the trigger and checked propositions are under Review details.'),
      anchor, evidenceIds: [id] });
  });
  for (const item of outside) limitations.push(clip(`Confirmed, but its location does not resolve at this revision: ${item}`));
  const withheld = run.chains.filter(chain => chain.verdict === 'withheld').map(chain => byId.get(chain.claimId)?.location).filter(Boolean);
  if (withheld.length) limitations.push(`${withheld.length} confirmed minor (P3) finding(s) withheld: ${withheld.join(', ')}.`);

  const counts = { refuted: 0, inconclusive: 0 };
  for (const chain of run.chains) if (chain.verdict === 'refuted' || chain.verdict === 'inconclusive') counts[chain.verdict]++;
  const result: Result = {
    schemaVersion: 1, headSha: packet.headSha, baseSha: packet.baseSha, policyHash: packet.policyHash,
    status: completed ? 'completed' : 'partial',
    reviewer: { name: 'atmin claim review', model: run.model, context: 'independent' },
    summary: `${run.scope ? `${run.scope} ` : ''}Claim review: ${run.claims.length} claim(s) checked, ${findings.length + outside.length} confirmed and shown, ${withheld.length} withheld as minor, `
      + `${counts.refuted} refuted, ${counts.inconclusive} inconclusive. Policy verdict ${run.verdict} (rule ${run.rule}).`,
    coverage: packet.changedFiles.map(file => ({ path: file.path,
      status: completed && file.kind === 'text' ? 'reviewed' : 'unreviewed', evidenceIds: completed && file.kind === 'text' ? ['change-diff'] : [] })),
    validation: packet.policy.requiredChecks.map(name => ({ name, status: 'not-run', reason: 'Required validation has not run.', evidenceIds: [] })),
    evidence, findings,
    limitations: limitations.length ? limitations.map(item => clip(item)) : ['No repository code was executed.'],
  };
  return parseResult(result);
}

// What an earlier review of the same PR left for this one, written by the worker's runner
// as previous.json: its head, its merge base and the claims that survived it. It is used
// only when the earlier head is an ancestor of this one against the same merge base, so
// the diff between the two heads is exactly the commits pushed since. Anything else, a
// force-push or a merge from the target branch, gets a full review, and the reason is
// said rather than guessed at later.
export interface PreviousReview { headSha: string; mergeBaseSha: string; claims: Claim[] }
export function incrementalScope(directory: string, packet: Packet): { scope?: IncrementalScope; note: string | null } {
  const path = join(directory, 'previous.json');
  if (!existsSync(path)) return { note: null };
  const previous = JSON.parse(readFileSync(path, 'utf8')) as PreviousReview;
  const sha = /^[a-f0-9]{40}$/;
  if (!sha.test(previous.headSha) || !sha.test(previous.mergeBaseSha) || !Array.isArray(previous.claims)) {
    return { note: 'Full review: the earlier review record was unreadable.' };
  }
  if (previous.mergeBaseSha !== packet.mergeBaseSha) return { note: 'Full review: the merge base moved since the earlier review.' };
  const repository = join(directory, 'source.git');
  try { git(repository, ['merge-base', '--is-ancestor', previous.headSha, packet.headSha]); }
  catch { return { note: 'Full review: the earlier reviewed head is not an ancestor of this one, as after a force-push.' }; }
  const diff = git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', previous.headSha, packet.headSha, '--']);
  return { scope: { since: previous.headSha, diff, carried: previous.claims },
    note: `Incremental review: new claims were sought only in the commits since ${previous.headSha.slice(0, 12)}; ${previous.claims.length} earlier finding(s) were re-checked against this head.` };
}

// Read from a finished claim run: only a completed review can stand in for the part of the
// change this one will not re-read, and only its confirmed and withheld claims carry.
export function previousReview(artifact: string): PreviousReview | null {
  try {
    const read = (name: string) => JSON.parse(readFileSync(join(artifact, name), 'utf8'));
    const packet = read('packet.json'), result = read('result.json');
    if (result.status !== 'completed' || !existsSync(join(artifact, 'claim-verification.json'))) return null;
    const chains = (read('claim-verification.json').chains ?? []) as Chain[];
    const kept = new Set(chains.filter(chain => chain.verdict === 'confirmed' || chain.verdict === 'withheld').map(chain => chain.claimId));
    const claims = [...(existsSync(join(artifact, 'carried-claims.json')) ? read('carried-claims.json') : []), ...read('claims.json')] as Claim[];
    return { headSha: packet.headSha, mergeBaseSha: packet.mergeBaseSha, claims: claims.filter(claim => kept.has(claim.claimId)) };
  } catch { return null; }
}

// The fields the dashboard reads from a receipt, and nothing it would misread. Spend is
// metered only when the run finished; otherwise it may include an unsettled reservation,
// and an unknown spend must not be shown as a known one.
export function claimReceipt(profile: Profile, review: ClaimReview, startedAt: string, finishedAt: string) {
  const { investigation } = review;
  const finished = investigation.stopReason === 'finished';
  return { schemaVersion: 1, pipeline: 'claims', profile, startedAt, finishedAt, stopReason: investigation.stopReason,
    providerFailure: investigation.telemetry.failure, toolCalls: investigation.telemetry.toolCalls, toolErrors: investigation.toolErrors,
    calls: [{ inputTokens: investigation.telemetry.inputTokens, outputTokens: investigation.telemetry.outputTokens, cachedInputTokens: null,
      reservedUsd: investigation.spentUsd, meteredUsd: finished ? investigation.spentUsd : null, model: profile.model }] };
}

// One claim review over a prepared snapshot, leaving result.json and receipt.json where
// the older engine left them. Rung 3 is Jev when TYPESAFE_API_KEY is set, which is the
// configuration measured; without it the run says so rather than failing.
export async function runClaimReviewAsResult(directory: string, profile: Profile, signal?: AbortSignal, injectedModel?: Model): Promise<ClaimReview> {
  const { packet, result: initial } = loadReview(directory);
  // One run per snapshot, as with the older engine: a rerun must not reset a spend.
  if (initial.status !== 'not-started' || existsSync(join(directory, 'claims.json'))) {
    throw new Error('Run has existing investigation or spending evidence; prepare a new snapshot');
  }
  const jev = Boolean(process.env.TYPESAFE_API_KEY);
  const deadline = AbortSignal.timeout(profile.deadlineMs);
  const startedAt = new Date().toISOString();
  const { scope, note } = incrementalScope(directory, packet);
  const review = await runClaimReview(directory, profile, injectedModel, signal ? AbortSignal.any([signal, deadline]) : deadline,
    undefined, jev ? 'jev' : 'none', {}, {}, scope);
  // The claim record keeps its own name, because verification.json belongs to the local
  // fix checks the worker may run next, which would overwrite it.
  renameSync(join(directory, 'verification.json'), join(directory, 'claim-verification.json'));
  const persist = (name: string, value: unknown) => {
    const temporary = join(directory, `${name}.pending`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, join(directory, name));
  };
  persist('receipt.json', claimReceipt(profile, review, startedAt, new Date().toISOString()));
  const limitations = [...review.investigation.limitations, ...review.verification.limitations];
  if (!jev) limitations.push('The cross-family rung was off (no TYPESAFE_API_KEY), so no finding reached high confidence through agreement.');
  if (note) limitations.push(note);
  persist('result.json', claimResult(packet, join(directory, 'source.git'), {
    claims: review.claims, chains: review.verification.chains, verdict: review.verification.decision.verdict,
    rule: review.verification.decision.rule, limitations, complete: review.investigation.complete,
    stopReason: review.investigation.stopReason, model: profile.model,
    ...(scope ? { scope: `Incremental review since ${scope.since.slice(0, 12)}.` } : {}) }));
  return review;
}
