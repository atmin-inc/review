import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readProfile } from '../run.js';

export interface PilotConfig {
  repository: string;
  repositoryId: number;
  installationId: number;
  profile: string;
  stateDirectory: string;
  host: string;
  port: number;
  maxReviewsPerDay: number;
  trustedChecks?: { name: string; appId: number }[];
}
export function readConfig(path: string): PilotConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const keys = ['repository', 'repositoryId', 'installationId', 'profile', 'stateDirectory', 'host', 'port', 'maxReviewsPerDay', 'trustedChecks'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k))) throw new Error('Invalid pilot configuration');
  if (typeof raw.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(raw.repository)) throw new Error('Invalid pilot repository');
  for (const key of ['repositoryId', 'installationId', 'port', 'maxReviewsPerDay']) {
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 1) throw new Error(`Set a positive ${key}`);
  }
  if (raw.port > 65535 || raw.maxReviewsPerDay > 100) throw new Error('Pilot port or daily review limit out of range');
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(raw.host)) throw new Error('Unsupported listen address');
  for (const key of ['profile', 'stateDirectory']) if (typeof raw[key] !== 'string' || !raw[key]) throw new Error(`Set ${key}`);
  if (raw.trustedChecks !== undefined) {
    if (!Array.isArray(raw.trustedChecks) || raw.trustedChecks.length > 20
      || raw.trustedChecks.some((c: any) => !c || typeof c !== 'object' || Array.isArray(c)
        || Object.keys(c).some(k => !['name', 'appId'].includes(k))
        || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 200 || c.name === 'atmin review'
        || !Number.isSafeInteger(c.appId) || c.appId < 1)
      || new Set(raw.trustedChecks.map((c: any) => c.name)).size !== raw.trustedChecks.length) {
      throw new Error('Trusted checks require unique names and positive GitHub App IDs');
    }
  }
  const config: PilotConfig = { ...raw, profile: resolve(dirname(path), raw.profile), stateDirectory: resolve(dirname(path), raw.stateDirectory) };
  readProfile(config.profile);
  return config;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
