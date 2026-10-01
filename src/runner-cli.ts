#!/usr/bin/env node
import { main } from './code-review-runner.js';

try { await main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Runner failed'}\n`);
  process.exitCode = 1;
}
