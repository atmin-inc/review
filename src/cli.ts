#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assess, unverified } from './assessment.js';
import { checkCurrent, loadReview, prepare } from './snapshot.js';
import { renderMarkdown } from './render.js';
import { readProfile, runReview } from './run.js';
import { ablate, runClaimReview } from './claim-run.js';
import { renderClaimReview } from './render-claim.js';
import { renderContribution } from './ablation.js';
import { accountedUsd } from './investigation.js';
import { costReport } from './cost-report.js';

const help = `atmin review — source investigation and evidence tools

  atmin-review review <https://github.com/owner/repo/pull/number> --profile <profile.json> [--out <new-directory>]
  atmin-review claim-review <https://github.com/owner/repo/pull/number|directory> --profile <profile.json> [--out <new-directory>] [--cross-family none|jev] [--question-refutations]
  atmin-review claim-ablate <directory> [--rung symbolic|cross_family_llm]
  atmin-review prepare <https://github.com/owner/repo/pull/number> [--out <new-directory>]
  atmin-review render <directory> [--format markdown|json] [--check-current] [--out <new-file>]
  atmin-review investigate <directory> --profile <profile.json>
  atmin-review cost <directory> [--out <new-json-file>]

prepare uses read-only GitHub/Git access and writes a private snapshot.
render validates all evidence references against captured Git objects.
--check-current checks live head/target; without it freshness is unverified.
investigate sends frozen source to the configured API, with bounded reads and usage reservations.
claim-review runs the claim lifecycle: a wide pass emits falsifiable claims, a separate
pass settles each one against the frozen revision, and the verdict is composed from what
survived. Claims that die are shown, not hidden.
--cross-family jev answers rung 3 with Jev over the TypeSafe API, using TYPESAFE_API_KEY.
Without it rung 3 stays silent and no claim reaches high confidence through agreement.
--question-refutations asks rung 3 before a claim dies, when one check carries the whole
refutation. A refutation is the strongest verdict and otherwise the least protected: a
check that does not mean what its proposition says is never questioned when it refutes.
Off by default; it costs a call per such claim and most claims are meant to die cheaply.
claim-ablate re-verifies a finished claim-review with one rung switched off, replaying
recorded model answers on both sides so the difference is that rung alone, and reports
what it contributed. It spends nothing and changes nothing.
No repository scripts, GitHub writes or merge approvals. Required execution remains not-run.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true,
    options: { help: { type: 'boolean', short: 'h' }, out: { type: 'string' }, format: { type: 'string' }, profile: { type: 'string' }, rung: { type: 'string' }, 'check-current': { type: 'boolean' }, 'cross-family': { type: 'string' }, 'question-refutations': { type: 'boolean' } } });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const [operation, input] = positionals;
  if (!input || positionals.length !== 2) throw new Error('Expected one command and one input; use --help');
  if (operation === 'claim-ablate') {
    if (values.profile || values.format || values['check-current'] || values.out || values['cross-family'] || values['question-refutations']) throw new Error('claim-ablate takes only a directory and --rung');
    const rung = values.rung ?? 'cross_family_llm';
    if (rung !== 'symbolic' && rung !== 'cross_family_llm') throw new Error('Measurable rungs are symbolic and cross_family_llm');
    process.stdout.write(renderContribution(ablate(resolve(input), rung)));
    return;
  }
  if (operation === 'claim-review') {
    if (!values.profile || values.format || values['check-current']) throw new Error('claim-review requires --profile and accepts only --out and --cross-family');
    const crossFamily = values['cross-family'] ?? 'none';
    if (crossFamily !== 'none' && crossFamily !== 'jev') throw new Error('--cross-family must be none or jev');
    const profile = readProfile(resolve(values.profile));
    const directory = input.startsWith('https://') ? prepare(input, values.out).directory : resolve(input);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const { claims, investigation, verification } = await runClaimReview(directory, profile, undefined, controller.signal, undefined, crossFamily,
        { questionRefutations: values['question-refutations'] === true });
      process.stdout.write(renderClaimReview(claims, verification, investigation));
      process.stderr.write(`Private review artifacts: ${directory}\n`);
      if (investigation.stopReason !== 'finished') process.exitCode = 2;
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    return;
  }
  if (operation === 'investigate' || operation === 'review') {
    if (!values.profile || (operation === 'investigate' && values.out) || values.format || values['check-current']) throw new Error('review/investigate requires --profile; --out is only valid for review');
    const profile = readProfile(resolve(values.profile));
    const directory = operation === 'review' ? prepare(input, values.out).directory : resolve(input);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const { result, receipt } = await runReview(directory, profile, undefined, controller.signal);
      if (operation === 'review') {
        const { packet } = loadReview(directory);
        process.stdout.write(renderMarkdown(packet, result, assess(packet, result, checkCurrent(packet))));
        process.stderr.write(`Private review artifacts: ${directory}\n`);
      } else process.stdout.write(`${JSON.stringify({ directory, status: result.status, findings: result.findings.length,
        accountedUsd: accountedUsd(receipt), stopReason: receipt.stopReason }, null, 2)}\n`);
      if (receipt.stopReason !== 'finished' || result.status !== 'completed') process.exitCode = 2;
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    return;
  }
  if (values.profile) throw new Error('--profile is only valid for review, investigate or claim-review');
  if (values.rung) throw new Error('--rung is only valid for claim-ablate');
  if (values['cross-family']) throw new Error('--cross-family is only valid for claim-review');
  if (values['question-refutations']) throw new Error('--question-refutations is only valid for claim-review');
  if (operation === 'cost') {
    if (values.format || values['check-current']) throw new Error('cost accepts only --out');
    const output = `${JSON.stringify(costReport(resolve(input)), null, 2)}\n`;
    if (values.out) writeFileSync(resolve(values.out), output, { mode: 0o600, flag: 'wx' });
    else process.stdout.write(output);
    return;
  }
  if (operation === 'prepare') {
    if (values.format || values['check-current']) throw new Error('prepare accepts only --out');
    const { directory, packet } = prepare(input, values.out);
    process.stdout.write(`${JSON.stringify({ directory, headSha: packet.headSha, baseSha: packet.baseSha, changedFiles: packet.changedFiles.length, investigation: 'not-started' }, null, 2)}\n`);
    return;
  }
  if (operation !== 'render') throw new Error('Unknown command; use prepare, investigate, claim-review, claim-ablate or render.');
  if (values.format && !['markdown', 'json'].includes(values.format)) throw new Error('Format must be markdown or json');
  const { packet, result } = loadReview(resolve(input));
  const assessment = assess(packet, result, values['check-current'] ? checkCurrent(packet) : unverified());
  const output = values.format === 'json' ? `${JSON.stringify({ packet, result, assessment }, null, 2)}\n` : renderMarkdown(packet, result, assessment);
  if (values.out) writeFileSync(resolve(values.out), output, { mode: 0o600, flag: 'wx' });
  else process.stdout.write(output);
}
try { await main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'Review operation failed' })}\n`);
  process.exitCode = 1;
}
