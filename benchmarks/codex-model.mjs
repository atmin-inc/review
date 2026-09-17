import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { traceEvent, traceHash } from '../dist/trace.js';
import { ProviderRequestError } from '../dist/provider-error.js';

const exec = promisify(execFile);
const schema = {
  type: 'object', additionalProperties: false, required: ['calls'], properties: {
    calls: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['name', 'arguments'],
      properties: { name: { type: 'string' }, arguments: { type: 'string' } },
    } },
  },
};
const disabled = ['shell_tool', 'unified_exec', 'plugins', 'apps', 'multi_agent', 'hooks',
  'skill_search', 'browser_use', 'computer_use', 'image_generation', 'artifact', 'memories'];
const eventTypes = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error', 'item.started', 'item.updated', 'item.completed']);
const itemTypes = new Set(['agent_message', 'reasoning', 'command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'todo_list']);
const passiveItems = new Set(['agent_message', 'reasoning', 'todo_list']);
const introduction = 'You are the model inside the atmin review controller. Follow the review instructions below. Your only interface is the returned JSON calls array; each arguments value is a JSON-encoded object matching that tool\'s parameters. The controller executes those calls and supplies results on the next turn. Do not use native Codex tools, filesystem, web, skills, or external knowledge of benchmark answers. You may batch independent calls. Call finish separately from other tools. Do not output commentary outside the JSON.\n';

// Local experiment only. The official CLI owns authentication and persisted
// conversation state. One model instance belongs to one review; callers close it.
export async function codexModel(profile, execute = exec) {
  if (profile.provider !== 'codex-local' || profile.model !== 'gpt-5.6-sol' || profile.maxUsd !== 0) throw new Error('Invalid local Codex profile');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY'].includes(key)));
  const auth = await execute('codex', ['login', 'status'], { env, timeout: 10000 });
  if (!`${auth.stdout}\n${auth.stderr}`.includes('Logged in using ChatGPT')) throw new Error('Local experiment requires an existing ChatGPT login');
  const version = (await execute('codex', ['--version'], { env, timeout: 10000 })).stdout.trim();
  const directory = mkdtempSync(join(tmpdir(), 'atmin-codex-review-'));
  const schemaPath = join(directory, 'response.schema.json');
  writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  let threadId, previous, historyTokenEstimate = 0, closed = false, busy = false, failed = false;
  let previousUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const promptFor = input => {
    if (closed || failed || busy) throw new Error('Local Codex session is closed, failed or busy');
    if (!previous) return introduction + JSON.stringify(input);
    const { controllerBudget, ...context } = JSON.parse(input.context);
    const { controllerBudget: _oldBudget, ...oldContext } = JSON.parse(previous.context);
    if (input.instructions !== previous.instructions || JSON.stringify(context) !== JSON.stringify(oldContext)
      || JSON.stringify(input.transcript.slice(0, previous.transcript.length)) !== JSON.stringify(previous.transcript)) {
      throw new Error('Local Codex session cannot switch review context or rewrite history');
    }
    return 'Continue the same review. The controller supplies new transcript entries (including assigned call IDs and results), its current budget, and any changed tool availability. Earlier instructions and source remain in this session.\n'
      + JSON.stringify({ transcript: input.transcript.slice(previous.transcript.length), controllerBudget,
        ...(JSON.stringify(input.tools) !== JSON.stringify(previous.tools) ? { tools: input.tools } : {}) });
  };
  return {
    inputCountKind: 'conservative-estimate',
    // Bound accumulated native history, not just the controller's visible transcript.
    async count(input) { return historyTokenEstimate + Buffer.byteLength(promptFor(input)) + 65536; },
    close() { closed = true; rmSync(directory, { recursive: true, force: true }); },
    async respond(input, _maxOutputTokens, signal) {
      const prompt = promptFor(input);
      busy = true;
      const args = ['exec', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'read-only', ...disabled.flatMap(feature => ['--disable', feature]),
        '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
        '-c', 'model_reasoning_effort="medium"', '--model', profile.model, '-C', directory,
        ...(threadId ? ['resume', threadId] : []), '--json', '--output-schema', schemaPath, '-'];
      const started = performance.now();
      let stage = 'process', firstEventMs = null, lastEventMs = null, stderrBytes = 0, lines;
      const events = [];
      let malformed = false;
      const observe = line => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          events.push(event);
          lastEventMs = performance.now() - started;
          firstEventMs ??= lastEventMs;
          traceEvent('provider.codex.event', { event: eventTypes.has(event.type) ? event.type : 'other',
            item: event.item ? itemTypes.has(event.item.type) ? event.item.type : 'other' : null,
            elapsedMs: lastEventMs }, 2);
        } catch { malformed = true; }
      };
      const usageReply = (status, calls = []) => {
        const turns = events.filter(event => event.type === 'turn.completed');
        const usage = turns.length === 1 ? turns[0].usage : null;
        if (!usage || ![usage.input_tokens, usage.cached_input_tokens, usage.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)
          || usage.cached_input_tokens > usage.input_tokens) return null;
        // CLI 0.145 reports lifetime session totals, including previous turns.
        const delta = Object.fromEntries(Object.keys(previousUsage).map(key => [key, usage[key] - previousUsage[key]]));
        if (Object.values(delta).some(value => value < 0) || delta.cached_input_tokens > delta.input_tokens) return null;
        return { model: profile.model, status, calls, inputTokens: delta.input_tokens,
          cachedInputTokens: delta.cached_input_tokens, outputTokens: delta.output_tokens,
          reportedCostUsd: 0, continuation: status === 'completed' ? [{ role: 'assistant', calls }] : [] };
      };
      traceEvent('provider.codex.started', { version, model: profile.model, resumed: !!threadId,
        promptBytes: Buffer.byteLength(prompt), historyTokenEstimate }, 2);
      try {
        const pending = execute('codex', args, { env, signal, maxBuffer: 4 * 1024 * 1024 });
        if (pending.child?.stdout) {
          lines = createInterface({ input: pending.child.stdout });
          lines.on('line', observe);
        }
        pending.child?.stderr?.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); });
        pending.child?.stdin.end(prompt);
        const { stdout } = await pending;
        if (!lines) stdout.split('\n').forEach(observe);
        stage = 'event-json';
        if (malformed) throw new Error('Invalid CLI event JSON');
        stage = 'native-tool-or-failed-turn';
        if (events.some(event => event.type === 'turn.failed'
          || (event.type.startsWith('item.') && !passiveItems.has(event.item?.type)))) {
          throw new Error('Codex failed or used a native tool outside the review controller');
        }
        stage = 'session-identity';
        const threads = events.filter(event => event.type === 'thread.started');
        if (threads.length !== 1 || !/^[a-f0-9-]{36}$/.test(threads[0].thread_id)
          || (threadId && threads[0].thread_id !== threadId)) throw new Error('Invalid resumed Codex session');
        stage = 'completed-turn';
        if (!usageReply('completed')) throw new Error('Expected one completed Codex turn with usage');
        // CLI 0.145 drops app-server error.willRetry. A later completed turn can
        // resolve an earlier error; an error after completion stays ambiguous.
        if (events.findLastIndex(event => event.type === 'error') > events.findIndex(event => event.type === 'turn.completed')) {
          throw new Error('Codex error after completed turn');
        }
        stage = 'structured-output';
        const message = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item;
        const output = JSON.parse(message?.text ?? 'null');
        if (!Array.isArray(output?.calls) || output.calls.length < 1 || output.calls.length > 100
          || output.calls.some(call => typeof call?.name !== 'string' || typeof call.arguments !== 'string')) throw new Error('Invalid Codex tool batch');
        const calls = output.calls.map(call => ({ ...call, id: randomUUID() }));
        const reply = usageReply('completed', calls);
        threadId = threads[0].thread_id;
        previous = structuredClone(input);
        previousUsage = Object.fromEntries(Object.keys(previousUsage).map(key => [key, events.find(event => event.type === 'turn.completed').usage[key]]));
        // Count prompt/output bytes conservatively as tokens, plus all reported
        // generation (including reasoning). Native overhead is reserved in count().
        historyTokenEstimate += Buffer.byteLength(prompt) + Buffer.byteLength(message.text) + reply.outputTokens;
        traceEvent('provider.codex', { version, model: profile.model, billing: 'subscription',
          nativeToolCalls: 0, toolCalls: calls.length, recoveredErrors: events.filter(event => event.type === 'error').length }, 2);
        return reply;
      } catch (error) {
        failed = true; // Never continue after an ambiguous or rejected native turn.
        if (!lines && stage === 'process' && typeof error.stdout === 'string') error.stdout.split('\n').forEach(observe);
        const detail = [error.message, error.stderr, ...events.map(event => event.error?.message ?? (event.type === 'error' ? event.message : ''))].join('\n');
        const classification = /usage limit|rate.limit|quota|\b429\b/i.test(detail) ? 'rate-limit'
          : /unauthorized|authentication|\b(?:401|403)\b/i.test(detail) ? 'authentication'
          : /reconnect|stream disconnect|network|connection|timed? out|fetch failed/i.test(detail) ? 'transport'
          : /context.*(limit|length)|maximum context/i.test(detail) ? 'context'
          : /schema|invalid.*json/i.test(detail) ? 'schema' : 'unknown';
        const settled = usageReply('incomplete');
        traceEvent('provider.codex.failure', { stage, classification, usageKnown: !!settled,
          exitCode: Number.isInteger(error.code) ? error.code : null, detailHash: traceHash(detail),
          eventTypes: [...new Set(events.map(event => eventTypes.has(event.type) ? event.type : 'other'))],
          itemTypes: [...new Set(events.filter(event => event.item).map(event => itemTypes.has(event.item.type) ? event.item.type : 'other'))],
          completedTurns: events.filter(event => event.type === 'turn.completed').length }, 2);
        // The controller settles known usage before rejecting this incomplete
        // response. No tools or continuation from a rejected turn can be applied.
        if (settled) return settled;
        throw new ProviderRequestError('inference', classification === 'rate-limit' ? 429
          : classification === 'authentication' ? 401 : undefined);
      } finally {
        lines?.close(); busy = false;
        traceEvent('provider.codex.finished', { firstEventMs, lastEventMs,
          processMs: performance.now() - started, events: events.length, stderrBytes }, 2);
      }
    },
    toolOutput: (id, value) => ({ role: 'tool', id, output: value }),
  };
}
