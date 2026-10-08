import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, loadReview, sourceText } from './snapshot.js';
import { revisionFrom } from './symbolic.js';
import { investigateClaims, type ClaimInvestigation } from './investigator.js';
import { verifyClaims, type CrossFamilyRung, type Verification, type VerifyOptions } from './lifecycle.js';
import { contributionOf, recordedRung, type RungContribution } from './ablation.js';
import { askJev } from './jev.js';
import { BALANCED } from './policy.js';
import { meteredCost, reservedCost, subscription, type Model, type ModelReply, type Profile } from './investigation.js';
import { openAIModel } from './openai-model.js';
import { openRouterModel } from './openrouter-model.js';
import { parseLocation, type Claim } from './claim.js';
import { calledCode, MAX_CALLED_CODE_BYTES } from './callees.js';
import { failureExcerpt } from './failure-excerpt.js';
import type { Rung } from './evidence.js';
import { lockFile, type Packet } from './contracts.js';

// The whole lifecycle over one prepared snapshot: a wide pass emits claims, a separate
// pass settles them against the same frozen revision, and code composes the verdict.
// The two passes share no state but the claims, which is the point.
// `claims` is everything verified: carried claims first on an incremental run, then the
// ones this run emitted, which are also `investigation.claims`.
// `parts` is how many investigations the diff was split across, and `unread` lists the changed
// paths left out of every part (see splitDiff).
export interface ClaimReview { claims: Claim[]; investigation: ClaimInvestigation; verification: Verification; parts: number; unread: string[] }

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

// The diff the claim pass reads: a deleted file as its header only (git's --irreversible-delete;
// the source tools still read its old content on the base side), and no lock files. Lors chose
// this on 2026-10-08 after mason-v1#4832, whose 6.5 MB diff was mostly 498 deleted files.
// `paths` is every changed path; the rest are named one by one because git runs with literal
// pathspecs here (GIT_LITERAL_PATHSPECS), which turns off `:(exclude)`.
export function reviewDiff(repository: string, from: string, to: string, paths: string[]): Buffer {
  const read = paths.filter(path => !lockFile(path));
  return read.length ? git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--irreversible-delete', from, to, '--', ...read]) : Buffer.alloc(0);
}

// A diff over the limit is reviewed in parts (Lors, 2026-10-08: "if i make a PR and it is a bit
// big, why cant i get it fully reviewed?"): each part holds up to MAX_DIFF_BYTES of whole files and
// gets its own investigation, and the claims of every part are verified together. Files are packed
// in git's path order, so a folder's files share a part. Each file's diff starts at git's
// "diff --git" line, which no line of content can begin with, and is matched to its path through
// git's own path list. A review splits into at most as many parts as its budget (the profile's
// maxUsd, $2 by default) covers at PART_USD each, the parts sharing that one budget (Lors: "we
// already have a cap of $2 per PR no? big prs should be well below that"). Past those parts, or for
// one file whose diff alone is over the limit, files are left out and listed as not reviewed. Which files are read then is the order Lors chose
// for reading in part, as Mira does: deleted files first, each only a header (on mason-v1#4832, 503
// of them took 90 KB), then source files before tests, docs and generated files, and within each
// the smallest first, so as many files as fit are read whole.
// One full 512 KB part cost $0.15 on mason-v1#4832 (Bedrock, 67 turns, 2026-10-08), the dearest
// measured; the same part cost $0.08 to $0.11 on OpenRouter.
export const PART_USD = 0.15;
export const partsWithin = (maxUsd: number) => Math.max(1, Math.floor(maxUsd / PART_USD + 1e-9));
const minor = /(^|\/)(tests?|specs?|__tests__|__mocks__|__snapshots__|fixtures?|docs?|examples?|dist|build)\/|\.(md|mdx|txt|rst|snap|map)$|\.min\.(js|css)$|[._]generated\./;
export function splitDiff(repository: string, from: string, to: string, paths: string[], maxParts: number): { parts: Buffer[]; unread: string[] } {
  const diff = reviewDiff(repository, from, to, paths);
  if (diff.length <= MAX_DIFF_BYTES) return { parts: diff.length ? [diff] : [], unread: [] };
  const names = git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--irreversible-delete', '--name-only', '-z', from, to, '--',
    ...paths.filter(path => !lockFile(path))]).toString('utf8').split('\0').filter(Boolean);
  const starts: number[] = [], next = Buffer.from('\ndiff --git ');
  for (let at = diff.indexOf('diff --git '); at !== -1; at = diff.indexOf(next, at + 1)) starts.push(at && at + 1);
  const files = names.map((path, index) => ({ path, index, bytes: diff.subarray(starts[index], starts[index + 1] ?? diff.length) }));
  // A quoted path (one git escapes) cannot be compared here; every other part must name its path.
  const named = (path: string, bytes: Buffer) => { const line = bytes.subarray(0, bytes.indexOf(10)).toString('utf8');
    return line === `diff --git a/${path} b/${path}` || line.startsWith('diff --git "'); };
  if (starts[0] !== 0 || starts.length !== names.length || files.some(({ path, bytes }) => !named(path, bytes))) throw new Error('Diff parts do not match the changed paths');
  const rank = ({ path, bytes }: { path: string; bytes: Buffer }) => {
    const second = bytes.indexOf(10) + 1;
    return bytes.subarray(second, second + 18).toString('utf8') === 'deleted file mode ' ? 0 : minor.test(path) ? 2 : 1;
  };
  const chosen: typeof files = [];
  let size = 0;
  for (const file of [...files].sort((a, b) => rank(a) - rank(b) || a.bytes.length - b.bytes.length || a.index - b.index)) {
    if (file.bytes.length <= MAX_DIFF_BYTES && size + file.bytes.length <= maxParts * MAX_DIFF_BYTES) { chosen.push(file); size += file.bytes.length; }
  }
  // Packing in path order can leave room unused at the end of a part, so while the chosen files
  // need more than maxParts parts, the last one chosen is left out.
  for (;;) {
    const bins: Buffer[][] = [];
    let room = 0;
    for (const file of [...chosen].sort((a, b) => a.index - b.index)) {
      if (!bins.length || file.bytes.length > room) { bins.push([]); room = MAX_DIFF_BYTES; }
      bins.at(-1)!.push(file.bytes); room -= file.bytes.length;
    }
    if (bins.length <= maxParts) {
      const read = new Set(chosen.map(file => file.index));
      return { parts: bins.map(bin => Buffer.concat(bin)), unread: files.filter(file => !read.has(file.index)).map(file => file.path) };
    }
    chosen.pop();
  }
}

