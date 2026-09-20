import { verifyClaims, type CrossFamilyAnswer } from './lifecycle.js';
import type { Revisions } from './symbolic.js';
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
// rung would face — including the rule that a symbolically refuted claim is never
// carried to a later rung — without that rule being restated here.
//
// Second, Jev answers many questions against one state in a single call, so one call
// covers one claim and all of its propositions.

// WIRE FORMAT — UNVERIFIED. SMOKE_TEST_JEV.md documents the endpoint, the Bearer
// header, that `state` is a JSON object, that `questions` is a map evaluated in
// parallel against it, and that a Noul returns the probability of yes and carries no
// separate confidence. It does not record the field names of the request body or the
// response, and `.smoke/jev-schema.json` is not in this repository. The shapes below
// are this adapter's assumption, kept in these two functions alone so that one live
// call either confirms them or corrects exactly one place. Parsing is strict: a
// response that does not match fails loudly rather than being coerced into a
// probability, because a wrong number here silently decides whether claims ship.
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

export interface JevQuestion { key: string; proposition: string }

export function jevRequest(state: unknown, questions: JevQuestion[]): string {
  return JSON.stringify({
    model: MODEL,
    state,
    questions: Object.fromEntries(questions.map(question => [question.key, {
      type: 'noul',
      question: question.proposition,
      // The criteria say what "yes" means, because the proposition is a statement and
      // a Noul answers a question. Without this the model is free to read the
      // statement as a request for its opinion of the change.
      criteria: 'Answer yes only if this statement is true of the code in the state as given. Judge the code, not the intent of the change.',
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
    const probability = answer.probability;
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
  const { path, line } = parseLocation(claim.location);
  return {
    claim: { type: claim.type, location: claim.location },
    file: { path, head: window(revisions.head, path, line), base: window(revisions.base, path, line) },
    diff: diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n[diff truncated]` : diff,
  };
}
const MAX_DIFF_BYTES = 24000;
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
export function questionsAsked(claims: Claim[], revisions: Revisions, policy: Policy = BALANCED): CrossFamilyAnswer[] {
  const asked: CrossFamilyAnswer[] = [];
  verifyClaims(claims, revisions, policy, {
    settle: (proposition, claim) => { asked.push({ claimId: claim.claimId, proposition, evidence: [] }); return []; },
  });
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
}

export async function askJev(claims: Claim[], revisions: Revisions, diff: string, options: JevOptions = {}): Promise<JevResult> {
  const { apiKey = process.env.TYPESAFE_API_KEY, limits = DEFAULT_JEV_LIMITS,
    transport = globalThis.fetch, signal, policy = BALANCED } = options;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is missing. Configure it locally.');
  const asked = questionsAsked(claims, revisions, policy);
  const byClaim = new Map<string, string[]>();
  for (const entry of asked) byClaim.set(entry.claimId, [...byClaim.get(entry.claimId) ?? [], entry.proposition]);
  const claimsById = new Map(claims.map(claim => [claim.claimId, claim]));
  const log: CrossFamilyAnswer[] = [];
  const skippedClaims: string[] = [];
  let calls = 0;
  for (const [claimId, propositions] of byClaim) {
    if (calls >= limits.maxCalls) { skippedClaims.push(claimId); continue; }
    const claim = claimsById.get(claimId)!;
    const questions = propositions.map((proposition, index) => ({ key: `p${index}`, proposition }));
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
        log.push({ claimId, proposition: question.proposition,
          evidence: [evidenceFor(question.proposition, probabilities.get(question.key)!)] });
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

export const evidenceFor = (proposition: string, probability: number): Evidence =>
  ({ rung: 'cross_family_llm', check: `jev noul: ${proposition}`, result: probability });
