// Owned development cases. Expectations and executable oracles stay outside reviewer snapshots.
const dispatch = `export function dispatch(hooks, event, value) {
  const handler = hooks['on_' + event];
  if (handler) handler(value);
}
`;
const hooks = `export function createHooks(audit) {
  return {
    on_archived(document) {
      audit.push({ id: document.id, action: 'archived' });
    },
  };
}
`;
const page = `export function page(items, offset, size) {
  const end = Math.min(items.length, offset + size);
  return { values: items.slice(offset, end), cursor: end < items.length ? end : null };
}
`;
const reader = `import { page } from './page.mjs';
export function collect(items) {
  const values = [];
  let offset = 0;
  do {
    const result = page(items, offset, 2);
    values.push(...result.values);
    offset = result.cursor;
  } while (offset != null);
  return values;
}
`;
const payment = `export function createProcessor(post) {
  const seen = new Set();
  return function process(event) {
    if (seen.has(event.id)) return;
    post(event.amount);
    seen.add(event.id);
  };
}
`;
const asyncPayment = `export function createProcessor(post) {
  const seen = new Set();
  return async function process(event) {
    if (seen.has(event.id)) return;
    await post(event.amount);
    seen.add(event.id);
  };
}
`;
const coalesced = `export function createProcessor(post) {
  const seen = new Set();
  const pending = new Map();
  return function process(event) {
    if (seen.has(event.id)) return Promise.resolve();
    if (pending.has(event.id)) return pending.get(event.id);
    const work = Promise.resolve().then(() => post(event.amount)).then(() => {
      seen.add(event.id);
    }).finally(() => pending.delete(event.id));
    pending.set(event.id, work);
    return work;
  };
}
`;
export const fixtures = [
  { id: 'dispatch', category: 'runtime registration',
    base: { 'dispatch.mjs': dispatch, 'hooks.mjs': hooks,
      'archive.mjs': `import { dispatch } from './dispatch.mjs';\nexport function archive(document, hooks) {\n  document.archived = true;\n  dispatch(hooks, 'archived', document);\n}\n` },
    bug: { 'hooks.mjs': hooks.replace('on_archived(document)', 'on_archive(document)') },
    clean: { 'hooks.mjs': hooks.replace("      audit.push({ id: document.id, action: 'archived' });", "      const entry = { id: document.id, action: 'archived' };\n      audit.push(entry);") },
    expectation: 'The renamed hook no longer matches the dynamically dispatched archived event, so archiving silently stops producing an audit entry.',
    oracle: `import assert from 'node:assert/strict';
import { createHooks } from './hooks.mjs';
import { archive } from './archive.mjs';
const audit = [], document = { id: 'one', archived: false };
archive(document, createHooks(audit));
assert.equal(document.archived, true);
assert.deepEqual(audit, [{ id: 'one', action: 'archived' }]);
` },
  { id: 'pagination', category: 'producer-consumer compatibility',
    base: { 'page.mjs': page, 'reader.mjs': reader },
    bug: { 'page.mjs': page.replace('cursor:', 'nextCursor:') },
    clean: { 'page.mjs': page.replace('cursor:', 'nextCursor:'), 'reader.mjs': reader.replace('result.cursor', 'result.nextCursor') },
    expectation: 'The page result renames cursor without updating collect, so the unchanged consumer stops after the first page and loses remaining items.',
    oracle: `import assert from 'node:assert/strict';
import { collect } from './reader.mjs';
for (const values of [[], [1], [1, 2], [1, 2, 3, 4, 5]]) assert.deepEqual(collect(values), values);
` },
  { id: 'replay', category: 'asynchronous idempotency',
    base: { 'payment.mjs': payment,
      'webhook.mjs': `export async function receive(process, event) {\n  await process(event);\n  return { status: 204 };\n}\n` },
    bug: { 'payment.mjs': asyncPayment }, clean: { 'payment.mjs': coalesced },
    expectation: 'Awaiting the payment before marking its ID allows overlapping deliveries of the same event to both post the charge.',
    oracle: `import assert from 'node:assert/strict';
import { createProcessor } from './payment.mjs';
import { receive } from './webhook.mjs';
let calls = 0;
const process = createProcessor(() => { calls++; return Promise.resolve(); });
await Promise.all([receive(process, { id: 'a', amount: 10 }), receive(process, { id: 'a', amount: 10 })]);
await receive(process, { id: 'a', amount: 10 });
await receive(process, { id: 'b', amount: 5 });
assert.equal(calls, 2);
` },
];