// An incremental review reads only the commits pushed since an earlier review of the same
// PR, and re-verifies that review's surviving claims against the new revision instead of
// asking a model to find them again. Its diff runs from `since` to the new head;
// verification still runs against the merge base, so every claim remains a claim about
// the whole change. `changed` is the paths the pushed commits touch.
export interface IncrementalScope { since: string; carried: Claim[]; changed: string[] }

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

// Both passes as one investigation: a claim either recorded counts once, the run is
// complete only if both were, and the second pass's limitations say which pass they are from.
function combined(main: ClaimInvestigation, focus: ClaimInvestigation, sites: number): ClaimInvestigation {
  const ids = new Set(main.claims.map(claim => claim.claimId));
  const byName = { ...main.telemetry.toolCallsByName };
  for (const [name, count] of Object.entries(focus.telemetry.toolCallsByName)) byName[name] = (byName[name] ?? 0) + count;
  const transcript = main.transcript && focus.transcript ? [...main.transcript, ...focus.transcript] : undefined;
  return {
    claims: [...main.claims, ...focus.claims.filter(claim => !ids.has(claim.claimId))],
    complete: main.complete && focus.complete,
    limitations: [...main.limitations, ...focus.limitations.map(line => `Failure-path pass: ${line}`)],
    toolErrors: [...main.toolErrors, ...focus.toolErrors],
    stopReason: main.stopReason === 'finished' ? focus.stopReason : main.stopReason,
    spentUsd: main.spentUsd + focus.spentUsd,
    unsettledCalls: main.unsettledCalls + focus.unsettledCalls,
    telemetry: {
      turns: main.telemetry.turns + focus.telemetry.turns,
      toolCalls: main.telemetry.toolCalls + focus.telemetry.toolCalls,
      toolCallsByName: byName,
      droppedTurns: main.telemetry.droppedTurns + focus.telemetry.droppedTurns,
      inputTokens: main.telemetry.inputTokens + focus.telemetry.inputTokens,
      cachedInputTokens: main.telemetry.cachedInputTokens + focus.telemetry.cachedInputTokens,
      outputTokens: main.telemetry.outputTokens + focus.telemetry.outputTokens,
      finishReason: focus.telemetry.finishReason ?? main.telemetry.finishReason,
      failure: main.telemetry.failure ?? focus.telemetry.failure,
      reads: [...main.telemetry.reads, ...focus.telemetry.reads],
      retries: [...main.telemetry.retries, ...focus.telemetry.retries],
      failurePathClaimIds: focus.claims.map(claim => claim.claimId),
      failurePathSpentUsd: focus.spentUsd,
      failurePathTurns: focus.telemetry.turns,
      failurePathSites: sites,
    },
    ...(transcript ? { transcript } : {}),
  };
}

