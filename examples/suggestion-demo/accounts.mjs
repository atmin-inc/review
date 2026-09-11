// Isolated account-update example for the review suggestion demo.
// This module is not used by the reviewer or hosted service.
export function renameAccount(accounts, actorId, accountId, displayName) {
  const account = accounts.get(accountId);
  if (!account) throw new Error('Account not found');
  if (account.ownerId !== actorId) throw new Error('Forbidden');
  account.displayName = displayName;
  return account;
}
