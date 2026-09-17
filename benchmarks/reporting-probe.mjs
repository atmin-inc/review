import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Ajv } from 'ajv';
import { instructions, toolDefinitions, parseProfile, price } from '../dist/investigation.js';
import { openRouterModel } from '../dist/openrouter-model.js';
import { traceEvent, traceHash, traceId, traceOperation, withTrace } from '../dist/trace.js';

const finish = toolDefinitions.find(tool => tool.name === 'finish');
const validate = new Ajv({ strict: true, allErrors: true }).compile(finish.parameters);
const codeHashes = Object.fromEntries(['../dist/investigation.js', '../dist/openrouter-model.js', '../dist/trace.js', './reporting-probe.mjs', './reporting-history.mjs']
  .map(path => [path, traceHash(readFileSync(new URL(path, import.meta.url)))]));
const defaultProfile = parseProfile({ ...JSON.parse(readFileSync(new URL('../profiles/baseline-deepseek.json', import.meta.url))),
  maxUsd: 0.05, maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 2048, deadlineMs: 45000 });
const evidence = { evidenceId: 'read-1', path: 'example.ts', side: 'head', startLine: 1, endLine: 1,
  totalLines: 1, text: 'export const version = 2;' };
export function probeInput(history) {
  return { instructions, tools: [finish], context: JSON.stringify({
    task: 'Reporting protocol diagnostic using owned synthetic source. No real PR is being reviewed.',
    frozenEvidence: [evidence], controllerBudget: { phase: 'report', remainingResponses: 1,
      instruction: 'Investigation has ended. Only finish is available. Submit one finish call using this evidence. No substantiated defects exist in this isolated snippet; findings and reviewedFiles should be empty. Repository context is insufficient, so quality criteria should be unknown with explanations and empty evidenceIds. Set complete=false and explain the missing repository context in limitations. Do not request any source tools.' },
  }), transcript: history ? [
    { role: 'assistant', content: null, tool_calls: [{ id: 'probe-read', type: 'function', function: { name: 'read_file',
      arguments: JSON.stringify({ side: 'head', path: 'example.ts', startLine: 1, count: 1 }) } }] },
    { role: 'tool', tool_call_id: 'probe-read', content: JSON.stringify(evidence) },
  ] : [] };
}

