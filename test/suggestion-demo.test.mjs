import test from 'node:test';
import assert from 'node:assert/strict';
import { renameAccount } from '../examples/suggestion-demo/accounts.mjs';

test('an owner can rename their account', () => {
  const accounts = new Map([['account-1', { ownerId: 'alice', displayName: 'Original' }]]);
  assert.equal(renameAccount(accounts, 'alice', 'account-1', 'Updated').displayName, 'Updated');
});

test('another user cannot rename the account or change its stored name', () => {
  const accounts = new Map([['account-1', { ownerId: 'alice', displayName: 'Original' }]]);
  assert.throws(() => renameAccount(accounts, 'bob', 'account-1', 'Changed by Bob'), /Forbidden/);
  assert.equal(accounts.get('account-1').displayName, 'Original');
});

test('a missing account fails without creating a record', () => {
  const accounts = new Map();
  assert.throws(() => renameAccount(accounts, 'alice', 'missing', 'New name'), /Account not found/);
  assert.equal(accounts.size, 0);
});
