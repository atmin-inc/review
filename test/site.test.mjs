import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { site } from '../dist/github/site.js';

async function serve(t, build = true) {
  const root = mkdtempSync(join(tmpdir(), 'review-site-')), web = join(root, 'dist');
  writeFileSync(join(root, 'secret.txt'), 'outside the build');
  if (build) {
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>atmin</title>');
    writeFileSync(join(web, 'assets', 'app-1a2b.js'), 'console.log(1)');
    writeFileSync(join(web, 'assets', 'notes.txt'), 'not a served type');
  }
  const handler = site(web);
  const server = createServer((req, res) => { if (!handler(req, res)) { res.writeHead(418); res.end(); } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); });
  return (path, method = 'GET') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, redirect: 'manual' });
}

test('the dashboard build is served with client routing, and API, auth, webhook and health paths pass through', async t => {
  const get = await serve(t);
  // Links already posted in PR comments open the page, which routes to the review.
  for (const path of ['/', '/?repository=42', '/admin', '/repositories/42']) {
    const response = await get(path);
    assert.equal(response.status, 200); assert.equal(await response.text(), '<!doctype html><title>atmin</title>');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self';/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
  const asset = await get('/assets/app-1a2b.js');
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  // Only files in the build are served; nothing else on disk is reachable by path.
  for (const path of ['/assets/missing.js', '/assets/notes.txt', '/../secret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt']) {
    const response = await get(path);
    assert.notEqual(await response.text(), 'outside the build');
  }
  assert.equal((await get('/assets/missing.js')).status, 404);
  for (const path of ['/api/review/v1/session', '/auth/github', '/webhooks/github', '/healthz']) assert.equal((await get(path)).status, 418);
  assert.equal((await get('/', 'POST')).status, 418);
  assert.equal(await (await get('/', 'HEAD')).text(), '');
});

test('a server without a built dashboard says so on every page instead of failing silently', async t => {
  const get = await serve(t, false);
  const response = await get('/admin');
  assert.equal(response.status, 503); assert.match(await response.text(), /dashboard is not built/);
  assert.equal((await get('/healthz')).status, 418);
});
