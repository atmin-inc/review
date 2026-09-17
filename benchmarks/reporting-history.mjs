import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadReview, sourcePaths, sourceSlice, sourceText } from '../dist/snapshot.js';
import { instructions, toolDefinitions } from '../dist/investigation.js';
import { runProbe } from './reporting-probe.mjs';

// Reconstruct captured reads, not the missing original assistant conversation.
export function historyCases(snapshot, pairs = 3) {
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 3) throw new Error('Choose 1–3 diagnostic pairs');
  const { packet, result } = loadReview(snapshot), repository = join(snapshot, 'source.git');
  if (result.findings.length || result.quality || result.coverage.some(file => file.status === 'reviewed')) {
    throw new Error('This diagnostic expects an unfinished snapshot with no finding, quality or coverage checkpoints');
  }
  const reads = result.evidence.filter(item => item.provenance === 'controller-captured');
  if (!reads.length || reads.length > 20) throw new Error('Diagnostic requires 1–20 captured reads');
  const steps = [];
  const add = (name, args, output) => steps.push({ id: `history-${steps.length + 1}`, name, arguments: args, output });
  for (const [index, item] of reads.entries()) {
    const { path, side } = item.anchors[0], revision = side === 'head' ? packet.headSha : packet.mergeBaseSha;
    // Five navigation responses approximate the earlier run's shape. They are
    // computed from frozen source, not invented matches or historical claims.
    if (index < 5) {
      if (index % 2 === 0) {
        const paths = sourcePaths(repository, revision).filter(value => value.includes(path));
        add('list_files', { side, contains: path, offset: 0 }, { paths: paths.slice(0, 100), total: paths.length, nextOffset: null });
      } else {
        const lines = sourceText(repository, revision, path).split('\n').flatMap((line, i) => line.includes('website') ? [i + 1] : []);
        add('search', { side, path, query: 'website' }, { lines: lines.slice(0, 50), total: lines.length, truncated: lines.length > 50 });
      }
    }
    const count = Math.max(1, item.capture.endLine - item.capture.startLine + 1);
    add('read_file', { side, path, startLine: item.capture.startLine, count }, {
      evidenceId: item.id, ...sourceSlice(repository, revision, path, item.capture.startLine, count),
    });
  }
  const context = { task: 'Reporting protocol diagnostic, not a new defect investigation. Tool history was reconstructed from immutable source reads.',
    packet, diff: readFileSync(join(snapshot, 'change.diff'), 'utf8'),
    frozenCheckpoints: { findings: [], reviewedFiles: [], quality: null },
    controllerBudget: { phase: 'report', remainingResponses: 1,
      instruction: 'Investigation has ended. Only finish is available. Submit exactly one finish call. This diagnostic measures reporting of frozen checkpoints, not new analysis: findings and reviewedFiles must remain empty, quality criteria must be unknown with explanations and empty evidenceIds because no quality assessment was recorded. Set complete=false and explain the incomplete investigation in limitations. Do not request source tools or claim merge readiness.' } };
  const transcript = steps.flatMap(step => [
    { role: 'assistant', content: null, tool_calls: [{ id: step.id, type: 'function',
      function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] },
    { role: 'tool', tool_call_id: step.id, content: JSON.stringify(step.output) },
  ]);
  // Each representation contains every source/tool output exactly once. The
  // handoff preserves arguments too, but presents completed work as user data.
  const input = history => ({ instructions, tools: toolDefinitions.filter(tool => tool.name === 'finish'),
    context: JSON.stringify(history ? context : { ...context, frozenInvestigation: steps }), transcript: history ? transcript : [] });
  return [true, false, false, true, true, false].slice(0, pairs * 2).map((history, index) => ({
    id: `pair-${Math.floor(index / 2) + 1}-${history ? 'history' : 'handoff'}`, control: 'default', history, input: input(history),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { snapshot: { type: 'string' }, out: { type: 'string' }, live: { type: 'boolean' },
    pairs: { type: 'string', default: '3' }, 'deadline-ms': { type: 'string', default: '45000' } } });
  if (!values.snapshot || !values.out || !values.live) throw new Error('Use --snapshot <captured-review> --out <new-directory> --live. At most six requests, maximum $0.30.');
  await runProbe(resolve(values.out), fetch, historyCases(resolve(values.snapshot), Number(values.pairs)), Number(values['deadline-ms']));
}
