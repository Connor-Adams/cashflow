import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

let pendingTotal: typeof import('../src/transactions/status.js').pendingTotal;
let models: typeof import('../src/models/index.js');

before(async () => {
  models = await import('../src/models/index.js');
  await models.sequelize.sync({ force: true });
  pendingTotal = (await import('../src/transactions/status.js')).pendingTotal;
});

after(async () => {
  await models.sequelize.close();
});

test('pendingTotal sums only pending rows up to asOf for the requested account', async () => {
  const account = await models.Account.create({
    name: 'Pending Helper',
    owner: 'me',
    householdId: 7,
    ownerUserId: 11,
  });
  const otherAccount = await models.Account.create({
    name: 'Other Pending Helper',
    owner: 'me',
    householdId: 7,
    ownerUserId: 11,
  });
  const base = {
    householdId: 7,
    createdByUserId: 11,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'pending-helper',
    merchantRaw: 'Pending Helper',
    merchantClean: 'Pending Helper',
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    finalSplitType: 'me',
    finalBusiness: false,
    myShareAmount: '0',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    isRecurring: false,
    reviewFlag: false,
  };
  await models.Transaction.bulkCreate([
    { ...base, accountId: account.id, date: '2026-05-01', amount: '-10.2500', status: 'pending' },
    { ...base, accountId: account.id, date: '2026-05-02', amount: '-4.7500', status: 'pending' },
    { ...base, accountId: account.id, date: '2026-05-03', amount: '-99.0000', status: 'posted' },
    { ...base, accountId: account.id, date: '2026-06-01', amount: '-20.0000', status: 'pending' },
    { ...base, accountId: otherAccount.id, date: '2026-05-01', amount: '-50.0000', status: 'pending' },
  ]);

  assert.deepEqual(
    await pendingTotal({ accountId: account.id, asOf: '2026-05-31', householdId: 7 }),
    { total: -15, count: 2 },
  );
});
