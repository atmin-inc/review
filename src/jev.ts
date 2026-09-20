import { verifyClaims, type CrossFamilyAnswer, type VerifyOptions } from './lifecycle.js';
import type { Revisions, Side } from './symbolic.js';
import { parseLocation, type Claim } from './claim.js';
import type { Evidence } from './evidence.js';
import { ProviderRequestError } from './provider-error.js';
import { BALANCED, type Policy } from './policy.js';
import { startSpan, traceEvent, traceHash } from './trace.js';

// Rung 3, answered by Jev over the TypeSafe API. Two things shape this adapter and
// neither is arbitrary.
//
// First, `CrossFamilyRung.settle` is synchronous, and an HTTP call is not. That is not
// an oversight to work around: verification is deterministic and free, which is what
// lets the same claims be verified again with the rung switched off (see ablation.ts).
// So the asking happens first, as its own phase, and verification replays the answers.
// The questions are collected by running verification once with a rung that records
// what it is asked and answers nothing, so the set asked is exactly the set the real
// rung would face — including whether a symbolically refuted claim is carried to a
// later rung, which `questionRefutations` changes — without any of that being restated
// here. That is the point of collecting the questions by asking rather than deriving
// them: the two phases cannot drift apart.
//
// Second, Jev answers many questions against one state in a single call, so one call
// covers one claim and all of its propositions.

// WIRE FORMAT — verified against the live API on 2026-09-20, and against the schema it
// publishes at https://api.typesafe.ai/openapi.json, which is the contract that
// `.smoke/jev-schema.json` was missing from this repository. A question is a
// `NoulQuestion`: `type: 'noul'`, the statement in `instructions`, and a `NoulCriteria`
// object under `criteria` with a `true` and a `false` side. An answer is a
// `NoulAnswer`: `type: 'noul'` with the probability of yes in `noul`. Parsing stays
// strict: a response that does not match fails loudly rather than being coerced into a
// probability, because a wrong number here silently decides whether claims ship.
// The state carries both revisions and the diff, because a claim about a regression is
// unanswerable without them, so the question has to say which side decides. Measured
// 2026-09-20: asked the bare sentence "the body of renameAccount lacks account.ownerId",
// Jev answered for the side where it is present. Rung 1 had run at head and missed,
// correctly, and `suspectChecks` held back a correct `auth_bypass`. Neither rung was
// wrong; they were answering different questions.
// Tested on 'base', not on 'head', so that a value that is somehow neither falls to head
// — the same default `propositionSide` applies. Defaulting the other way would quietly
// ask about the code before the change, which is the mistake this whole function exists
// to stop.
const judgeAt = (revision: Side): string => revision === 'base'
  ? 'Judge this at the base revision: the state BEFORE the change. The head revision and the diff are context only.'
  : 'Judge this at the head revision: the state AFTER the change. The base revision and the diff are context only.';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

export interface JevQuestion { key: string; proposition: string; revision: Side }

export function jevRequest(state: unknown, questions: JevQuestion[]): string {
  return JSON.stringify({
    model: MODEL,
    state,
    questions: Object.fromEntries(questions.map(question => [question.key, {
      type: 'noul',
      instructions: `${question.proposition}\n\n${judgeAt(question.revision)}`,
      // The criteria say what "yes" means, because the proposition is a statement and
      // a Noul answers a question. Without this the model is free to read the
      // statement as a request for its opinion of the change. `true` and `false` are
      // the two sides of the Noul, so both are stated rather than leaving the model
      // to infer the negative. Both name the revision, because the state carries the
      // other one too and a statement about a change is true on one side and false on
      // the other.
      criteria: {
        true: `This statement is true of the ${question.revision} revision as given. Judge the code, not the intent of the change.`,
        false: `This statement is not true of the ${question.revision} revision as given.`,
      },
    }])),
  });
}

// One probability per question key. Anything else is a contract change we must see.
export function jevAnswers(body: unknown, questions: JevQuestion[]): Map<string, number> {
  const record = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProviderRequestError('inference');
    return value as Record<string, unknown>;
  };
  const answers = record(record(body).answers);
  return new Map(questions.map(question => {
    const answer = record(answers[question.key]);
    // An Answer is a union discriminated on `type`, and only a Noul carries a
    // probability. A Score or a Choice in this slot is the wrong answer to the
    // question we asked, not a number to read.
    if (answer.type !== 'noul') throw new ProviderRequestError('inference');
    const probability = answer.noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new ProviderRequestError('inference');
    }
    return [question.key, probability];
  }));
}

