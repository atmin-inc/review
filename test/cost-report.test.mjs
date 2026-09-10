import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {costReport} from '../dist/cost-report.js';
import {repository, persist} from './helpers.mjs';

test('cost export includes failed runs, actual change size and unknown charges without calling them zero', t => {
  const f = repository(t), directory = persist(f);
  const receipt = {profile: {provider:'openrouter', model:'deepseek/deepseek-v3.2', maxUsd:2, maxTurns:24, maxToolCalls:80, maxInputTokens:100000, maxOutputTokens:8192, deadlineMs:600000},
    engineVersion:'fixture', promptHash:'fixture', toolHash:'fixture', rateCard:{}, startedAt:'2026-09-09T10:00:00Z', finishedAt:'2026-09-09T10:00:10Z', stopReason:'provider unavailable', toolCalls:0,
    calls:[{inputTokens:100,outputTokens:10,meteredUsd:0.001,reservedUsd:0.01},{inputTokens:200,outputTokens:null,meteredUsd:null,reservedUsd:0.02}]};
  writeFileSync(join(directory,'receipt.json'),JSON.stringify(receipt));
  const row = costReport(directory);
  assert.equal(row.changedFiles,1); assert.equal(row.addedLines,0); assert.equal(row.deletedLines,1);
  assert.equal(row.finished,false); assert.equal(row.totalCostUsd,null);
  assert.equal(row.knownCostUsd,0.001); assert.equal(row.unsettledReservedUsd,0.02);
  assert.equal(row.actualInputTokens,100); assert.equal(row.actualOutputTokens,10);
  assert.equal(row.elapsedMs,10000); assert.equal(row.complexity,'unlabelled');
  const partial = JSON.parse(readFileSync(join(directory, 'result.json')));
  partial.status = 'partial';
  writeFileSync(join(directory, 'result.json'), JSON.stringify(partial));
  receipt.stopReason = 'finished';
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt));
  assert.equal(costReport(directory).finished, false, 'a finish tool call is not a completed review');
});
