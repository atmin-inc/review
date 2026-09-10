export interface ProviderFailure {
  kind: 'funding' | 'authentication' | 'rate-limit' | 'request' | 'unavailable';
  stage: 'count' | 'inference';
  status: number | null;
  code: string | null;
}

// Only controller-owned messages and allowlisted codes are safe to persist.
const funding = new Set(['credit_balance_exhausted', 'insufficient_quota', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded']);
export class ProviderRequestError extends Error {
  readonly failure: ProviderFailure;
  constructor(stage: ProviderFailure['stage'], status?: number, code?: string | null) {
    const kind = code && funding.has(code) ? 'funding'
      : status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate-limit'
      : status !== undefined && status >= 400 && status < 500 ? 'request' : 'unavailable';
    const messages = {
      funding: 'Provider funding unavailable: add API credits or check the account spending limit.',
      authentication: 'Provider authentication or access denied: check the configured API project and key.',
      'rate-limit': 'Provider rate limit reached: pause the experiment before another attempt.',
      request: 'Provider rejected the request: inspect adapter compatibility before another attempt.',
      unavailable: 'Provider unavailable: the request failed without confirmed usage.',
    };
    super(messages[kind]);
    this.failure = { kind, stage, status: Number.isInteger(status) && status! >= 100 && status! <= 599 ? status! : null,
      code: code && funding.has(code) ? code : null };
  }
}
