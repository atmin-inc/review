import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { Model, Profile, TurnInput } from './investigation.js';
import { ProviderRequestError, type ProviderFailure } from './provider-error.js';
import { traceEvent, traceId } from './trace.js';

// Luna on Amazon Bedrock, through bedrock-runtime's OpenAI-compatible endpoint, which takes a Bedrock
// API key as its bearer token. Its model is the US inference profile (us-east-1, us-east-2, us-west-2):
// that endpoint has no in-Region Luna, and its key needs only bedrock:InvokeModel on that profile and
// the account's default project, so it can be limited to Luna (recommended for Mason, 2026-10-07).
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html
export const bedrockOrigin = 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1';
export function openAIModel(profile: Profile, apiKey = process.env[profile.provider === 'bedrock' ? 'AWS_BEARER_TOKEN_BEDROCK' : 'OPENAI_API_KEY'], fetch?: typeof globalThis.fetch): Model {
  if (profile.provider !== 'openai' && profile.provider !== 'bedrock') throw new Error('Unsupported OpenAI profile');
  const bedrock = profile.provider === 'bedrock';
  if (!apiKey) throw new Error(`${bedrock ? 'AWS_BEARER_TOKEN_BEDROCK' : 'OPENAI_API_KEY'} is missing. Configure it locally; never put a key in a profile or report.`);
  // Fixed destination, no SDK retries or implicit account/base-URL environment overrides.
  const client = new OpenAI({ apiKey, baseURL: bedrock ? bedrockOrigin : 'https://api.openai.com/v1', maxRetries: 0,
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
    // Bedrock has no token-count route for Luna, so its input is bounded by serialized
    // UTF-8 bytes plus overhead, as on OpenRouter; actual tokens are still recorded.
    ...(bedrock ? { inputCountKind: 'conservative-estimate' as const } : {}),
    async count(input, signal) {
      if (bedrock) return Buffer.byteLength(JSON.stringify(payload(input))) + 4096;
      return (await request('count', async () => client.responses.inputTokens.count(payload(input), { signal }))).input_tokens;
    },
    async respond(input, maxOutputTokens, signal) {
      const response = await request('inference', async () => client.responses.create({ ...payload(input), max_output_tokens: maxOutputTokens,
        store: false, include: ['reasoning.encrypted_content'], ...(bedrock ? {} : { service_tier: 'default' as const }) }, { signal }));
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
