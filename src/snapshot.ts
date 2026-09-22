import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ReviewInputError, defaultPolicy, initialResult, parsePacket, parsePolicy, parseResult, type Finding, type EvidenceAnchor, type ChangedFile, type Packet } from './contracts.js';
import { validateEvidence, validateFix, type Freshness } from './assessment.js';

const MAX_BYTES = 16 * 1024 * 1024;
const commandDeadline = new AsyncLocalStorage<number>();
export const withGitDeadline = <T>(deadlineMs: number, operation: () => T): T => commandDeadline.run(Date.now() + deadlineMs, operation);
const shaPattern = /^[a-f0-9]{40}$/;
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export interface PullState {
  repository: string;
  pr: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  state: 'open' | 'closed';
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReviewInputError(message);
}

// Do not inherit GIT_CONFIG_COUNT, GIT_DIR, replace objects, SSH overrides,
// NODE_OPTIONS, loaders or arbitrary Git config from the caller or checkout.
function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' };
}
function command(program: string, args: string[], cwd?: string, operation = args[0] ?? '', allowNoMatch = false): Buffer {
  const timeout = Math.min(120000, (commandDeadline.getStore() ?? (Date.now() + 120000)) - Date.now());
  requireValue(timeout > 0, 'Review deadline reached');
  try {
    return execFileSync(program, args, { ...(cwd ? { cwd } : {}), env: commandEnv(), maxBuffer: MAX_BYTES, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowNoMatch && error && typeof error === 'object' && 'status' in error && error.status === 1
      && 'stdout' in error && Buffer.isBuffer(error.stdout) && error.stdout.length === 0) return Buffer.alloc(0);
    // Child-process exceptions include arguments/output. Do not echo private data.
    throw new Error(`${program} ${operation} failed or exceeded its time/output limit. Check access and the requested revision.`);
  }
}
export function git(repository: string, args: string[], allowNoMatch = false): Buffer {
  return command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=/dev/null', '-c', 'credential.helper=',
    '-c', 'credential.https://github.com.helper=!gh auth git-credential',
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.ssh.allow=never', '-C', repository, ...args], undefined, args[0], allowNoMatch);
}
function gitText(repository: string, args: string[]): string { return decode(git(repository, args)); }

export function parsePullUrl(input: string): { repository: string; pr: number } {
  const url = new URL(input);
  requireValue(url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash,
    'Use an HTTPS github.com pull request URL without credentials, query or fragment');
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  requireValue(match && !['.', '..'].includes(match[1]!) && !['.', '..'].includes(match[2]!), 'Invalid GitHub pull request URL');
  const pr = Number(match[3]);
  requireValue(Number.isSafeInteger(pr), 'Invalid PR number');
  return { repository: `${match[1]}/${match[2]}`, pr };
}
// A branch name is several path segments, not one. Encoding the whole ref turns the
// separators in `codex/suggestion-demo-base` into %2F, which GitHub rejects, so every
// PR targeting a branch with a slash in its name looked unpreparable. Each segment is
// still encoded, and `.` and `..` are refused, so a ref cannot walk out of the
// endpoint it was interpolated into.
export function refPath(ref: string): string {
  const segments = ref.split('/');
  requireValue(segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..'),
    'Target branch name is not a valid ref path');
  return segments.map(encodeURIComponent).join('/');
}
type Request = (endpoint: string) => unknown;
const api: Request = endpoint => JSON.parse(decode(command('gh', ['api', '--hostname', 'github.com', endpoint])));
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Unexpected GitHub response');
  return value as Record<string, unknown>;
}
export function readPull(repository: string, pr: number, request: Request = api): PullState {
  // Validate identity before constructing API paths, including callers other than the CLI.
  parsePullUrl(`https://github.com/${repository}/pull/${pr}`);
  const pull = record(request(`repos/${repository}/pulls/${pr}`));
  const base = record(pull.base);
  const head = record(pull.head);
  const baseRepo = record(base.repo);
  requireValue(pull.number === pr && typeof baseRepo.full_name === 'string' && baseRepo.full_name.toLowerCase() === repository.toLowerCase(), 'GitHub PR identity changed');
  requireValue(typeof base.ref === 'string' && base.ref.length > 0, 'Missing target branch');
  // The PR object's base.sha may lag the actual target branch.
  const ref = record(request(`repos/${repository}/git/ref/heads/${refPath(base.ref)}`));
  const object = record(ref.object);
  requireValue(object.type === 'commit' && typeof object.sha === 'string' && shaPattern.test(object.sha), 'Cannot resolve current target commit');
  requireValue(typeof head.sha === 'string' && shaPattern.test(head.sha), 'Cannot resolve PR head');
  requireValue(pull.state === 'open' || pull.state === 'closed', 'Unknown PR state');
  return { repository: baseRepo.full_name, pr, headSha: head.sha, baseSha: object.sha, baseRef: base.ref, state: pull.state };
}
export function compareCurrent(packet: Packet, current: PullState): Freshness {
  const same = current.state === 'open' && current.repository.toLowerCase() === packet.repository.toLowerCase()
    && current.pr === packet.pr && current.headSha === packet.headSha && current.baseSha === packet.baseSha && current.baseRef === packet.baseRef;
  return { status: same ? 'current' : 'superseded', checkedAt: new Date().toISOString(),
    reason: same ? 'Head and current target matched at the recorded check time; later pushes invalidate this result.'
      : 'The PR closed, was retargeted, or its head/current target changed. This report applies only to the captured snapshot.' };
}
export function checkCurrent(packet: Packet): Freshness {
  try { return compareCurrent(packet, readPull(packet.repository, packet.pr)); }
  catch { return { status: 'unverified', checkedAt: new Date().toISOString(), reason: 'Live PR state could not be verified. No current-review conclusion is available.' }; }
}