export async function runProbe(output, transport = fetch, variants = [false, true].flatMap(history =>
  ['default', 'single', 'named'].map(control => ({ id: `${history ? 'history' : 'fresh'}-${control}`, history, control, input: probeInput(history) }))), deadlineMs = 45000) {
  const profile = parseProfile({ ...defaultProfile, deadlineMs });
  if (deadlineMs > 120000) throw new Error('Diagnostic deadline exceeds two minutes');
  if (!variants.length || variants.length > 6 || new Set(variants.map(v => v.id)).size !== variants.length
    || variants.some(v => !/^[a-z0-9-]{1,80}$/.test(v.id) || !['default', 'single', 'named'].includes(v.control)
      || typeof v.history !== 'boolean' || JSON.stringify(v.input.tools) !== JSON.stringify([finish]))) throw new Error('Invalid diagnostic cases');
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required.');
  mkdirSync(output, { mode: 0o700 }); // Never reset spending or overwrite an earlier diagnostic.
  const cases = [];
  const save = (path, value) => { writeFileSync(`${path}.pending`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true }); renameSync(`${path}.pending`, path); };
  for (const { id, history, control, input } of variants) {
    const directory = join(output, id);
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, 'probe.json');
    const record = { id, profile, codeHashes, promptHash: traceHash(instructions), inputHash: traceHash(JSON.stringify(input)),
      control, history, inputBytes: Buffer.byteLength(JSON.stringify(input)), transcriptMessages: input.transcript.length,
      startedAt: new Date().toISOString(), finishedAt: null, reservedUsd: 0, meteredUsd: null,
      dispatched: false, status: 'not-started', responseId: null, usage: null, calls: [], validationErrors: [], failure: null };
    save(path, record);
    await withTrace(directory, async () => {
      const model = openRouterModel(profile, process.env.OPENROUTER_API_KEY, async (url, options) => {
        if (!url.endsWith('/chat/completions')) return transport(url, options);
        const body = JSON.parse(options.body);
        if (control !== 'default') body.parallel_tool_calls = false;
        if (control === 'named') body.tool_choice = { type: 'function', function: { name: 'finish' } };
        const serialized = JSON.stringify(body);
        traceEvent('probe.wire-request', { control, history, hash: traceHash(serialized), bytes: Buffer.byteLength(serialized),
          availableTools: body.tools.map(tool => tool.function.name), parallelToolCalls: body.parallel_tool_calls ?? 'default' });
        return transport(url, { ...options, body: serialized });
      });
      const signal = AbortSignal.timeout(profile.deadlineMs);
      try {
        const estimate = await traceOperation('provider.count', { request: 1 }, () => model.count(input, signal), 2);
        if (!Number.isSafeInteger(estimate) || estimate < 0 || estimate > profile.maxInputTokens) throw new Error('Input bound exceeded');
        record.reservedUsd = price(estimate, profile.maxOutputTokens, 0, profile.model);
        if (record.reservedUsd > profile.maxUsd) throw new Error('Reservation exceeds probe cap');
        record.status = 'in-flight'; record.dispatched = true; save(path, record);
        traceEvent('budget.reserved', { reservedUsd: record.reservedUsd });
        const reply = await traceOperation('provider.inference', { request: 1 }, () => model.respond(input, profile.maxOutputTokens, signal), 2);
        record.responseId = traceId(reply.responseId);
        record.usage = Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens'].map(key =>
          [key, Number.isSafeInteger(reply[key]) && reply[key] >= 0 ? reply[key] : null]));
        record.meteredUsd = typeof reply.reportedCostUsd === 'number' && Number.isFinite(reply.reportedCostUsd) && reply.reportedCostUsd >= 0 ? reply.reportedCostUsd : null;
        record.calls = reply.calls.map(call => ({ name: toolDefinitions.some(tool => tool.name === call.name) ? call.name : 'unknown',
          argumentBytes: Buffer.byteLength(call.arguments), argumentHash: traceHash(call.arguments) }));
        let report;
        if (reply.calls.length === 1 && reply.calls[0].name === 'finish') {
          try { report = JSON.parse(reply.calls[0].arguments); } catch { /* Classified as invalid below. */ }
        }
        const valid = validate(report);
        record.validationErrors = valid ? [] : (validate.errors ?? []).map(error => ({ keyword: error.keyword, path: error.instancePath }));
        record.status = reply.status !== 'completed' ? 'incomplete' : valid ? 'valid-report' : 'invalid-tools-or-report';
        if (valid && (report.complete !== false || report.findings.length || report.reviewedFiles.length
          || !report.limitations.length || report.quality.conventionRules.length
          || Object.values(report.quality.criteria).some(criterion => criterion.status !== 'unknown' || criterion.evidenceIds.length))) record.status = 'fixture-mismatch';
        if (reply.model !== profile.model || record.meteredUsd === null || record.meteredUsd > record.reservedUsd
          || !Number.isSafeInteger(reply.inputTokens) || reply.inputTokens < 0 || reply.inputTokens > estimate
          || !Number.isSafeInteger(reply.outputTokens) || reply.outputTokens < 0 || reply.outputTokens > profile.maxOutputTokens
          || !Number.isSafeInteger(reply.cachedInputTokens) || reply.cachedInputTokens < 0 || reply.cachedInputTokens > reply.inputTokens) record.status = 'usage-or-model-mismatch';
        traceEvent('probe.result', { status: record.status, returnedTools: record.calls.map(call => call.name),
          returnedToolCount: record.calls.length, meteredUsd: record.meteredUsd, validationErrors: record.validationErrors.length });
      } catch (error) {
        record.status = signal.aborted ? 'timeout' : 'error';
        record.failure = error?.failure ?? { kind: signal.aborted ? 'timeout' : 'local-or-transport', stage: 'probe' };
        traceEvent('probe.failed', { status: record.status, reservedUsd: record.reservedUsd });
      } finally { record.finishedAt = new Date().toISOString(); save(path, record); }
    });
    cases.push(record);
    save(join(output, 'results.json'), { schemaVersion: 1, maximumUsd: 0.30, cases });
    process.stdout.write(JSON.stringify({ id, status: record.status, cost: record.meteredUsd, reservedUsd: record.reservedUsd,
      calls: record.calls.map(call => call.name), elapsedSeconds: (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000 }) + '\n');
    if (['funding', 'authentication', 'rate-limit'].includes(record.failure?.kind) || record.status === 'usage-or-model-mismatch') break;
  }
  return cases;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, live: { type: 'boolean' } } });
  if (!values.out || !values.live) throw new Error('Use --out <new-directory> --live. Six synthetic requests, maximum $0.30; no full PR review.');
  await runProbe(resolve(values.out));
}
