import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureExcerpt, FAILURE_WINDOW } from '../dist/failure-excerpt.js';

// The failure-path pass re-sends its context every turn and nothing is cached, so the
// whole diff made it 2-3x a review's cost on mason-v1 #4590. It is shown only the lines
// around error handling, and a change with none gets no pass at all.
const newFile = (path, lines) => [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join('\n') + '\n';

test('a new file is cut to the window around its throw, and the window is still a diff', () => {
  const lines = Array.from({ length: 200 }, (_, index) => `const v${index + 1} = ${index + 1};`);
  lines[99] = "  throw new Error('dashboard not found');";
  const { excerpt, sites } = failureExcerpt(newFile('src/report.ts', lines));
  assert.equal(sites, 1);
  assert.match(excerpt, new RegExp(`^@@ -0,0 \\+${100 - FAILURE_WINDOW},${2 * FAILURE_WINDOW + 1} @@$`, 'm'),
    'the header gives the window\'s own head line numbers');
  assert.match(excerpt, /dashboard not found/);
  assert.doesNotMatch(excerpt, /const v1 = 1;|const v200 = 200;/, 'lines far from the throw are left out');
});

test('a change inside an existing catch counts, and a removed guard counts', () => {
  const inside = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -10,4 +10,5 @@ function run() {',
    '   } catch (error) {', '+    await markFailed(id);', '     log(error);', '   }', ' }'].join('\n') + '\n';
  assert.equal(failureExcerpt(inside).sites, 1);
  const removed = ['diff --git a/u.ts b/u.ts', '--- a/u.ts', '+++ b/u.ts', '@@ -1,3 +1,2 @@',
    ' export function update(owner, account) {', '-  if (owner !== account) throw new Error("forbidden");', '   return "updated";'].join('\n') + '\n';
  assert.equal(failureExcerpt(removed).sites, 1);
});

test('a change with no error handling, or only in tests, gets no excerpt', () => {
  const css = ['diff --git a/s.scss b/s.scss', '--- a/s.scss', '+++ b/s.scss', '@@ -1,2 +1,2 @@', ' .title {', '-  float: left;', '+  display: flex;'].join('\n') + '\n';
  assert.deepEqual(failureExcerpt(css), { excerpt: '', sites: 0 });
  assert.deepEqual(failureExcerpt(newFile('src/report.test.ts', ["expect(() => run()).toThrow(new Error('x'));"])), { excerpt: '', sites: 0 });
});
