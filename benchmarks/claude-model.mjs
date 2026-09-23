import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { traceEvent, traceHash } from '../dist/trace.js';
import { ProviderRequestError } from '../dist/provider-error.js';
import { claudeModels } from '../dist/investigation.js';

const schema = {
  type: 'object', additionalProperties: false, required: ['calls'], properties: {
    calls: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['name', 'arguments'],
      properties: { name: { type: 'string' }, arguments: { type: 'string' } },
    } },
  },
};
const introduction = 'You are the model inside the atmin review controller. Follow the review instructions below. Your only interface is the returned JSON calls array; each arguments value is a JSON-encoded object matching that tool\'s parameters. The controller executes those calls and supplies their results in the transcript of the next request. You have no native tools, filesystem, web or external knowledge of benchmark answers. You may batch independent calls. Do not output commentary outside the JSON.\n\n';
// Anything that would put text other than this prompt in front of the model: memory,
// extra CLAUDE.md directories, and the parent session's own effort setting.
const withheld = /^(CLAUDE_COWORK_MEMORY|CLAUDE_MEMORY|CLAUDE_CODE_ADDITIONAL_DIRECTORIES|CLAUDE_ADDITIONAL_DIRECTORIES|CLAUDE_EFFORT$|OPENAI_API_KEY$|OPENROUTER_API_KEY$|TYPESAFE_API_KEY$)/;

function run(binary, args, options, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, options);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// Local experiment only, on the subscription the Claude Code CLI is signed in with. Each
// request is stateless: the whole conversation goes in the prompt, so any transcript
// works, including one recorded from another provider, which the emission bench needs.
export function claudeModel(profile, execute = run) {
  if (profile.provider !== 'claude-local' || !claudeModels.includes(profile.model) || profile.maxUsd !== 0) throw new Error('Invalid local Claude profile');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !withheld.test(key)));
  // An empty directory, so no project CLAUDE.md, AGENTS.md or settings are picked up.
  const directory = mkdtempSync(join(tmpdir(), 'atmin-claude-review-'));
  let closed = false;
  const promptFor = input => JSON.stringify({ context: JSON.parse(input.context), tools: input.tools, transcript: input.transcript });
  return {
    inputCountKind: 'conservative-estimate',
    // Bytes, as the OpenRouter adapter counts, plus the CLI's own overhead.
    async count(input) { return Buffer.byteLength(introduction + input.instructions) + Buffer.byteLength(promptFor(input)) + 16384; },
    close() { closed = true; rmSync(directory, { recursive: true, force: true }); },
    async respond(input, maxOutputTokens, signal) {
      if (closed) throw new Error('Local Claude model is closed');
      const prompt = promptFor(input);
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '',
        '--setting-sources', '', '--model', profile.model, '--effort', 'medium',
        '--system-prompt', introduction + input.instructions, '--json-schema', JSON.stringify(schema)];
      const started = performance.now();
      let stage = 'process', result = null;
      try {
        const { code, stdout, stderr } = await execute('claude', args,
          { cwd: directory, env: { ...env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }, signal }, prompt);
        stage = 'result-json';
        result = JSON.parse(stdout || 'null');
        if (!result || typeof result !== 'object') throw new Error(`No result (exit ${code}); ${stderr.slice(0, 200)}`);
        stage = 'usage';
        const usage = result.usage ?? {};
        const counts = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].map(key => usage[key] ?? 0);
        if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Malformed usage');
        const [fresh, created, read, outputTokens] = counts;
        const reply = (status, calls = []) => ({ model: profile.model, status, calls,
          inputTokens: fresh + created + read, cachedInputTokens: read, outputTokens,
          // List-price equivalent the CLI reports; billing is the subscription.
          reportedCostUsd: 0, continuation: status === 'completed' ? [{ role: 'assistant', calls }] : [] });
        traceEvent('provider.claude', { model: profile.model, billing: 'subscription', subtype: typeof result.subtype === 'string' ? result.subtype : null,
          stopReason: typeof result.stop_reason === 'string' ? result.stop_reason : null, isError: result.is_error === true,
          numTurns: Number.isSafeInteger(result.num_turns) ? result.num_turns : null,
          listPriceUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
          processMs: performance.now() - started }, 2);
        if (result.is_error || code !== 0) {
          if (result.stop_reason === 'max_tokens' || result.subtype === 'error_max_structured_output_retries') return reply('incomplete');
          throw new Error(String(result.result ?? result.subtype ?? 'CLI error'));
        }
        stage = 'structured-output';
        const output = result.structured_output;
        if (!Array.isArray(output?.calls) || output.calls.length < 1 || output.calls.length > 100
          || output.calls.some(call => typeof call?.name !== 'string' || typeof call.arguments !== 'string')) throw new Error('Invalid Claude tool batch');
        return reply('completed', output.calls.map(call => ({ ...call, id: randomUUID() })));
      } catch (error) {
        if (signal?.aborted) throw error;
        const detail = `${error.message}\n${result?.result ?? ''}`;
        const classification = /usage limit|rate.limit|quota|overloaded|\b429\b|\b529\b/i.test(detail) ? 'rate-limit'
          : /unauthorized|authentication|log ?in|\b(?:401|403)\b/i.test(detail) ? 'authentication'
          : /prompt is too long|context.*(limit|length)/i.test(detail) ? 'context' : 'unknown';
        traceEvent('provider.claude.failure', { stage, classification, detailHash: traceHash(detail) }, 2);
        throw new ProviderRequestError('inference', classification === 'rate-limit' ? 429 : classification === 'authentication' ? 401 : undefined);
      }
    },
    toolOutput: (id, value) => ({ role: 'tool', id, output: value }),
  };
}
