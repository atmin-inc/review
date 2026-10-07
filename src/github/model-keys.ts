import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseProfile, type TurnInput } from '../investigation.js';
import { openAIModel } from '../openai-model.js';
import { ProviderRequestError } from '../provider-error.js';
import type { ModelKeyProvider } from './store.js';

// An organization's own model key (bring your own key): with one set, every review this service
// runs for the organization's repositories uses it instead of this service's key, and its plan
// and credit do not count those reviews. Only Luna on Amazon Bedrock so far, set by an operator
// on /admin (decision: Lors, 2026-10-07, for Mason). The key is stored sealed with
// ATMIN_REVIEW_KEY_SECRET, so a copy of the database or a query printed to a terminal never
// shows it. A hosted runner receives it with that organization's job and the job forgets it
// once claimed. A review never falls back to this service's key.
export interface ModelKeyView { provider: ModelKeyProvider; last4: string; updatedAt: string; updatedBy: number }
export const modelKeyProviders: readonly ModelKeyProvider[] = ['bedrock'];
export const keyPattern = /^[\x21-\x7e]{20,3000}$/;

export class ModelKeys {
  private sealing: Buffer | null;
  constructor(private db: DatabaseSync, secret: string | undefined) {
    db.exec('CREATE TABLE IF NOT EXISTS model_keys (installation INTEGER PRIMARY KEY, provider TEXT NOT NULL, sealed TEXT NOT NULL, last4 TEXT NOT NULL, updated INTEGER NOT NULL, updatedBy INTEGER NOT NULL)');
    if (secret !== undefined && Buffer.byteLength(secret) < 32) throw new Error('Set ATMIN_REVIEW_KEY_SECRET to a secret of at least 32 bytes');
    this.sealing = secret === undefined ? null : createHash('sha256').update(secret).digest();
  }
  // Whether keys can be stored and used at all: the service has ATMIN_REVIEW_KEY_SECRET.
  get ready(): boolean { return this.sealing !== null; }
  // Which provider's key the organization's reviews run on, or null for this service's own.
  provider(installation: number): ModelKeyProvider | null {
    return (this.db.prepare('SELECT provider FROM model_keys WHERE installation=?').get(installation)?.provider as ModelKeyProvider | undefined) ?? null;
  }
  view(installation: number): ModelKeyView | null {
    const row = this.db.prepare('SELECT provider,last4,updated,updatedBy FROM model_keys WHERE installation=?').get(installation);
    return row ? { provider: row.provider as ModelKeyProvider, last4: String(row.last4), updatedAt: new Date(Number(row.updated)).toISOString(), updatedBy: Number(row.updatedBy) } : null;
  }
  set(installation: number, provider: ModelKeyProvider, key: string, by: number, now = Date.now()): void {
    if (!modelKeyProviders.includes(provider) || !keyPattern.test(key)) throw new Error('Invalid model key');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(`${installation}:${provider}`));
    const sealed = Buffer.concat([iv, cipher.update(key, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    this.db.prepare(`INSERT INTO model_keys VALUES(?,?,?,?,?,?) ON CONFLICT(installation) DO UPDATE SET
      provider=excluded.provider,sealed=excluded.sealed,last4=excluded.last4,updated=excluded.updated,updatedBy=excluded.updatedBy`)
      .run(installation, provider, sealed, key.slice(-4), now, by);
    process.stderr.write(`atmin review: ${provider} model key ending ${key.slice(-4)} set for installation ${installation} by GitHub user ${by}\n`);
  }
  // The key itself, for a review's runner. Throws when it cannot be unsealed, so a review stops
  // rather than run on this service's key.
  get(installation: number): { provider: ModelKeyProvider; key: string } | null {
    const row = this.db.prepare('SELECT provider,sealed FROM model_keys WHERE installation=?').get(installation);
    if (!row) return null;
    const sealed = Buffer.from(String(row.sealed), 'base64');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${installation}:${row.provider}`));
      decipher.setAuthTag(sealed.subarray(-16));
      return { provider: row.provider as ModelKeyProvider, key: Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]).toString('utf8') };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ATMIN_REVIEW_KEY_SECRET')) throw error;
      throw new Error(`The model key of installation ${installation} cannot be unsealed; ATMIN_REVIEW_KEY_SECRET changed since it was set`);
    }
  }
  remove(installation: number, by: number): boolean {
    const removed = this.db.prepare('DELETE FROM model_keys WHERE installation=?').run(installation).changes === 1;
    if (removed) process.stderr.write(`atmin review: model key removed for installation ${installation} by GitHub user ${by}\n`);
    return removed;
  }
  private key(): Buffer {
    if (!this.sealing) throw new Error('ATMIN_REVIEW_KEY_SECRET is not set, so organizations\' own model keys cannot be stored or used');
    return this.sealing;
  }
}

// Calls the model once with the key, in the shape a review sends (a required tool call), so a
// key that cannot run reviews (wrong region, model access off, revoked) is refused when it is set
// rather than at a review. The call costs the key's owner a fraction of a cent.
export async function checkModelKey(provider: ModelKeyProvider, key: string, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<string | null> {
  if (provider !== 'bedrock') return 'Unsupported model key provider.';
  const profile = parseProfile({ provider: 'bedrock', model: 'openai.gpt-6-luna', maxUsd: 0.01, maxTurns: 1, maxToolCalls: 1, maxInputTokens: 2000, maxOutputTokens: 1024, deadlineMs: 30_000 });
  const tools = [{ name: 'ok', description: 'Confirms that the call worked.', parameters: { type: 'object', properties: {}, additionalProperties: false } }] as unknown as TurnInput['tools'];
  try {
    await openAIModel(profile, key, fetch).respond({ instructions: 'Call the ok tool.', context: 'This checks that the key can call the model.', tools, transcript: [] }, 1024, AbortSignal.timeout(30_000));
    return null;
  } catch (error) {
    const failure = error instanceof ProviderRequestError ? error.failure : null;
    process.stderr.write(`atmin review: ${provider} model key check failed: ${failure ? `${failure.kind}, HTTP ${failure.status ?? 'none'}` : 'no response'}\n`);
    return failure?.kind === 'authentication' ? 'Amazon Bedrock refused the key. Use a Bedrock API key for us-east-1 whose account has access to OpenAI GPT-6 Luna turned on.'
      : failure ? `Amazon Bedrock did not run the check call (${failure.kind}${failure.status ? `, HTTP ${failure.status}` : ''}). The key was not saved.`
      : 'Amazon Bedrock could not be reached. The key was not saved.';
  }
}
