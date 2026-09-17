import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const rg = '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path/rg';
const git = '/Library/Developer/CommandLineTools/usr/bin';

// Local benchmark tool, not a portable production sandbox. The agent gets one
// ordinary shell, while macOS prevents reads of other cases, labels and accounts.
export function sourceShell(root, receipt) {
  if (process.platform !== 'darwin') throw Error('This experiment requires macOS Seatbelt');
  root = realpathSync(root);
  const quote = value => JSON.stringify(value);
  const profile = `(version 1)(allow default)
    (deny file-read* ${['/Users', '/private/tmp', '/private/var/folders', '/Volumes', '/opt', '/Applications'].map(path => `(subpath ${quote(path)})`).join(' ')})
    (allow file-read* (subpath ${quote(root)}) (literal ${quote(rg)}))
    (deny file-write* (require-not (subpath "/dev")))
    (deny network*)
    (deny process-exec (subpath ${quote(root)}))`;
  const env = { PATH: `${git}:${dirname(rg)}:/usr/bin:/bin`, HOME: root, TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', PAGER: 'cat', LC_ALL: 'C' };
  let calls = 0, bytes = 0;
  return async command => {
    if (typeof command !== 'string' || command.length > 20000) throw Error('Invalid command');
    if (++calls > 1000 || bytes >= 1048576) throw Error('Source inspection budget exhausted');
    const start = Date.now();
    let output, code;
    try {
      const result = await exec('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', command],
        { cwd: root, env, timeout: 30000, maxBuffer: 131072 });
      output = result.stdout + result.stderr; code = 0;
    } catch (error) {
      output = (error.stdout ?? '') + (error.stderr ?? '');
      code = Number.isInteger(error.code) ? error.code : -1;
    }
    const buffer = Buffer.from(output), limit = Math.min(32768, 1048576 - bytes);
    output = buffer.subarray(0, limit).toString(); bytes += Math.min(buffer.length, limit);
    const record = { call: calls, command, exitCode: code, output,
      truncated: buffer.length > limit, elapsedMs: Date.now() - start, cumulativeOutputBytes: bytes };
    if (receipt) appendFileSync(receipt, JSON.stringify(record) + '\n', { mode: 0o600 });
    return record;
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = sourceShell(process.argv[2], process.argv[3]);
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try {
      message = JSON.parse(line);
      if (message.id === undefined) continue;
      if (message.method === 'initialize') send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'source-shell', version: '1' } });
      else if (message.method === 'tools/list') send(message.id, { tools: [{ name: 'shell', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, description: 'Read-only source inspection using sh, git, rg, cat, sed and other installed OS tools. No network, writes or private files. Do not execute repository code or tests. Output limited to 32 KiB per call; request smaller ranges if truncated.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }] });
      else if (message.method === 'tools/call' && message.params?.name === 'shell') send(message.id, { content: [{ type: 'text', text: JSON.stringify(await run(message.params.arguments?.command)) }] });
      else if (message.method === 'ping') send(message.id, {});
      else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
    } catch {
      if (message?.id !== undefined) send(message.id, { isError: true, content: [{ type: 'text', text: 'Source tool request failed.' }] });
    }
  }
}
