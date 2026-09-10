import { parseProfile, type Model, type Profile, type TurnInput } from './investigation.js';
import { ProviderRequestError } from './provider-error.js';
import { setTimeout as pause } from 'node:timers/promises';

const root = 'https://openrouter.ai/api/v1';
let nextRequestAt = 0; // Shared across serial reviews in this CLI process.
// Explicit free and paid routes; no auto-router, model fallback or arbitrary URL.
export function openRouterModel(profile: Profile, apiKey = process.env.OPENROUTER_API_KEY, transport = globalThis.fetch): Model {
  parseProfile(profile);
  if (profile.provider !== 'openrouter') throw new Error('Unsupported OpenRouter profile');
  const paid = profile.model === 'deepseek/deepseek-v3.2';
  const canonicalSlug = paid ? 'deepseek/deepseek-v3.2-20251201' : 'cohere/north-mini-code-20260617';
  const route = paid ? 'novita/fp8' : 'cohere';
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing. Configure it locally.');
  let verified = false;
  const payload = (input: TurnInput) => ({
    model: profile.model, messages: [{ role: 'system', content: input.instructions }, { role: 'user', content: input.context }, ...input.transcript],
    tools: input.tools.map(tool => ({ type: 'function', function: tool })), tool_choice: 'required',
    provider: { only: [route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: paid ? 0.269 : 0, completion: paid ? 0.4 : 0, request: 0 } },
    stream: false,
  });
  const getJson = async (url: string, options: RequestInit, stage: 'count' | 'inference') => {
    try {
      const response = await transport(url, { ...options, redirect: 'error' });
      if (!response.ok) throw new ProviderRequestError(stage, response.status, response.status === 402 ? 'insufficient_quota' : null);
      const text = await response.text();
      if (Buffer.byteLength(text) > 2000000) throw new ProviderRequestError(stage);
      const data = JSON.parse(text);
      if (data.error) throw new ProviderRequestError(stage, typeof data.error.code === 'number' ? data.error.code : undefined);
      return data;
    } catch (error) { if (error instanceof ProviderRequestError) throw error; throw new ProviderRequestError(stage); }
  };
  return {
    inputCountKind: 'conservative-estimate',
    async count(input, signal) {
      if (!verified) {
        const catalog = await getJson(`${root}/models`, { signal }, 'count');
        const entry = catalog.data?.find((m: { id?: string }) => m.id === profile.model);
        if (!entry || entry.canonical_slug !== canonicalSlug || (!paid && (entry.pricing?.prompt !== '0' || entry.pricing?.completion !== '0'))
          || !entry.supported_parameters?.includes('tools') || !entry.supported_parameters?.includes('tool_choice')) throw new ProviderRequestError('count', 400);
        if (paid) {
          const endpoints = await getJson(`${root}/models/${profile.model}/endpoints`, { signal }, 'count');
          const endpoint = endpoints.data?.endpoints?.find((e: { tag?: string }) => e.tag === route);
          const priced = (key: string, cap: number) => typeof endpoint?.pricing?.[key] === 'string' && endpoint.pricing[key].trim() !== '' && Number.isFinite(Number(endpoint.pricing[key])) && Number(endpoint.pricing[key]) >= 0 && Number(endpoint.pricing[key]) <= cap / 1_000_000;
          if (!endpoint || endpoint.status !== 0 || endpoint.supports_tool_choice?.required !== true
            || !endpoint.supported_parameters?.includes('tools') || !priced('prompt', 0.269) || !priced('completion', 0.4)
            || (endpoint.pricing?.request !== undefined && !priced('request', 0))) throw new ProviderRequestError('count', 400);
        }
        verified = true;
      }
      // No exact preflight tokenizer is available here. Conservatively bound context
      // using serialized UTF-8 bytes + overhead; actual tokens are still recorded.
      // Paid reservations use these upper-bound input bytes and maximum output at
      // the same price ceilings sent to the pinned provider. Actual cost settles them.
      return Buffer.byteLength(JSON.stringify(payload(input))) + 4096;
    },
    async respond(input, maxOutputTokens, signal) {
      await pause(Math.max(0, nextRequestAt - Date.now()), undefined, { signal });
      signal.throwIfAborted();
      nextRequestAt = Date.now() + 5000;
      const data = await getJson(`${root}/chat/completions`, { method: 'POST', signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'atmin review' },
        body: JSON.stringify({ ...payload(input), max_tokens: maxOutputTokens }),
      }, 'inference');
      const choice = data.choices?.[0];
      const message = choice?.message;
      if (!message || !data.usage) throw new ProviderRequestError('inference');
      // Preserve reasoning_details for tool continuity in memory; it is not persisted.
      return { model: data.model, inputTokens: data.usage.prompt_tokens ?? NaN, outputTokens: data.usage.completion_tokens ?? NaN,
        cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
        reportedCostUsd: data.usage.cost, responseId: data.id,
        status: ['tool_calls', 'stop'].includes(choice.finish_reason) ? 'completed' : choice.finish_reason === null ? 'interrupted' : 'incomplete', continuation: [message],
        calls: (message.tool_calls ?? []).map((call: { id: string; function: { name: string; arguments: string } }) =>
          ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
      };
    },
    toolOutput: (id, value) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) }),
  };
}
