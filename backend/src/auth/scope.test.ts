import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { isHouseholdOwner, isSuperadmin } from './scope';

// `currentAuth(req)` simply returns `req.auth`, so a plain object with the
// fields the helpers read is a sufficient fake — no Express/DB needed.
function fakeReq(globalRole: string, role: string): Request {
  return {
    auth: {
      user: { globalRole },
      household: { id: 1 },
      role,
    },
  } as unknown as Request;
}

test('isHouseholdOwner is true for an owner-role member', () => {
  assert.equal(isHouseholdOwner(fakeReq('user', 'owner')), true);
});

test('isHouseholdOwner is false for a member-role member (#816 gate)', () => {
  assert.equal(isHouseholdOwner(fakeReq('user', 'member')), false);
});

test('isHouseholdOwner is true for a superadmin regardless of household role', () => {
  assert.equal(isHouseholdOwner(fakeReq('superadmin', 'member')), true);
});

test('isSuperadmin reflects the global role', () => {
  assert.equal(isSuperadmin(fakeReq('superadmin', 'member')), true);
  assert.equal(isSuperadmin(fakeReq('user', 'owner')), false);
});
