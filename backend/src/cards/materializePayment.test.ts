import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Household, PlannedEvent, User } from '../models';
import { materializeCreditCardPayment } from './materializePayment';

let accountId: number;
let householdId: number;
let userId: number;

before(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: 'cardpay-test@example.com',
    displayName: 'CardPay Test',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  const hh = await Household.create({ name: 'CardPay HH' } as never);
  householdId = hh.id;
  const acct = await Account.create({
    householdId, name: 'Test Card', accountType: 'credit_card',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD',
    ownerUserId: userId, shortCode: 'CARD1',
  } as never);
  accountId = acct.id;
});

test('materialize creates a planned credit_card debt_payment', async () => {
  const ev = await materializeCreditCardPayment({
    accountId, accountName: 'Test Card', userId, householdId,
    amount: 1234.56, currency: 'CAD', expectedDate: '2026-06-11',
  });
  assert.equal(ev.type, 'debt_payment');
  assert.equal(ev.source, 'credit_card');
  assert.equal(ev.status, 'planned');
  assert.equal(ev.expectedDate, '2026-06-11');
  assert.equal(String(ev.amount), '1234.5600');
});

test('materialize is idempotent per card (replaces prior planned event)', async () => {
  await materializeCreditCardPayment({
    accountId, accountName: 'Test Card', userId, householdId,
    amount: 50, currency: 'CAD', expectedDate: '2026-07-11',
  });
  const planned = await PlannedEvent.findAll({
    where: { accountId, source: 'credit_card', status: 'planned' },
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].expectedDate, '2026-07-11');
});