// The parts of a split review as one investigation: claims recorded in more than one part count
// once, it is complete only if every part was, and each part's limitations say which part.
function acrossParts(parts: ClaimInvestigation[]): ClaimInvestigation {
  const claims = new Map<string, Claim>();
  for (const part of parts) for (const claim of part.claims) if (!claims.has(claim.claimId)) claims.set(claim.claimId, claim);
  const byName: Record<string, number> = {};
  for (const part of parts) for (const [name, count] of Object.entries(part.telemetry.toolCallsByName)) byName[name] = (byName[name] ?? 0) + count;
  const sum = (value: (part: ClaimInvestigation) => number | undefined) => parts.reduce((total, part) => total + (value(part) ?? 0), 0);
  const transcripts = parts.map(part => part.transcript);
  return {
    claims: [...claims.values()],
    complete: parts.every(part => part.complete),
    limitations: parts.flatMap((part, index) => part.limitations.map(line => `Part ${index + 1} of ${parts.length}: ${line}`)),
    toolErrors: parts.flatMap(part => part.toolErrors),
    stopReason: parts.find(part => part.stopReason !== 'finished')?.stopReason ?? 'finished',
    spentUsd: sum(part => part.spentUsd),
    unsettledCalls: sum(part => part.unsettledCalls),
    telemetry: {
      turns: sum(part => part.telemetry.turns),
      toolCalls: sum(part => part.telemetry.toolCalls),
      toolCallsByName: byName,
      droppedTurns: sum(part => part.telemetry.droppedTurns),
      inputTokens: sum(part => part.telemetry.inputTokens),
      cachedInputTokens: sum(part => part.telemetry.cachedInputTokens),
      outputTokens: sum(part => part.telemetry.outputTokens),
      finishReason: parts.findLast(part => part.telemetry.finishReason !== null)?.telemetry.finishReason ?? null,
      failure: parts.find(part => part.telemetry.failure)?.telemetry.failure ?? null,
      reads: parts.flatMap(part => part.telemetry.reads),
      retries: parts.flatMap(part => part.telemetry.retries),
      failurePathClaimIds: parts.flatMap(part => part.telemetry.failurePathClaimIds ?? []),
      failurePathSpentUsd: sum(part => part.telemetry.failurePathSpentUsd),
      failurePathTurns: sum(part => part.telemetry.failurePathTurns),
      failurePathSites: sum(part => part.telemetry.failurePathSites),
    },
    ...(transcripts.every(Boolean) ? { transcript: transcripts.flatMap(transcript => transcript!) } : {}),
  };
}

const idle = (): ClaimInvestigation => ({ claims: [], complete: true, limitations: [], toolErrors: [], stopReason: 'finished',
  spentUsd: 0, unsettledCalls: 0, telemetry: { turns: 0, toolCalls: 0, toolCallsByName: {}, droppedTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    finishReason: null, failure: null, reads: [], retries: [] } });

