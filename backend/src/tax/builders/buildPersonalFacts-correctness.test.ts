/**
 * Correctness fixes in how buildPersonalFacts reads transactions and slips:
 *
 *   - a business cost the owner paid personally belongs to the corporation when
 *     the household has exactly one — buildCorpFacts deducts it there, so the
 *     T1 must not deduct it again as a self-employment expense;
 *   - charges are negative in this app, so a donation is credited at abs(cad);
 *   - self-employment expenses honour deductible_percent and my share, and
 *     refunds net against the expense instead of inflating it (or, for a
 *     business refund, counting as revenue);
 *   - pension slips win over pension transactions (no double count);
 *   - a slip box keyed "1,200.50" parses;
 *   - a missing FX rate degrades to a warning instead of failing the return;
 *   - age comes from the person who owns the entity's accounts, not whichever
 *     household member the database returns first.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import {
  Account, Entity, Household, HouseholdMember, TaxSlip, Transaction, TransactionTaxMetadata, User,
} from '../../models';
import { D } from '../util/decimal';
import { buildPersonalFacts } from './buildPersonalFacts';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

let fp = 0;
async function seed() {
  const household = await Household.create({ name: 'Correctness' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  const txn = (over: Record<string, unknown>) => {
    fp += 1;
    return Transaction.create({
      accountId: account.id, householdId: household.id, entityId: entity.id,
      date: '2026-03-01', currency: 'CAD', merchantRaw: 'M', merchantClean: 'M',
      importBatch: 'correctness', sourceRowFingerprint: `fp-corr-${fp}`,
      sourceIdentityFingerprint: `sif-corr-${fp}`,
      ...over,
    } as never);
  };
  return { household, entity, account, txn };
}

const sum = (items: { cadAmount: ReturnType<typeof D> }[]) =>
  items.reduce((s, i) => s.plus(i.cadAmount), D('0')).toFixed(2);

test('with one corporation, an owner-paid business expense is not also an SE expense', async () => {
  const ctx = await seed();
  await Entity.create({
    householdId: ctx.household.id, kind: 'corp', legalName: 'Co', jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  } as never);
  await ctx.txn({ amount: '-120.0000', autoBusiness: true, finalBusiness: true, txnType: 'purchase' });

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(facts.selfEmploymentExpenses.length, 0, 'the T2 deducts it; the T1 must not');
});

test('a donation charge (negative) is credited as a positive amount', async () => {
  const ctx = await seed();
  await ctx.txn({ amount: '-500.0000', taxTreatmentOverride: 'donations' });

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(sum(facts.donations), '500.00');
});

test('SE expenses apply deductible_percent and my share of a split', async () => {
  const ctx = await seed();
  const meal = await ctx.txn({ amount: '-200.0000', autoBusiness: true, finalBusiness: true, txnType: 'purchase' });
  await TransactionTaxMetadata.create({ transactionId: meal.id, deductiblePercent: '0.5' } as never);
  // Half of this one is the partner's.
  await ctx.txn({
    amount: '-100.0000', autoBusiness: true, finalBusiness: true, txnType: 'purchase',
    finalSplitType: 'shared', finalPctMe: '0.5', finalPctPartner: '0.5',
    myShareAmount: '-50.0000', partnerShareAmount: '-50.0000', businessAmount: '-100.0000',
  });

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(sum(facts.selfEmploymentExpenses), '150.00', '200 × 50% + 100 × my 50% share');
});

test('a business refund nets against SE expenses instead of counting as revenue', async () => {
  const ctx = await seed();
  await ctx.txn({ amount: '-300.0000', autoBusiness: true, finalBusiness: true, txnType: 'purchase' });
  await ctx.txn({ amount: '80.0000', autoBusiness: true, finalBusiness: true, txnType: 'refund' });

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(facts.selfEmploymentIncome.length, 0, 'a refund is not revenue');
  assert.equal(sum(facts.selfEmploymentExpenses), '220.00');
});

test('medical and rental refunds reduce the expense rather than adding to it', async () => {
  const ctx = await seed();
  await ctx.txn({ amount: '-400.0000', taxTreatmentOverride: 'medical_expense' });
  await ctx.txn({ amount: '150.0000', taxTreatmentOverride: 'medical_expense' });
  await ctx.txn({ amount: '-1000.0000', taxTreatmentOverride: 'rental_expense' });
  await ctx.txn({ amount: '200.0000', taxTreatmentOverride: 'rental_expense' });

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(sum(facts.medicalExpenses), '250.00');
  assert.equal(sum(facts.rentalExpenses), '800.00');
});

test('pension slips win over pension transactions — no double count', async () => {
  const ctx = await seed();
  await ctx.txn({ amount: '1500.0000', taxTreatmentOverride: 'pension_income' });
  await TaxSlip.create({
    entityId: ctx.entity.id, year: 2026, slipType: 'T4A', issuer: 'Plan',
    boxValues: { box016: 1500 },
  } as never);

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(facts.pensionIncome?.toFixed(2), '1500.00');
});

test('pension transactions still count when there is no pension slip', async () => {
  const ctx = await seed();
  await ctx.txn({ amount: '1500.0000', taxTreatmentOverride: 'pension_income' });

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(facts.pensionIncome?.toFixed(2), '1500.00');
});

test('slip boxes with thousands separators parse', async () => {
  const ctx = await seed();
  await TaxSlip.create({
    entityId: ctx.entity.id, year: 2026, slipType: 'T4', issuer: 'Employer',
    boxValues: { box14: '61,200.50', box22: '$9,000' },
  } as never);
  await TaxSlip.create({
    entityId: ctx.entity.id, year: 2026, slipType: 'T4A', issuer: 'Plan',
    boxValues: { box016: '1,200.50' },
  } as never);

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  const t4 = facts.slips.find((s) => s.slipType === 'T4');
  assert.equal(t4?.boxes['box14'].toFixed(2), '61200.50');
  assert.equal(t4?.boxes['box22'].toFixed(2), '9000.00');
  assert.equal(facts.pensionIncome?.toFixed(2), '1200.50');
});

test('a missing FX rate becomes a warning, not a failed return', async () => {
  const ctx = await seed();
  await ctx.txn({ amount: '-50.0000', currency: 'XTS', taxTreatmentOverride: 'donations' });
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  try {
    const facts = await buildPersonalFacts(ctx.entity.id, 2026);
    assert.equal(sum(facts.donations), '50.00', 'unconverted amount used');
    assert.ok(
      (facts.factWarnings ?? []).some((w) => w.includes('XTS')),
      `expected an FX warning, got ${JSON.stringify(facts.factWarnings)}`,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test('age is read from the user who owns the entity, not an arbitrary member', async () => {
  const ctx = await seed();
  const mk = (email: string, dob: string) => User.create({
    email, displayName: email, passwordHash: 'x', passwordSalt: 'x', passwordParams: 'x', dob,
  } as never);
  const partner = await mk('partner@example.test', '1950-01-01');
  const owner = await mk('owner@example.test', '1990-06-15');
  // The partner joined first, so an unordered findOne tends to return them.
  await HouseholdMember.create({ householdId: ctx.household.id, userId: partner.id, role: 'member' } as never);
  await HouseholdMember.create({ householdId: ctx.household.id, userId: owner.id, role: 'owner' } as never);
  await ctx.account.update({ ownerUserId: owner.id } as never);

  const facts = await buildPersonalFacts(ctx.entity.id, 2026);
  assert.equal(facts.ageAtYearEnd, 36);
});
