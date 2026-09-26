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

test('/admin, /usage and unknown paths', () => {
  assert.equal(parseRoute('/admin').view, 'admin');
  assert.equal(parseRoute('/admin/').view, 'admin');
  assert.equal(parseRoute('/usage?installation=99').view, 'usage');
  assert.equal(parseRoute('/usage?installation=99').installation, 99);
  assert.equal(parseRoute('/settings').view, 'not-found');
});

test('sign-in errors come only from the known codes', () => {
  for (const code of Object.keys(signinMessages)) assert.equal(parseRoute(`/?signin=${code}`).signin, code);
  assert.equal(parseRoute('/?signin=<script>').signin, null);
  assert.equal(parseRoute('/?signin=toString').signin, null);
});

test('routeHref round-trips every view', () => {
  for (const href of ['/', '/?installation=99', '/usage?installation=99', '/admin', '/?repository=42', '/?repository=42#review/abc-123']) {
    assert.equal(routeHref(parseRoute(href)), href);
  }
});

test('sign-in preserves the repository and review deep link', () => {
  assert.equal(signInHref(parseRoute('/?repository=42#review/abc-123')), '/auth/github?repository=42&review=abc-123');
  assert.equal(signInHref(parseRoute('/?repository=42')), '/auth/github?repository=42');
  assert.equal(signInHref(parseRoute('/')), '/auth/github');
  assert.equal(signInHref(parseRoute('/admin')), '/auth/github');
});
