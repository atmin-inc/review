import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHref, signInHref, signinMessages } from '../src/route.js';

test('review deep links posted in PR comments open that repository and review', () => {
  for (const href of ['/?repository=42#review/abc-123', 'https://review.atmin.ai/?repository=42#review/abc-123']) {
    const route = parseRoute(href);
    assert.equal(route.view, 'repository');
    assert.equal(route.repository, 42);
    assert.equal(route.review, 'abc-123');
  }
  const uuid = '0f8c2a5e-6b1d-4c3e-9a7f-2d4b6c8e0a1b';
  assert.equal(parseRoute(`/?repository=9007199254740991#review/${uuid}`).review, uuid);
});

test('repository links open the repository without a review', () => {
  assert.deepEqual(parseRoute('/?repository=42'), { signin: null, installation: null, view: 'repository', repository: 42, review: null });
  assert.equal(parseRoute('/?repository=42#review/').review, null);
  assert.equal(parseRoute('/?repository=42#review/../../etc').review, null);
});

test('malformed or repeated repository parameters fall back to the repository list', () => {
  for (const href of ['/?repository=abc', '/?repository=0', '/?repository=42&repository=43', '/?repository=-1', '/?repository=']) {
    assert.equal(parseRoute(href).view, 'repositories', href);
  }
});

test('/admin, /usage, /billing and unknown paths', () => {
  assert.equal(parseRoute('/admin').view, 'admin');
  assert.equal(parseRoute('/admin/').view, 'admin');
  assert.equal(parseRoute('/usage?installation=99').view, 'usage');
  assert.equal(parseRoute('/usage?installation=99').installation, 99);
  assert.equal(parseRoute('/billing?installation=99').view, 'billing');
  // Only a Stripe Checkout session ID, given once, is confirmed on return from Checkout, and
  // Checkout returns to Billing.
  assert.equal(parseRoute('/billing?installation=99&checkout=cs_test_a1B2').checkout, 'cs_test_a1B2');
  assert.equal(parseRoute('/usage?installation=99&checkout=cs_test_a1B2').checkout, undefined);
  for (const bad of ['cs_other_a1', 'cs_test_', 'cs_test_a1&checkout=cs_test_b2', 'cs_test_a1%2F..']) {
    assert.equal(parseRoute(`/billing?installation=99&checkout=${bad}`).checkout, null, bad);
  }
  assert.equal(parseRoute('/settings').view, 'not-found');
  // Docs are public pages; the self-host guide is where "run it yourself" links point.
  assert.equal(parseRoute('/docs').view, 'docs');
  assert.equal(parseRoute('/docs/self-host').page, 'self-host');
  assert.equal(parseRoute('/docs/../admin').view, 'admin');
  assert.equal(parseRoute('/docs/a/b').view, 'not-found');
});

test('sign-in errors come only from the known codes', () => {
  for (const code of Object.keys(signinMessages)) assert.equal(parseRoute(`/?signin=${code}`).signin, code);
  assert.equal(parseRoute('/?signin=<script>').signin, null);
  assert.equal(parseRoute('/?signin=toString').signin, null);
});

test('routeHref round-trips every view', () => {
  for (const href of ['/', '/?installation=99', '/usage?installation=99', '/billing?installation=99', '/admin', '/docs', '/docs/self-host', '/?repository=42', '/?repository=42#review/abc-123']) {
    assert.equal(routeHref(parseRoute(href)), href);
  }
});

test('sign-in preserves the repository and review deep link', () => {
  assert.equal(signInHref(parseRoute('/?repository=42#review/abc-123')), '/auth/github?repository=42&review=abc-123');
  assert.equal(signInHref(parseRoute('/?repository=42')), '/auth/github?repository=42');
  assert.equal(signInHref(parseRoute('/')), '/auth/github');
  assert.equal(signInHref(parseRoute('/admin')), '/auth/github');
});

// Terms and privacy must open without signing in; Stripe, GitHub and the footer link to them.
test('terms and privacy are their own public pages', () => {
  assert.equal(parseRoute('/terms').view, 'terms');
  assert.equal(parseRoute('/privacy/').view, 'privacy');
  assert.equal(routeHref({ view: 'terms' }), '/terms');
  assert.equal(routeHref({ view: 'privacy' }), '/privacy');
});

test('every self-host link opens an existing docs page', async () => {
  const { selfHostUrl } = await import('../src/route.js');
  const route = parseRoute(selfHostUrl);
  assert.equal(route.view, 'docs');
  const source = (await import('node:fs')).readFileSync(new URL('../src/docs.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes(`['${route.page}', `), `no docs page ${route.page}`);
});
