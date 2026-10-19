/**
 * applyPatchBody keeps the sole-partner stamp on partner/shared splits. It
 * used to null ownershipContactId on every PATCH of a non-'contact' row, so a
 * category edit would silently wipe the partner stamp that lets settlements
 * net against the split.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { applyPatchBody } from './transactions';
import { sequelize, Contact, Household, Transaction } from '../models';

let householdId: number;
let partnerId: number;
let friendId: number;

before(async () => {
  await sequelize.sync({ force: true });
  const h = await Household.create({ name: 'Ownership' } as never);
  householdId = h.id;
  partnerId = (await Contact.create({ householdId, name: 'Sam', isPartner: true } as never)).id;
  friendId = (await Contact.create({ householdId, name: 'Friend', isPartner: false } as never)).id;
});

function fakeReq(): Request {
  return {
    auth: { user: { id: 1 }, household: { id: householdId }, role: 'owner' },
  } as unknown as Request;
}

function buildTxn(over: Record<string, unknown> = {}): InstanceType<typeof Transaction> {
  return Transaction.build({
    accountId: 1,
    householdId,
    importBatch: 'test',
    date: '2026-01-01',
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: '-100.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-own',
    sourceIdentityFingerprint: 'sif-own',
    ...over,
  } as never);
}

test('an unrelated edit keeps the partner stamp on a shared split', async () => {
  const txn = buildTxn({ ownershipType: 'shared', ownershipContactId: partnerId });
  await applyPatchBody(fakeReq(), txn, { notes: 'groceries' });
  assert.equal(txn.get('ownershipContactId'), partnerId);
});

test('switching to partner/shared stamps the sole partner', async () => {
  const txn = buildTxn({ ownershipType: 'me', ownershipContactId: null });
  await applyPatchBody(fakeReq(), txn, { ownershipType: 'partner' });
  assert.equal(txn.get('ownershipContactId'), partnerId);
});

test('switching from a contact to shared replaces the contact with the sole partner', async () => {
  const txn = buildTxn({ ownershipType: 'contact', ownershipContactId: friendId });
  await applyPatchBody(fakeReq(), txn, { ownershipType: 'shared', ownershipContactId: friendId });
  assert.equal(txn.get('ownershipContactId'), partnerId);
});

test('switching to me clears the contact', async () => {
  const txn = buildTxn({ ownershipType: 'shared', ownershipContactId: partnerId });
  await applyPatchBody(fakeReq(), txn, { ownershipType: 'me' });
  assert.equal(txn.get('ownershipContactId'), null);
});

test('contact ownership still requires and keeps the chosen contact', async () => {
  const txn = buildTxn({ ownershipType: 'me' });
  await applyPatchBody(fakeReq(), txn, { ownershipType: 'contact', ownershipContactId: friendId });
  assert.equal(txn.get('ownershipContactId'), friendId);
  await assert.rejects(
    () => applyPatchBody(fakeReq(), buildTxn(), { ownershipType: 'contact' }),
    (e: Error & { status?: number }) => e.status === 400,
  );
});
