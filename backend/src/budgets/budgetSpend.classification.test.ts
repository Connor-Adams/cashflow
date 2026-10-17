/**
 * Budget spend must use the dashboard headline's spend classification
 * (`isNonSpend` in summary/classifyTransactionFlow.ts): money movement —
 * the chequing-side leg of a card payment, transfers, brokerage flows, and
 * any negative row on an investment account — is not consumption.
 *
 * Before this, `loadBudgetSpend` never selected `txnType` or the account
 * type, so an overall budget summed every outflow: $3,000 of card purchases
 * plus the $3,000 card-payment leg plus a $1,000 transfer to savings read as
 * $7,000 spent. That number fed the dashboard budget tile, /budgets/status
 * and the breach-notification cron alike.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { sequelize } from '../db';
import * as models from '../models';
import { loadBudgetSpend, toBudgetSpendInput } from './budgetSpend';
import { loadCategoryTree } from '../categories/rollup';

const CURRENCY = 'CAD';
/** Mid-April 2026. The current monthly period is 2026-04-01..2026-04-30. */
const NOW = new Date(2026, 3, 15, 12, 0, 0);
const IN_PERIOD = '2026-04-10';

let householdId: number;
let cardId: number;
let chequingId: number;
let brokerageId: number;

async function makeAccount(name: string, accountType: string): Promise<number> {
  const account = await models.Account.create({
    householdId,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType,
    defaultCurrency: CURRENCY,
    shortCode: name.slice(0, 3).toUpperCase(),
  });
  return account.id;
}

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const hh = await models.Household.create({ name: 'Budget classification' });
  householdId = hh.id;
  cardId = await makeAccount('Visa', 'credit');
  chequingId = await makeAccount('Chequing', 'chequing');
  brokerageId = await makeAccount('Brokerage', 'investment');
});

async function txn(
  accountId: number,
  amount: number,
  txnType: string | null,
  category: string | null = null,
): Promise<void> {
  await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'classification-test',
    date: IN_PERIOD,
    merchantRaw: 'Somewhere',
    merchantClean: 'Somewhere',
    amount: amount.toFixed(4),
    currency: CURRENCY,
    txnType,
    linkedTransactionId: null,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    autoBusiness: null,
    businessOverride: null,
  });
}

async function budget(category: string | null) {
  const row = await models.BudgetTarget.create({
    householdId,
    category,
    categoryId: null,
    currency: CURRENCY,
    amount: '10000.0000',
    period: 'monthly',
    scope: 'household',
    rolloverEnabled: false,
    excludeRefundedPurchases: false,
  });
  const reloaded = await models.BudgetTarget.findByPk(row.id);
  assert.ok(reloaded);
  return toBudgetSpendInput(reloaded);
}

test('loadBudgetSpend: an overall budget counts card purchases, not the payment leg or a savings transfer', async () => {
  await txn(cardId, -1000, 'purchase', 'Groceries');
  await txn(cardId, -2000, 'purchase', 'Dining');
  await txn(chequingId, -3000, 'payment');
  await txn(chequingId, -1000, 'transfer');

  const { progress } = await loadBudgetSpend({
    budget: await budget(null),
    tree: await loadCategoryTree(householdId),
    now: NOW,
  });

  assert.equal(progress.spent, 3000);
});

test('loadBudgetSpend: negative rows on an investment account never count as spend', async () => {
  await txn(cardId, -50, 'purchase', 'Shopping');
  await txn(brokerageId, -5000, 'purchase', 'Shopping');

  const { progress } = await loadBudgetSpend({
    budget: await budget('Shopping'),
    tree: await loadCategoryTree(householdId),
    now: NOW,
  });

  assert.equal(progress.spent, 50);
});

test('loadBudgetSpend: a category budget excludes a payment row filed in that category', async () => {
  await txn(chequingId, -120, 'purchase', 'Utilities');
  await txn(chequingId, -800, 'payment', 'Utilities');

  const { progress } = await loadBudgetSpend({
    budget: await budget('Utilities'),
    tree: await loadCategoryTree(householdId),
    now: NOW,
  });

  assert.equal(progress.spent, 120);
});
