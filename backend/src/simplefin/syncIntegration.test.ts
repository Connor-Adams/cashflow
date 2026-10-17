process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Account,
  Household,
  HouseholdMember,
  SimplefinAccountLink,
  Transaction,
  User,
  UserSimplefinIntegration,
  sequelize,
} from '../models';
import { encryptSecret } from '../util/symmetricEncryption';
import { syncIntegration } from './sync';

// A linked account that is ABSENT from the SimpleFIN payload is the classic
// "bank needs re-auth" shape: SimpleFIN quietly stops listing it. The sync used
// to skip it and still advance `lastSyncedAt` because another account resolved,
// so the next window opened after the outage and the gap was permanent.

const ACCESS_URL = 'https://u53r:p4ss@beta-bridge.simplefin.org/simplefin';
const NOW = new Date('2026-10-17T02:00:00Z');
const PRIOR_SYNC = new Date('2026-10-10T02:00:00Z');
const POSTED = Math.floor(new Date('2026-10-15T12:00:00Z').getTime() / 1000);
const FRESH_BALANCE = Math.floor(new Date('2026-10-16T12:00:00Z').getTime() / 1000);

let userId: number;
let householdId: number;
let originalFetch: typeof globalThis.fetch;
let payload: unknown;

before(async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'SimpleFIN cursor' } as never);
  householdId = hh.id;
  const user = await User.create({
    email: 'sf-cursor@test.local',
    displayName: 'SF Cursor',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  await HouseholdMember.create({ householdId, userId, role: 'owner' } as never);
});

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/accounts')) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Transaction.destroy({ where: {} });
  await SimplefinAccountLink.destroy({ where: {} });
  await UserSimplefinIntegration.destroy({ where: {} });
  await Account.destroy({ where: {} });
});

async function seedTwoLinkedAccounts() {
  const integration = await UserSimplefinIntegration.create({
    userId,
    accessUrlEncrypted: encryptSecret(ACCESS_URL),
    status: 'connected',
    statusReason: null,
    lastSyncedAt: PRIOR_SYNC,
  } as never);
  const mk = (name: string) =>
    Account.create({
      householdId,
      ownerUserId: null,
      owner: 'me',
      visibility: 'shared',
      name,
      accountType: 'credit',
      defaultCurrency: 'CAD',
    } as never);
  const amex = await mk('Amex Cobalt');
  const cibc = await mk('CIBC Visa');
  await SimplefinAccountLink.create({
    integrationId: integration.id,
    simplefinAccountId: 'ACT-AMEX',
    accountId: amex.id,
  } as never);
  await SimplefinAccountLink.create({
    integrationId: integration.id,
    simplefinAccountId: 'ACT-CIBC',
    accountId: cibc.id,
  } as never);
  return { integration, amex, cibc };
}

function remote(id: string, txId: string) {
  return {
    id,
    name: id,
    currency: 'CAD',
    'balance-date': FRESH_BALANCE,
    transactions: [
      { id: txId, posted: POSTED, amount: '-12.34', description: 'COFFEE', payee: 'Coffee' },
    ],
  };
}

test('a linked account missing from the payload holds lastSyncedAt and flags the integration', async () => {
  const { integration, amex, cibc } = await seedTwoLinkedAccounts();
  // CIBC needs re-auth: SimpleFIN omits it entirely, and reports no error.
  payload = { errors: [], accounts: [remote('ACT-AMEX', 'TRN-1')] };

  const result = await syncIntegration(integration, NOW);

  // The healthy account still imports.
  assert.equal(await Transaction.count({ where: { accountId: amex.id } }), 1);

  await integration.reload();
  assert.equal(integration.status, 'error');
  assert.equal(
    integration.lastSyncedAt?.toISOString(),
    PRIOR_SYNC.toISOString(),
    'cursor must not advance past the missing account',
  );
  assert.match(integration.statusReason ?? '', /CIBC Visa/);

  const missingRun = result.runs.find((r) => r.accountId === cibc.id);
  assert.ok(missingRun, 'the missing account appears as a run so the job degrades');
  assert.equal(missingRun.status, 'error');
});

test('every linked account present and healthy advances lastSyncedAt', async () => {
  const { integration } = await seedTwoLinkedAccounts();
  payload = {
    errors: [],
    accounts: [remote('ACT-AMEX', 'TRN-1'), remote('ACT-CIBC', 'TRN-2')],
  };

  const result = await syncIntegration(integration, NOW);

  await integration.reload();
  assert.equal(integration.status, 'connected');
  assert.equal(integration.statusReason, null);
  assert.equal(integration.lastSyncedAt?.toISOString(), NOW.toISOString());
  assert.ok(result.runs.every((r) => r.status === 'connected'));
});

test('payload errors[] hold lastSyncedAt and reach statusReason', async () => {
  const { integration } = await seedTwoLinkedAccounts();
  payload = {
    errors: ['CIBC: Auth required'],
    accounts: [remote('ACT-AMEX', 'TRN-1'), remote('ACT-CIBC', 'TRN-2')],
  };

  const result = await syncIntegration(integration, NOW);

  await integration.reload();
  assert.equal(integration.status, 'error');
  assert.equal(integration.lastSyncedAt?.toISOString(), PRIOR_SYNC.toISOString());
  assert.match(integration.statusReason ?? '', /CIBC: Auth required/);
  assert.deepEqual(result.institutionErrors, ['CIBC: Auth required']);
});
