import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { Model, Profile, TurnInput } from './investigation.js';
import { ProviderRequestError, type ProviderFailure } from './provider-error.js';
import { traceEvent, traceId } from './trace.js';

export function openAIModel(profile: Profile, apiKey = process.env.OPENAI_API_KEY, fetch?: typeof globalThis.fetch): Model {
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing. Configure it locally; never put a key in a profile or report.');
  // Fixed destination, no SDK retries or implicit account/base-URL environment overrides.
  const client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0,
    organization: null, project: null, timeout: profile.deadlineMs, ...(fetch ? { fetch } : {}) });
  const payload = (input: TurnInput) => ({
    model: profile.model, instructions: input.instructions,
    input: [{ role: 'user' as const, content: input.context }, ...input.transcript as ResponseInputItem[]],
    tools: input.tools.map(tool => ({ type: 'function' as const, ...tool, strict: false })),
    parallel_tool_calls: false, tool_choice: 'required' as const,
    reasoning: { effort: 'medium' as const }, truncation: 'disabled' as const,
  });
  const request = async <T>(stage: ProviderFailure['stage'], operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      throw new ProviderRequestError(stage, error instanceof OpenAI.APIError ? error.status : undefined,
        error instanceof OpenAI.APIError ? error.code : null);
    }
  };
  return {
    async count(input, signal) {
      return (await request('count', async () => client.responses.inputTokens.count(payload(input), { signal }))).input_tokens;
    },
    async respond(input, maxOutputTokens, signal) {
      const response = await request('inference', async () => client.responses.create({ ...payload(input), max_output_tokens: maxOutputTokens,
        store: false, include: ['reasoning.encrypted_content'], service_tier: 'default' }, { signal }));
      traceEvent('provider.response', { responseId: traceId(response.id), requestedModel: profile.model,
        returnedModel: response.model === profile.model ? profile.model : 'unexpected',
        status: response.status ?? 'unknown', toolCalls: response.output.filter(item => item.type === 'function_call').length,
        reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? null }, 2);
      return { model: response.model, inputTokens: response.usage?.input_tokens ?? NaN,
        responseId: response.id,
        outputTokens: response.usage?.output_tokens ?? NaN,
        cachedInputTokens: response.usage?.input_tokens_details.cached_tokens ?? NaN,
        cacheWriteTokens: response.usage?.input_tokens_details.cache_write_tokens ?? NaN,
        status: response.status ?? 'unknown', continuation: response.output,
        calls: response.output.filter(item => item.type === 'function_call')
          .map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments })),
      };
    },
    toolOutput: (id, value) => ({ type: 'function_call_output', call_id: id, output: JSON.stringify(value) }),
  };
}
