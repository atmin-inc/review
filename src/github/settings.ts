import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { readProfile } from '../run.js';
import { parseProfile, type Profile } from '../investigation.js';
import type { PilotConfig } from './config.js';
import type { Store } from './store.js';

export interface ModelChoice { id: string; label: string; profile: Profile; }
export interface ReviewPreferences { model: string; maxUsd: number; maxReviewsPerDay: number; }
// operators: GitHub user IDs (immutable, unlike logins) who may connect repositories from any
// installation they can see. Everyone else sees only installations an operator already approved.
export interface DashboardConfig { origin: string; clientId: string; clientSecret: string; models: ModelChoice[]; operators: number[]; appSlug?: string; }
export function readDashboardConfig(path: string, secret: string): DashboardConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || Object.keys(raw).some(k => !['origin', 'clientId', 'models', 'operators', 'appSlug'].includes(k))
    || typeof raw.origin !== 'string' || new URL(raw.origin).origin !== raw.origin || !raw.origin.startsWith('https://')
    || typeof raw.clientId !== 'string' || !/^[\w.-]{1,100}$/.test(raw.clientId) || !secret
    || !Array.isArray(raw.models) || !raw.models.length || raw.models.length > 3
    || (raw.operators !== undefined && (!Array.isArray(raw.operators) || raw.operators.length > 20
      || raw.operators.some((id: unknown) => !Number.isSafeInteger(id) || (id as number) < 1) || new Set(raw.operators).size !== raw.operators.length))
    || (raw.appSlug !== undefined && (typeof raw.appSlug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(raw.appSlug)))) throw new Error('Invalid dashboard configuration');
  const models: ModelChoice[] = raw.models.map((m: any) => {
    if (!m || Object.keys(m).some(k => !['id', 'label', 'profile'].includes(k))
      || typeof m.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(m.id)
      || typeof m.label !== 'string' || !m.label.trim() || m.label.length > 80 || typeof m.profile !== 'string') throw new Error('Invalid dashboard model');
    const profile = readProfile(resolve(dirname(path), m.profile));
    if (!process.env[profile.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY']) throw new Error('Dashboard model credential unavailable');
    return { id: m.id, label: m.label, profile };
  });
  if (new Set(models.map(m => m.id)).size !== models.length) throw new Error('Duplicate dashboard model');
  return { origin: raw.origin, clientId: raw.clientId, clientSecret: secret, models, operators: raw.operators ?? [], ...(raw.appSlug ? { appSlug: raw.appSlug } : {}) };
}

const sameProfile = (a: Profile, b: Profile) => Object.entries(a).every(([key, value]) => Reflect.get(b, key) === value);

export class ReviewSettings {
  readonly models: ModelChoice[];
  constructor(private config: PilotConfig, private store: Store, models?: ModelChoice[]) {
    const initial = readProfile(config.profile);
    this.models = models ?? [{ id: 'default', label: initial.model, profile: initial }];
    if (!this.models.some(m => sameProfile(m.profile, initial))) throw new Error('Configured profile must be offered in dashboard');
    store.db.exec('CREATE TABLE IF NOT EXISTS review_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    // Validate persisted choices against current operator ceilings before starting any jobs.
    this.current();
  }
  current(): ReviewPreferences {
    const saved = this.store.db.prepare('SELECT value FROM review_settings WHERE id=1').get();
    const initial = readProfile(this.config.profile);
    return this.validate(saved ? JSON.parse(String(saved.value)) : {
      model: this.models.find(m => sameProfile(m.profile, initial))!.id,
      maxUsd: initial.maxUsd, maxReviewsPerDay: this.config.maxReviewsPerDay,
    });
  }
  validate(value: unknown): ReviewPreferences {
    const p = value as ReviewPreferences;
    const choice = this.models.find(m => m.id === p?.model);
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== 3
      || Object.keys(p).some(k => !['model', 'maxUsd', 'maxReviewsPerDay'].includes(k)) || !choice
      || !Number.isFinite(p.maxUsd) || p.maxUsd < 0 || p.maxUsd > choice.profile.maxUsd
      || !Number.isSafeInteger(p.maxReviewsPerDay) || p.maxReviewsPerDay < 1 || p.maxReviewsPerDay > this.config.maxReviewsPerDay) throw new Error('Settings exceed operator limits');
    parseProfile({ ...choice.profile, maxUsd: p.maxUsd });
    return { model: p.model, maxUsd: p.maxUsd, maxReviewsPerDay: p.maxReviewsPerDay };
  }
  save(value: unknown): ReviewPreferences {
    const p = this.validate(value);
    this.store.db.prepare('INSERT INTO review_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(p));
    return p;
  }
  profile(): Profile {
    const p = this.current();
    return parseProfile({ ...this.models.find(m => m.id === p.model)!.profile, maxUsd: p.maxUsd });
  }
}