// Reservations use the rate card at its dearest; settlement uses what the call cost.
export function charges(profile: Profile) {
  return {
    costOf: (input: number, output: number) => reservedCost(profile, input, output),
    charged: (reply: ModelReply): number | null => meteredCost(profile, reply),
  };
}

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
  const { parts, unread } = incremental ? splitDiff(repository, incremental.since, packet.headSha, incremental.changed, partsWithin(profile.maxUsd))
    : splitDiff(repository, packet.mergeBaseSha, packet.headSha, packet.changedFiles.map(file => file.path), partsWithin(profile.maxUsd));
  if (unread.length && !parts.length) throw new Error('Diff exceeds 512 KB investigation limit');
  // Each investigation is told what it holds and that only its own diff decides whether it is
  // complete: told only that files were left out, the model ended every such review unfinished,
  // and an unfinished review claims no file (mason-v1#4832, 2026-10-08: 0/780 in 28 turns).
  const left = unread.length ? ` ${unread.length} changed ${unread.length === 1 ? 'file is' : 'files are'} left out of ${parts.length > 1 ? 'every part' : 'it'} and reported as not reviewed.` : '';
  const note = (index: number) => parts.length > 1
    ? ` This diff is part ${index + 1} of ${parts.length} of the change: the change is over the ${MAX_DIFF_BYTES / 1024} KB one review reads, so each part is investigated on its own and the files of the other parts are reviewed there. The source tools still read any file.${left} They are not yours to review: judge complete by the changes in this diff alone.`
    : unread.length ? ` This diff holds only part of the change: it is over the ${MAX_DIFF_BYTES / 1024} KB a review reads, so${left} They are not yours to review: judge complete by the changes in this diff alone.` : '';
  const changed = new Set(incremental?.changed ?? []);
  const recheck = (incremental?.carried ?? []).filter(claim => touchedBy(claim, changed));
  const { guidance, omitted } = targetGuidance(repository, packet);
  const contextFor = (diff: string, part: string, called: ReturnType<typeof calledCode>['called']) => {
    const guided = { ...(guidance.length ? { targetGuidance: guidance } : {}), ...(called.length ? { calledCode: called } : {}) };
    return incremental
      ? { packet, ...guided, diff, incrementalSince: incremental.since,
        scope: `This diff holds only the commits pushed since an earlier review at ${incremental.since}. The whole change is listed in packet.changedFiles, and the earlier review's other findings are re-checked separately. Claim defects that these new commits introduce or expose; revision "base" still means the merge base.${part}`
          + (recheck.length ? ' earlierFindings are findings from that review in files these commits changed. They are not carried forward on their own: read the new code, and record again, with the same type, location symbol and suspectedCondition, each one that still holds at the new head. Leave out any the new commits fixed.' : ''),
        ...(recheck.length ? { earlierFindings: recheck.map(({ type, location, description, suspectedCondition }) => ({ type, location, description, suspectedCondition })) } : {}) }
      : { packet, ...guided, diff, ...(part ? { scope: part.trim() } : {}) };
  };

  const limits = (maxUsd: number) => ({
    maxTurns: profile.maxTurns, maxToolCalls: profile.maxToolCalls,
    maxInputTokens: profile.maxInputTokens, maxOutputTokens: profile.maxOutputTokens,
    maxUsd, ...(capture.transcript ? { recordTranscript: true } : {}), ...charges(profile),
  });
  // One part's investigation within its share of the review's budget, so the parts together
  // never spend more than one review may.
  const investigate = async (bytes: Buffer, index: number) => {
    const diff = bytes.toString('utf8');
    const { called, omitted: uncalled } = calledCode(diff, revisions.head);
    const context = contextFor(diff, note(index), called);
    const budget = profile.maxUsd / parts.length;
    const main = await investigateClaims(revisions, sourceOf, context, model, limits(budget), signal);
    // A second pass on failure paths alone, within what the first left of the budget, shown
    // only the diff around error handling; a change with none gets no second pass. See
    // failurePathInstruction for why it is a pass of its own, failureExcerpt for the cost.
    const failure = failureExcerpt(diff);
    const failurePaths = !failure.excerpt ? idle()
      : await investigateClaims(revisions, sourceOf, { ...context, diff: failure.excerpt }, model, { ...limits(budget - main.spentUsd), focus: 'failure_paths' }, signal);
    return { investigation: combined(main, failurePaths, failure.sites), uncalled };
  };
  // Nothing to read, as in a PR with no changes or a push that only moved the target
  // branch: no model is asked. Asked anyway, a model can only call the review incomplete.
  // The parts run side by side, so a review in parts takes about as long as one.
  const results = parts.length ? await Promise.all(parts.map(investigate)) : [{ investigation: idle(), uncalled: [] }];
  const investigation = results.length === 1 ? results[0]!.investigation : acrossParts(results.map(result => result.investigation));
  const uncalled = [...new Set(results.flatMap(result => result.uncalled))];
  // Earlier claims first, so a claim the model records again keeps the earlier wording
  // and checks; the verifier is then handed one list and cannot tell them apart.
  const emitted = new Set(investigation.claims.map(claim => claim.claimId));
  const carried = (incremental?.carried ?? []).filter(claim => !emitted.has(claim.claimId) && !touchedBy(claim, changed));
  if (uncalled.length) investigation.limitations.push(`Code the change calls over ${MAX_CALLED_CODE_BYTES / 1024} KB was left out, so these definitions were not shown: ${uncalled.join(', ')}.`);
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
  persist('telemetry.json', { ...investigation.telemetry, parts: parts.length, unread: unread.length, stopReason: investigation.stopReason,
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
  return { claims, investigation, verification, parts: parts.length, unread };
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
