import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usd, monthName, utcDate, share, runCost, plural } from '../src/format.js';
import { toWoff2, readTables } from '../scripts/woff2.mjs';
import { brotliDecompressSync } from 'node:zlib';

test('USD uses two decimals, four under $0.10', () => {
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(0.0412), '$0.0412');
  assert.equal(usd(0.1), '$0.10');
  assert.equal(usd(23.186), '$23.19');
  assert.equal(usd(1234.5), '$1,234.50');
  // A small negative margin keeps its precision instead of reading as -$0.00.
  assert.equal(usd(-0.0412), '-$0.0412');
  assert.equal(usd(-0.3), '-$0.30');
});

test('unknown cost is never shown as zero', () => {
  assert.equal(runCost({ started: true, usage: { totalUsd: null } }), 'Unsettled');
  assert.equal(runCost({ started: true, usage: null }), 'Unsettled');
  assert.equal(runCost({ started: false, usage: null }), 'None');
  assert.equal(runCost({ started: true, usage: { totalUsd: 0.31 } }), '$0.31');
});

test('dates and shares', () => {
  assert.equal(monthName('2026-09'), 'September 2026');
  assert.equal(utcDate('2026-10-01T00:00:00.000Z'), 'October 1, 2026');
  assert.equal(share(12, 20), 60);
  assert.equal(share(25, 20), 100);
  assert.equal(share(0, 0), 100);
  assert.equal(plural(1, 'review'), '1 review');
  assert.equal(plural(1200, 'review'), '1,200 reviews');
});

test('WOFF2 encoding keeps every table byte-for-byte', () => {
  const font = readFileSync(new URL('../fonts/GeistMono-Regular.ttf', import.meta.url));
  const woff = toWoff2(font);
  assert.equal(woff.toString('latin1', 0, 4), 'wOF2');
  assert.equal(woff.readUInt32BE(8), woff.length);
  const tables = readTables(font);
  assert.equal(woff.readUInt16BE(12), tables.length);
  // Walk the directory: flags, optional tag, UIntBase128 length. Nothing is transformed.
  let at = 48;
  const order = [];
  for (let i = 0; i < tables.length; i++) {
    const flags = woff[at++];
    if ((flags & 0x3f) === 63) at += 4;
    let length = 0;
    do length = length * 128 + (woff[at] & 0x7f); while (woff[at++] & 0x80);
    order.push({ flags, length });
  }
  const data = brotliDecompressSync(woff.subarray(at, at + woff.readUInt32BE(20)));
  assert.equal(data.length, order.reduce((sum, t) => sum + t.length, 0));
  // glyf is stored untransformed and loca follows it directly.
  const glyfIndex = order.findIndex(t => t.flags === (10 | 0xc0));
  assert.equal(order[glyfIndex + 1].flags, 11 | 0xc0);
  const glyf = tables.find(t => t.tag === 'glyf');
  const offset = order.slice(0, glyfIndex).reduce((sum, t) => sum + t.length, 0);
  assert.ok(data.subarray(offset, offset + glyf.length).equals(font.subarray(glyf.offset, glyf.offset + glyf.length)));
});
