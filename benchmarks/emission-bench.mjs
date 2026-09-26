// The emission bench: re-asks only the claim-writing step over one frozen reading.
//
// An end-to-end run spends most of its eight minutes and most of its variance on what the
// model happens to read. This bench takes a run recorded with `{ transcript: true }`, keeps
// its reading (every read_file and search_repository call with its result), drops every
// claim it recorded, and asks the model to write claims again from that same reading. Each
// sample is one or two model calls. Two emitter variants are compared by pointing --dist at
// each variant's build, over the same recordings.
//
// Usage: node benchmarks/emission-bench.mjs <recorded-run-dir> <out-dir> [--samples N]
//          [--dist path/to/dist] [--profile profiles/martian-luna-openrouter.json | profiles/martian-deepseek.json] [--turns 16] [--temperature T] [--no-jev] [--require-correction]
// Each sample is written as <out-dir>/<case>-r<n>/{claims,verification,telemetry}.json, the
// layout score-runs.mjs and the blind labelling already read.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { readingOnly } from './reading-only.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const [runDir, outDir] = args.map(a => resolve(a));
const samples = Number(flag('--samples', 5));
const dist = resolve(flag('--dist', new URL('../dist', import.meta.url).pathname));
const { readProfile } = await import(join(dist, 'run.js'));
const { investigateClaims } = await import(join(dist, 'investigator.js'));
const { verifyClaims } = await import(join(dist, 'lifecycle.js'));
const { recordedRung } = await import(join(dist, 'ablation.js'));
const { askJev } = await import(join(dist, 'jev.js'));
const { revisionFrom } = await import(join(dist, 'symbolic.js'));
const { loadReview, sourceText } = await import(join(dist, 'snapshot.js'));
const { BALANCED } = await import(join(dist, 'policy.js'));
const { price } = await import(join(dist, 'investigation.js'));
const { openRouterModel } = await import(join(dist, 'openrouter-model.js'));

const profile = readProfile(resolve(flag('--profile', new URL('../profiles/martian-luna-openrouter.json', import.meta.url).pathname)));
const { packet } = loadReview(runDir);
const repository = join(runDir, 'source.git');
const revisions = { head: revisionFrom(repository, packet.headSha), base: revisionFrom(repository, packet.mergeBaseSha) };
const sourceOf = path => sourceText(repository, packet.headSha, path);
const diff = readFileSync(join(runDir, 'change.diff'), 'utf8');
const context = { packet, diff };

const recorded = JSON.parse(readFileSync(join(runDir, 'transcript.json'), 'utf8'));
// The recording is every turn the run took, before the trimming the live run did, so it
// can be larger than the window. The investigator treats a prior transcript as one turn and
// cannot trim inside it, so the oldest reading turns are dropped here, whole, until the
// serialized reading leaves room for the prompt, the diff and the reply. Like the live
// trimming, this costs the reading the run itself had already stopped seeing.
let prior = readingOnly(recorded), droppedReading = 0;
const room = profile.maxInputTokens - Buffer.byteLength(JSON.stringify(context)) - 40000;
while (prior.length && Buffer.byteLength(JSON.stringify(prior)) > room) {
  const next = prior.findIndex((entry, index) => index > 0 && entry.role === 'assistant');
  prior = next < 0 ? [] : prior.slice(next);
  droppedReading++;
}
if (droppedReading) console.log(`dropped the oldest ${droppedReading} reading turn(s) to fit the window`);
const id = basename(runDir).replace(/-r\d+$/, '');
mkdirSync(outDir, { recursive: true });
// --temperature sets the sampling temperature on every request, through the transport so
// the product's adapter is untouched. Unset, the provider's default applies, as in the product.
const temperature = flag('--temperature');
const transport = temperature === undefined ? globalThis.fetch : (url, options) =>
  globalThis.fetch(url, typeof options?.body === 'string' && String(url).endsWith('/chat/completions')
    ? { ...options, body: JSON.stringify({ ...JSON.parse(options.body), temperature: Number(temperature) }) } : options);
// A claude-local profile runs on the Claude Code CLI's subscription instead; --temperature
// does not reach it, because the CLI has no such setting.
if (temperature !== undefined && profile.provider === 'claude-local') throw new Error('--temperature is not available for claude-local');
const model = profile.provider === 'claude-local'
  ? (await import('./claude-model.mjs')).claudeModel(profile) : openRouterModel(profile, undefined, transport);
for (let n = 1; n <= samples; n++) {
  const dir = join(outDir, `${id}-r${n}`);
  if (existsSync(join(dir, 'verification.json'))) continue; // resumable
  mkdirSync(dir, { recursive: true });
  // The model records about one claim per turn (case-005's recorded run: five claims over
  // five turns; up to twelve claims in the ten runs recorded 2026-09-23), so a tight turn
  // limit caps the claim count rather than measuring it. Sixteen leaves room for that.
  // A stream the provider cut before anything was recorded measured nothing about the
  // emitter, so it is asked again, at most twice; its cost is still counted.
  let investigation, attempts = 0, retriedUsd = 0;
  do {
    if (investigation) retriedUsd += investigation.spentUsd;
    investigation = await investigateClaims(revisions, sourceOf, context, model, {
      maxTurns: Number(flag('--turns', 16)), maxToolCalls: profile.maxToolCalls, maxInputTokens: profile.maxInputTokens,
      maxOutputTokens: profile.maxOutputTokens, maxUsd: profile.maxUsd,
      costOf: (input, output) => profile.maxUsd === 0 ? 0 : price(input, output, 0, profile.model), priorTranscript: prior,
      charged: reply => profile.maxUsd === 0 ? 0 : reply.reportedCostUsd ?? price(reply.inputTokens, reply.outputTokens, reply.cachedInputTokens, profile.model),
      ...(args.includes('--require-correction') ? { requireCorrection: true } : {}),
    });
  } while (++attempts < 3 && !investigation.claims.length && /^Provider response interrupted/.test(investigation.stopReason ?? ''));
  let rung;
  if (!args.includes('--no-jev') && investigation.claims.length) {
    rung = recordedRung((await askJev(investigation.claims, revisions, diff, {})).log);
  }
  const verification = verifyClaims(investigation.claims, revisions, BALANCED, rung);
  writeFileSync(join(dir, 'claims.json'), JSON.stringify(investigation.claims, null, 1));
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(verification, null, 1));
  writeFileSync(join(dir, 'telemetry.json'), JSON.stringify({ ...investigation.telemetry,
    stopReason: investigation.stopReason, claims: investigation.claims.length, spentUsd: investigation.spentUsd, retriedUsd, attempts, droppedReading, toolErrors: investigation.toolErrors }, null, 1));
  const shipped = verification.chains.filter(chain => chain.verdict === 'confirmed').length;
  console.log(`${id} r${n}: claims=${investigation.claims.length} shipped=${shipped} turns=${investigation.telemetry.turns} $${investigation.spentUsd.toFixed(3)} ${investigation.stopReason}`);
}
