import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Attributes = Record<string, string | number | boolean | null | string[]>;
interface Event { name: string; ph: 'X' | 'i'; ts: number; pid: number; tid: number; s?: 't'; dur?: number; args: Attributes }
interface Context { emit: (event: Event) => void; attributes: Attributes }
const context = new AsyncLocalStorage<Context | undefined>();
const timestamp = () => performance.timeOrigin * 1000 + performance.now() * 1000;
export const traceHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const traceId = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9_/-]{1,160}$/.test(value) ? value : null;

// Call sites supply allowlisted operational metadata, never prompts, source,
// tool arguments, response bodies, reasoning, headers or raw exception messages.
export function traceEvent(name: string, attributes: Attributes = {}, lane = 1): void {
  const current = context.getStore();
  current?.emit({ name, ph: 'i', s: 't', ts: timestamp(), pid: 1, tid: lane, args: { ...current.attributes, ...attributes } });
}
export function startSpan(name: string, attributes: Attributes = {}, lane = 1) {
  const current = context.getStore(), started = timestamp();
  const args = { ...current?.attributes, ...attributes };
  traceEvent(`${name}.started`, attributes, lane);
  return (outcome: Attributes = {}) => current?.emit({ name, ph: 'X', ts: started, dur: Math.max(0, timestamp() - started),
    pid: 1, tid: lane, args: { ...args, ...outcome } });
}
export async function traceOperation<T>(name: string, attributes: Attributes, operation: () => Promise<T>, lane = 1): Promise<T> {
  const current = context.getStore();
  const end = startSpan(name, attributes, lane);
  try {
    const result = await context.run(current ? { ...current, attributes: { ...current.attributes, ...attributes } } : undefined,
      operation);
    end({ outcome: 'returned' }); return result;
  } catch (error) { end({ outcome: 'threw' }); throw error; }
}

export async function withTrace<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const fd = openSync(join(directory, 'trace.ndjson'), 'wx', 0o600);
  const events: Event[] = [];
  let bytes = 0, dropped = 0, failed = false;
  const emit = (event: Event) => {
    if (failed) return;
    try {
      const line = JSON.stringify(event) + '\n';
      // Bound storage even if a provider floods the response with tool calls.
      if (bytes + Buffer.byteLength(line) > 4 * 1024 * 1024) { dropped++; return; }
      appendFileSync(fd, line); bytes += Buffer.byteLength(line); events.push(event);
    } catch { failed = true; }
  };
  try {
    return await context.run({ emit, attributes: { traceId: randomUUID() } }, async () => {
      traceEvent('trace.started', { schemaVersion: 1, contentCapture: false });
      try { return await traceOperation('review.run', {}, operation); }
      finally { traceEvent('trace.finished', { droppedEvents: dropped, writeFailed: failed }); }
    });
  } finally {
    // Observability failures must not change a settled request's accounting or
    // cause inference to be repeated. NDJSON remains useful after interruption.
    try { closeSync(fd); } catch { failed = true; }
    try { writeFileSync(join(directory, 'trace.perfetto.json'), JSON.stringify({ traceEvents: events,
      displayTimeUnit: 'ms', metadata: { droppedEvents: dropped, writeFailed: failed } }), { flag: 'wx', mode: 0o600 }); }
    catch { failed = true; }
    if (failed) process.stderr.write('atmin review: diagnostic trace could not be fully written; inspect the review receipt.\n');
  }
}
