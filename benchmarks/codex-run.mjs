import { resolve } from 'node:path';
import { readProfile, runReview } from '../dist/run.js';
import { accountedUsd } from '../dist/investigation.js';
import { codexModel } from './codex-model.mjs';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node review/benchmarks/codex-run.mjs <fresh prepared review directory>');
const profile = readProfile(new URL('../profiles/completion-codex-local.json', import.meta.url));
const model = await codexModel(profile);
const { result, receipt } = await runReview(resolve(directory), profile, model).finally(() => model.close());
console.log(JSON.stringify({ status: result.status, findings: result.findings.length,
  billing: 'subscription', additionalApiUsd: accountedUsd(receipt), stopReason: receipt.stopReason }));
process.exitCode = result.status === 'completed' ? 0 : 2;