// The state a claim's propositions are judged against. The claim's own description and
// suspectedCondition are deliberately left out: those are what the investigator
// concluded, and rung 3 exists to settle the steps independently of that. Location and
// type stay, because a proposition like "no ownership comparison remains in the
// function body" is unanswerable without knowing which body.
export function jevState(claim: Claim, revisions: Revisions, diff: string): unknown {
  const { path: located, line } = parseLocation(claim.location);
  return {
    claim: { type: claim.type, location: claim.location },
    files: statePaths(claim).map(path => {
      const at = path === located ? line : 1;
      return { path, head: window(revisions.head, path, at), base: window(revisions.base, path, at) };
    }),
    diff: diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n[diff truncated]` : diff,
  };
}
const MAX_DIFF_BYTES = 24000;
// Every file the claim's checks name, not only the one it is located in. A proposition
// settled by `file_contains` is about a different file — the test that covers the
// change, the caller that relies on it — and a state carrying only the located file
// asks Jev about text it was never shown. It answers no, correctly, and the verifier
// reads that as rung 3 contradicting a symbolic fact that is true. Seen on 2026-09-20:
// grep confirmed a test asserts /Forbidden/ at test/suggestion-demo.test.mjs:12 while
// Jev returned 0.12 on the same proposition, which was enough to hold back a correct
// auth_bypass. Capped, because one claim must not send the whole repository.
const MAX_STATE_FILES = 4;
function statePaths(claim: Claim): string[] {
  const named = claim.evidenceToCheck.flatMap(({ check }) => check && 'path' in check ? [check.path] : []);
  return [...new Set([parseLocation(claim.location).path, ...named])].slice(0, MAX_STATE_FILES);
}
// A window around the claim's line rather than the head of the file: a claim at line
// 900 is not served by the first 200 lines. `slice` caps a read at 200 lines and at
// 24 KB and returns null past either, so a file of very long lines falls back to a
// narrower window instead of arriving empty.
const window = (revision: Revisions['head'], path: string, line: number): string | null => {
  for (const span of [200, 40]) {
    const text = revision.slice(path, Math.max(1, line - Math.floor(span / 2)), span);
    if (text !== null) return text;
  }
  return null;
};

// Exactly the questions rung 3 would be asked for this claim set, obtained by asking.
export function questionsAsked(claims: Claim[], revisions: Revisions, policy: Policy = BALANCED,
  options: VerifyOptions = {}): CrossFamilyAnswer[] {
  const asked: CrossFamilyAnswer[] = [];
  verifyClaims(claims, revisions, policy, {
    settle: (proposition, claim, revision) => { asked.push({ claimId: claim.claimId, proposition, revision, evidence: [] }); return []; },
  }, undefined, options);
  return asked;
}

export interface JevLimits {
  // Jev bills input tokens only, at fractions of a cent per call, but an unbounded
  // number of calls is still unbounded spend. One call per claim, capped.
  maxCalls: number;
  timeoutMs: number;
}
export const DEFAULT_JEV_LIMITS: JevLimits = { maxCalls: 40, timeoutMs: 60000 };

export interface JevResult { log: CrossFamilyAnswer[]; calls: number; skippedClaims: string[] }

// Asks Jev every question rung 3 would face, one call per claim, and returns a log the
// verifier can replay. A claim whose call fails is skipped rather than answered: a rung
// that could not reach a proposition returns nothing, which the lifecycle already reads
// as unsettled, and that is the honest outcome of a failed call.
export interface JevOptions {
  apiKey?: string; limits?: JevLimits; transport?: typeof globalThis.fetch; signal?: AbortSignal | undefined; policy?: Policy;
  verify?: VerifyOptions;
}

export async function askJev(claims: Claim[], revisions: Revisions, diff: string, options: JevOptions = {}): Promise<JevResult> {
  const { apiKey = process.env.TYPESAFE_API_KEY, limits = DEFAULT_JEV_LIMITS,
    transport = globalThis.fetch, signal, policy = BALANCED, verify = {} } = options;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is missing. Configure it locally.');
  const asked = questionsAsked(claims, revisions, policy, verify);
  const byClaim = new Map<string, { proposition: string; revision: Side }[]>();
  for (const entry of asked) byClaim.set(entry.claimId,
    [...byClaim.get(entry.claimId) ?? [], { proposition: entry.proposition, revision: entry.revision }]);
  const claimsById = new Map(claims.map(claim => [claim.claimId, claim]));
  const log: CrossFamilyAnswer[] = [];
  const skippedClaims: string[] = [];
  let calls = 0;
  for (const [claimId, propositions] of byClaim) {
    if (calls >= limits.maxCalls) { skippedClaims.push(claimId); continue; }
    const claim = claimsById.get(claimId)!;
    const questions = propositions.map((item, index) => ({ key: `p${index}`, ...item }));
    const body = jevRequest(jevState(claim, revisions, diff), questions);
    const end = startSpan('jev.http', { claimId, questions: questions.length,
      requestBytes: Buffer.byteLength(body), requestHash: traceHash(body) }, 3);
    calls++;
    let status: number | null = null;
    try {
      const response = await transport(ENDPOINT, { method: 'POST', body, redirect: 'error', signal: signal ?? AbortSignal.timeout(limits.timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
      status = response.status;
      // SMOKE_TEST_JEV.md, gotcha 1: an unauthenticated POST returns 403, not the
      // documented 401. ProviderRequestError reads both as authentication.
      if (!response.ok) throw new ProviderRequestError('inference', response.status);
      const text = await response.text();
      if (Buffer.byteLength(text) > 2000000) throw new ProviderRequestError('inference');
      const probabilities = jevAnswers(JSON.parse(text), questions);
      for (const question of questions) {
        log.push({ claimId, proposition: question.proposition, revision: question.revision,
          evidence: [evidenceFor(question.proposition, probabilities.get(question.key)!, question.revision)] });
      }
      end({ outcome: 'returned', status });
    } catch (error) {
      end({ outcome: signal?.aborted ? 'aborted' : 'error', status });
      traceEvent('jev.skipped', { claimId, status }, 2);
      skippedClaims.push(claimId);
      if (error instanceof ProviderRequestError && error.failure.kind === 'authentication') throw error;
    }
  }
  return { log, calls, skippedClaims };
}

// The revision is in the label because a reader of the report has to be able to tell
// which side the model was judging, exactly as the symbolic labels say "at the merge
// base".
export const evidenceFor = (proposition: string, probability: number, revision: Side = 'head'): Evidence =>
  ({ rung: 'cross_family_llm', check: `jev noul${revision === 'base' ? ' at the merge base' : ''}: ${proposition}`, result: probability });
