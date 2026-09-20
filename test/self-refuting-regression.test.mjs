import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignClaimIds } from '../dist/claim.js';
import { capture, git, sourceText } from '../dist/snapshot.js';
import { revisionFrom } from '../dist/symbolic.js';
import { verifyClaims } from '../dist/lifecycle.js';
import { BALANCED } from '../dist/policy.js';

// A live emitter produced these two claims against PR #2 on 2026-09-20. Both are
// correct about the code, and rung 1 refuted both — the strongest verdict there is —
// because each carries a proposition about the account object's shape checked with
// body_contains inside renameAccount, where the deleted guard was the only mention of
// ownerId. The change refuted a claim about the change. This freezes that exact input
// so the behaviour cannot silently return.
const { claims: CAPTURED } = JSON.parse(readFileSync(new URL('./fixtures/self-refuting-claims.json', import.meta.url), 'utf8'));

const BASE = `// Isolated account-update example for the review suggestion demo.
// This module is not used by the reviewer or hosted service.
export function renameAccount(accounts, actorId, accountId, displayName) {
  const account = accounts.get(accountId);
  if (!account) throw new Error('Account not found');
  if (account.ownerId !== actorId) throw new Error('Forbidden');
  account.displayName = displayName;
  return account;
}
`;
// PR #2 deletes the ownership guard, and nothing else.
const HEAD = BASE.replace("  if (account.ownerId !== actorId) throw new Error('Forbidden');\n", '');

function pullRequestTwo(t) {
  const root = mkdtempSync(join(tmpdir(), 'atmin-self-refuting-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'work');
  mkdirSync(source);
  const run = (...args) => git(source, args).toString('utf8').trim();
  run('init', '--initial-branch=main', '--template=');
  run('config', 'user.name', 'Review fixture');
  run('config', 'user.email', 'fixture@example.invalid');
  run('config', 'commit.gpgsign', 'false');
  const write = (path, contents) => {
    mkdirSync(join(source, path, '..'), { recursive: true });
    writeFileSync(join(source, path), contents);
  };
  write('examples/suggestion-demo/accounts.mjs', BASE);
  run('add', '-A'); run('commit', '-qm', 'base');
  const baseSha = run('rev-parse', 'HEAD');
  write('examples/suggestion-demo/accounts.mjs', HEAD);
  run('add', '-A'); run('commit', '-qm', 'head');
  const headSha = run('rev-parse', 'HEAD');
  const { packet } = capture(source, { repository: 'atmin-inc/review', pr: 2, baseRef: 'main', baseSha, headSha, state: 'open' });
  return { source, packet };
}

const verify = t => {
  const { source, packet } = pullRequestTwo(t);
  const claims = assignClaimIds(CAPTURED, path => sourceText(source, packet.headSha, path));
  const revisions = { head: revisionFrom(source, packet.headSha), base: revisionFrom(source, packet.mergeBaseSha) };
  return { claims, verification: verifyClaims(claims, revisions, BALANCED) };
};

test('the captured self-refuting claims are no longer refuted by the change itself', t => {
  const { verification } = verify(t);

  for (const chain of verification.chains) {
    assert.notEqual(chain.verdict, 'refuted',
      'a claim about a change cannot be refuted by that change');
    const ownerId = chain.propositions.find(record => /ownerId property/i.test(record.proposition));
    assert.equal(ownerId.status, 'unsettled', 'the circular miss is handed on, not treated as false');
    assert.equal(ownerId.settledBy, null);
  }
  assert.equal(verification.limitations.filter(line => /cannot refute a claim about it/.test(line)).length, 2,
    'both downgrades name the check they came from');
});

// The other half of the measurement, kept as a test so the limit stays visible. The
// soundness fix buys correctness, not recall: it removes a wrong answer and leaves no
// answer, and a claim whose proposition no rung can settle still does not ship. Getting
// the finding back needs the check to reach the file that defines the object — which is
// what the prompt now asks for, and what file_contains exists to express.
test('and they still do not ship, because nothing can settle the proposition', t => {
  const { verification } = verify(t);
  assert.deepEqual(verification.chains.map(chain => chain.verdict), ['inconclusive', 'inconclusive']);
  assert.equal(verification.decision.verdict, 'merge');
});
