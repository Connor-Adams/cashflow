import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Household, User, LiabilityAccount, PlannedEvent } from '../models';
import type { PdfStatementHeader } from '../import/pdf/types';
import { applyCreditCardStatementSummary } from './applyStatementSummary';

let householdId: number;
let userId: number;

before(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: 'applystatement-test@example.com',
    displayName: 'ApplyStatement Test',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  const hh = await Household.create({ name: 'ApplyStatement HH' } as never);
  householdId = hh.id;
});

function baseHeader(over: Partial<PdfStatementHeader> = {}): PdfStatementHeader {
  return {
    accountSuffix: '3338',
    productLabel: 'Wealthsimple Credit Card',
    accountType: 'credit_card',
    periodStart: '2026-04-15',
    periodEnd: '2026-05-14',
    statementBalance: 1234.56,
    paymentDueDate: '2026-06-11',
    minimumPayment: 10,
    ...over,
  };
}

async function makeCard(shortCode: string) {
  return Account.create({
    householdId, name: 'WS Card', accountType: 'credit_card',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD',
    ownerUserId: userId, shortCode,
  } as never);
}

test('persists summary fields and auto-places the calendar payment', async () => {
  const account = await makeCard('CC-A');
  await applyCreditCardStatementSummary({ account, header: baseHeader(), userId, householdId });

  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(Number(liab!.statementBalance), 1234.56);
  assert.equal(Number(liab!.minimumPayment), 10);
  assert.equal(liab!.dueDay, 11);
  assert.equal(liab!.statementDate, '2026-05-14');

  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card', status: 'planned' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].expectedDate, '2026-06-11');
  assert.equal(Number(events[0].amount), 1234.56);
});

test('no due date → fields persisted but no calendar payment (guard)', async () => {
  const account = await makeCard('CC-B');
  await applyCreditCardStatementSummary({
    account, header: baseHeader({ paymentDueDate: null }), userId, householdId,
  });
  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(Number(liab!.statementBalance), 1234.56);
  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card' },
  });
  assert.equal(events.length, 0);
});

test('re-import of the same statement keeps exactly one planned payment', async () => {
  const account = await makeCard('CC-C');
  await applyCreditCardStatementSummary({ account, header: baseHeader(), userId, householdId });
  await applyCreditCardStatementSummary({ account, header: baseHeader(), userId, householdId });
  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card', status: 'planned' },
  });
  assert.equal(events.length, 1);
});

test('a strictly-older statement is a no-op (newer-wins)', async () => {
  const account = await makeCard('CC-D');
  // Newer statement first.
  await applyCreditCardStatementSummary({
    account,
    header: baseHeader({ periodEnd: '2026-05-14', statementBalance: 999, paymentDueDate: '2026-06-11' }),
    userId, householdId,
  });
  // Older statement second — must not clobber.
  await applyCreditCardStatementSummary({
    account,
    header: baseHeader({ periodEnd: '2026-04-14', statementBalance: 111, paymentDueDate: '2026-05-11' }),
    userId, householdId,
  });
  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(Number(liab!.statementBalance), 999);
  assert.equal(liab!.statementDate, '2026-05-14');
  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card', status: 'planned' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].expectedDate, '2026-06-11');
});

test('non-credit_card account is ignored', async () => {
  const account = await Account.create({
    householdId, name: 'Chequing', accountType: 'checking',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD',
    ownerUserId: userId, shortCode: 'CHQ-1',
  } as never);
  await applyCreditCardStatementSummary({
    account, header: baseHeader({ accountType: 'checking' }), userId, householdId,
  });
  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(liab, null);
});