interface FileObject { mode: string; bytes: Buffer }
function fileAt(repository: string, revision: string, path: string): FileObject | null {
  requireValue(shaPattern.test(revision), 'Invalid immutable revision');
  const entry = gitText(repository, ['ls-tree', '-z', '--full-tree', revision, '--', path]);
  if (!entry) return null;
  const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)\0$/.exec(entry);
  requireValue(match && match[4] === path, 'Expected one exact file object');
  if (match[1] === '160000') return { mode: match[1], bytes: Buffer.alloc(0) };
  const size = Number(gitText(repository, ['cat-file', '-s', match[3]!]).trim());
  requireValue(Number.isSafeInteger(size) && size <= MAX_BYTES, 'File exceeds the 16 MiB capture limit; snapshot is unavailable');
  return { mode: match[1]!, bytes: git(repository, ['cat-file', 'blob', match[3]!]) };
}
function fileKind(file: FileObject): ChangedFile['kind'] {
  if (file.mode === '120000') return 'symlink';
  if (file.mode === '160000') return 'submodule';
  if (file.bytes.includes(0)) return 'binary';
  try { decode(file.bytes); } catch { return 'binary'; }
  return 'text';
}

export function capture(repository: string, identity: PullState): { packet: Packet; diff: Buffer } {
  requireValue(shaPattern.test(identity.headSha) && shaPattern.test(identity.baseSha), 'Invalid capture revisions');
  const mergeBaseSha = gitText(repository, ['merge-base', identity.baseSha, identity.headSha]).trim();
  requireValue(shaPattern.test(mergeBaseSha), 'No valid common ancestor; capture unavailable');
  const inventory = gitText(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', mergeBaseSha, identity.headSha, '--']).split('\0');
  requireValue(inventory.pop() === '', 'Incomplete diff inventory');
  requireValue(inventory.length % 2 === 0 && inventory.length <= 2000, 'Invalid inventory or more than 1000 changed paths');
  const changedFiles: ChangedFile[] = [];
  for (let i = 0; i < inventory.length; i += 2) {
    const status = inventory[i]!;
    const path = inventory[i + 1]!;
    requireValue(['A', 'M', 'D', 'T'].includes(status), 'Unsupported change type');
    const before = fileAt(repository, mergeBaseSha, path);
    const after = fileAt(repository, identity.headSha, path);
    requireValue(before || after, 'Changed path has no captured object');
    const kinds = [before, after].filter((v): v is FileObject => v !== null).map(fileKind);
    const kind = kinds.find(k => k !== 'text') ?? 'text';
    changedFiles.push({ path, change: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified', kind });
  }
  const policyObject = fileAt(repository, identity.baseSha, '.atmin/review.json');
  requireValue(!policyObject || policyObject.mode === '100644' || policyObject.mode === '100755', 'Review policy must be a regular file');
  const policy = policyObject ? parsePolicy(JSON.parse(decode(policyObject.bytes))) : defaultPolicy();
  const diff = git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBaseSha, identity.headSha, '--']);
  // Keep the actual diff bytes: non-UTF8 source can still be captured but never marked text-reviewed.
  const packet = parsePacket({ schemaVersion: 1, repository: identity.repository, pr: identity.pr,
    baseRef: identity.baseRef, headSha: identity.headSha, baseSha: identity.baseSha, mergeBaseSha,
    createdAt: new Date().toISOString(), policy, policyHash: hash(JSON.stringify(policy)), diffHash: hash(diff), changedFiles });
  return { packet, diff };
}
function saveJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
export function prepare(url: string, output?: string): { directory: string; packet: Packet } {
  const parsed = parsePullUrl(url);
  const current = readPull(parsed.repository, parsed.pr);
  requireValue(current.state === 'open', 'Only open pull requests can be prepared');
  const directory = output ? resolve(output) : mkdtempSync(join(tmpdir(), 'atmin-review-'));
  if (output) mkdirSync(directory, { mode: 0o700 }); // Never overwrite an existing packet/workspace.
  const source = join(directory, 'source.git');
  mkdirSync(source, { mode: 0o700 });
  git(source, ['init', '--bare', '--template=']);
  git(source, ['remote', 'add', 'origin', `https://github.com/${current.repository}.git`]);
  // Investigation has no GitHub credential. Capture all objects now so reading
  // unchanged guidance and callers cannot trigger an authenticated lazy fetch.
  git(source, ['fetch', '--no-tags', 'origin', current.headSha, current.baseSha]);
  const { packet, diff } = capture(source, current);
  requireValue(compareCurrent(packet, readPull(current.repository, current.pr)).status === 'current', 'PR changed during capture; prepare a new snapshot');
  writeFileSync(join(directory, 'change.diff'), diff, { mode: 0o600, flag: 'wx' });
  saveJson(join(directory, 'packet.json'), packet);
  saveJson(join(directory, 'result.json'), initialResult(packet));
  return { directory, packet };
}
function jsonFile(path: string): unknown {
  const bytes = readFileSync(path);
  requireValue(bytes.length <= MAX_BYTES, 'Review JSON exceeds the 16 MiB limit');
  return JSON.parse(decode(bytes));
}
export function validateAnchor(repository: string, packet: Packet, anchor: EvidenceAnchor): void {
  const revision = anchor.side === 'head' ? packet.headSha : packet.mergeBaseSha;
  const file = fileAt(repository, revision, anchor.path);
  requireValue(file && fileKind(file) === 'text', 'Anchor does not reference a regular UTF-8 text file');
  if (anchor.line === null) return;
  const content = decode(file.bytes);
  const lineCount = content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  requireValue(anchor.line <= lineCount, 'Anchor line is outside its immutable source file');
}

// Source tools expose only immutable Git text, never host files or repository commands.
export function sourceText(repository: string, revision: string, path: string): string | null {
  const file = fileAt(repository, revision, path);
  if (!file) return null;
  requireValue(fileKind(file) === 'text', 'Only regular UTF-8 text can be read');
  return decode(file.bytes);
}
// Git owns path decoding and hunk construction. Use a literal path per diff so
// quoted names, renames and hunk-looking source text cannot change the inventory.
export function changedSourceRanges(repository: string, packet: Packet, file: ChangedFile) {
  const diff = gitText(repository, ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3',
    packet.mergeBaseSha, packet.headSha, '--', file.path]);
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
  return (['base', 'head'] as const).flatMap(side => {
    if (file.change === 'added' && side === 'base' || file.change === 'deleted' && side === 'head') return [];
    const index = side === 'base' ? 1 : 3;
    const ranges = hunks.flatMap(hunk => {
      const startLine = Number(hunk[index]), count = Number(hunk[index + 1] ?? 1);
      return count ? [{ path: file.path, side, startLine, endLine: startLine + count - 1 }] : [];
    });
    // Empty files and mode-only changes still require a source read on each
    // existing side; read_file represents an empty file as range 1–0.
    if (!ranges.length) {
      const text = sourceText(repository, side === 'base' ? packet.mergeBaseSha : packet.headSha, file.path);
      requireValue(text !== null, 'Changed source side is missing');
      ranges.push({ path: file.path, side, startLine: 1, endLine: text.length ? 1 : 0 });
    }
    return ranges;
  });
}
export function sourcePaths(repository: string, revision: string): string[] {
  requireValue(shaPattern.test(revision), 'Invalid immutable revision');
  const output = gitText(repository, ['ls-tree', '-r', '--name-only', '-z', revision]);
  return output ? output.slice(0, -1).split('\0') : [];
}
// `within` narrows the search to one path. A file-scoped check that greps the whole
// repository and filters afterwards cannot answer its own question: the 50-match cap is
// reached by matches in other files, and the check returns inconclusive although the
// answer was one grep away. Measured 2026-09-21 on Martian case-046, where
// `file_contains(assignment_source.py, "isoformat", expect: 'absent')` could not settle
// because `isoformat` appears throughout Sentry — which cost a correct finding.
export function searchSource(repository: string, revision: string, query: string, within?: string) {
  requireValue(shaPattern.test(revision), 'Invalid immutable revision');
  requireValue(query.length > 0 && query.length <= 200 && !/[\0\r\n]/.test(query), 'Search requires a single literal line of 1–200 characters');
  requireValue(within === undefined || (within.length > 0 && !/[\0\r\n]/.test(within)), 'A search path must be a single line');
  // Native Git searches frozen blobs without a checkout, text conversion or repository scripts.
  // The shared command deadline and 16 MiB output cap also bound broad searches.
  const output = decode(git(repository, ['grep', '-I', '-n', '-z', '-F', '--no-textconv', '-e', query, revision, '--',
    ...(within === undefined ? [] : [within])], true));
  const matches: { path: string; line: number }[] = [];
  for (const match of output.matchAll(/([^\0]+)\0(\d+)\0[^\n]*(?:\n|$)/g)) {
    if (matches.length === 50) return { matches, truncated: true };
    requireValue(match[1]!.startsWith(`${revision}:`), 'Search returned an unexpected revision');
    matches.push({ path: match[1]!.slice(revision.length + 1), line: Number(match[2]) });
  }
  return { matches, truncated: false };
}
export function sourceSlice(repository: string, revision: string, path: string, startLine: number, count: number) {
  requireValue(Number.isSafeInteger(startLine) && startLine >= 1 && Number.isSafeInteger(count) && count >= 1 && count <= 200,
    'Read requires a positive line and 1–200 lines');
  const content = sourceText(repository, revision, path);
  requireValue(content !== null, 'Path does not exist at this snapshot');
  const lines = content === '' ? [] : content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  requireValue(startLine <= Math.max(1, lines.length), 'Start line is outside source');
  const selected = lines.slice(startLine - 1, startLine - 1 + count);
  const text = selected.join('\n');
  requireValue(Buffer.byteLength(text) <= 24000, 'Source range exceeds 24 KB; request fewer lines');
  return { text, startLine, endLine: startLine - 1 + selected.length, totalLines: lines.length, contentHash: hash(text), revision };
}
export function validateCapturedEvidence(repository: string, packet: Packet, item: import('./contracts.js').Evidence): void {
  if (item.provenance !== 'controller-captured') return;
  const anchor = item.anchors[0]!;
  const revision = anchor.side === 'head' ? packet.headSha : packet.mergeBaseSha;
  const actual = sourceSlice(repository, revision, anchor.path, item.capture.startLine,
    Math.max(1, item.capture.endLine - item.capture.startLine + 1));
  const { text: _text, ...capture } = actual;
  requireValue(isDeepStrictEqual(capture, item.capture) && anchor.line === (capture.totalLines ? capture.startLine : null),
    'Captured source evidence does not match its immutable range and digest');
}
export function validateFixSource(repository: string, packet: Packet, finding: Finding): void {
  validateFix(finding);
  if (!finding.fix) return;
  const { startLine, endLine, original } = finding.fix;
  const source = sourceSlice(repository, packet.headSha, finding.anchor.path, startLine, endLine - startLine + 1);
  requireValue(source.endLine === endLine && source.text === original, 'Fix source does not match the captured head');
}
export function validateConventionRules(repository: string, packet: Packet, quality: import('./contracts.js').QualityReview): void {
  for (const rule of quality.conventionRules) {
    const source = sourceText(repository, packet.baseSha, rule.path);
    requireValue(source !== null && source.includes(rule.quote), 'Convention rule must quote exact text from the target branch');
  }
}
export function loadReview(directory: string) {
  const packet = parsePacket(jsonFile(join(directory, 'packet.json')));
  const result = parseResult(jsonFile(join(directory, 'result.json')));
  const repository = join(directory, 'source.git');
  const actual = capture(repository, { ...packet, state: 'open' }).packet;
  const { createdAt: _recordedTime, ...recorded } = packet;
  const { createdAt: _recomputedTime, ...recomputed } = actual;
  requireValue(isDeepStrictEqual(recorded, recomputed), 'Packet differs from immutable Git inventory, diff or target-branch policy');
  requireValue(hash(readFileSync(join(directory, 'change.diff'))) === packet.diffHash, 'Saved diff differs from its captured digest');
  validateEvidence(packet, result);
  if (result.quality) validateConventionRules(repository, packet, result.quality);
  for (const finding of result.findings) {
    validateAnchor(repository, packet, finding.anchor);
    validateFixSource(repository, packet, finding);
  }
  for (const item of result.evidence) for (const anchor of item.anchors) validateAnchor(repository, packet, anchor);
  for (const item of result.evidence) validateCapturedEvidence(repository, packet, item);
  return { packet, result };
}
