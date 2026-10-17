/**
 * The gate's cost, measured rather than assumed.
 *
 * The design flagged this explicitly: the report needs per-account import coverage,
 * orphaned-activity detection, duplicate detection across the year and carryforward
 * state, on a route whose cache exists because it was already slow — and
 * `buildPersonalFacts` runs unconditionally there, so the cache only ever saved
 * `buildT1`. "The implementation plan must state a latency budget and bound the
 * duplicate scan to the period, or the gate makes the tab worse."
 *
 * The scan IS bounded to the period. This asserts the budget, at a volume above
 * prod's: prod holds ~5,400 transactions in total, and this seeds 2,000 in one year
 * on one entity.
 *
 * The threshold is deliberately loose — CI machines vary and a tight bound would
 * flake. It is a guard against an order-of-magnitude regression (an N+1 introduced
 * into a detector, or the duplicate scan losing its period bound), not a benchmark.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Account, Carryforward, Entity, Household, TaxSlip, Transaction } from '../../models';
import { D } from '../util/decimal';
import { ratesFor } from '../engine/brackets';
import { buildCompletenessReport } from './buildCompletenessReport';
import type { TaxYearFacts } from '../engine/types';

const BUDGET_MS = 4000;
const ROWS = 2000;

let personalId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const household = await Household.create({ name: 'Volume HH' });
  const personal = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  personalId = personal.id;
  await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'CDG Inc.',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const account = await Account.create({
    name: 'Chq', householdId: household.id, accountType: 'checking',
    entityId: personalId, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Carryforward.create({
    entityId: personalId, kind: 'rrsp_room', asOfYear: 2026, amount: '1', notes: null,
  } as never);
  await TaxSlip.create({
    entityId: personalId, year: 2026, slipType: 'T5', issuer: 'X', boxValues: {},
  } as never);

  await Transaction.bulkCreate(
    Array.from({ length: ROWS }, (_, i) => ({
      accountId: account.id,
      householdId: household.id,
      entityId: personalId,
      // Spread across the year so the month-coverage and duplicate grouping both do
      // real work rather than collapsing to one bucket.
      date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      amount: String(-(i % 500) - 1),
      currency: 'CAD',
      merchantRaw: `M${i}`,
      merchantClean: `M${i}`,
      importBatch: 'b',
      sourceRowFingerprint: `fp${i}`,
      sourceIdentityFingerprint: `sif${i}`,
    })) as never,
  );
});

function facts(): TaxYearFacts {
  return {
    year: 2026, jurisdiction: 'CA-ON',
    employmentIncome: [], selfEmploymentIncome: [], selfEmploymentExpenses: [],
    interestIncome: [], eligibleDividends: [], nonEligibleDividends: [],
    capitalGainEvents: [], rrspContribs: [], fhsaContribs: [], donations: [],
    rentalIncome: [], rentalExpenses: [], medicalExpenses: [], slips: [],
    carryforwards: {
      netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'),
      instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0'), fhsaRoom: D('0'),
    },
    ageAtYearEnd: 40,
  } as TaxYearFacts;
}

test(`the report completes within ${BUDGET_MS}ms over ${ROWS} transactions`, async () => {
  const started = Date.now();
  const report = await buildCompletenessReport({
    entityId: personalId, year: 2026, facts: facts(), rates: ratesFor(2026),
    now: new Date('2026-12-31T00:00:00Z'),
  });
  const elapsed = Date.now() - started;
  assert.ok(report.status !== undefined);
  assert.ok(
    elapsed < BUDGET_MS,
    `buildCompletenessReport took ${elapsed}ms over ${ROWS} rows, budget ${BUDGET_MS}ms. `
    + 'Most likely an N+1 in a detector or the duplicate scan losing its period bound.',
  );
  console.log(`# buildCompletenessReport: ${elapsed}ms over ${ROWS} transactions`);
});

test('the query count does not scale with the row count', async () => {
  // The guard that actually matters. A detector doing a lookup per row passes a
  // wall-clock budget on a fast machine and destroys the tab on a slow one.
  let queries = 0;
  const original = sequelize.options.logging;
  sequelize.options.logging = () => { queries += 1; };
  try {
    await buildCompletenessReport({
      entityId: personalId, year: 2026, facts: facts(), rates: ratesFor(2026),
      now: new Date('2026-12-31T00:00:00Z'),
    });
  } finally {
    sequelize.options.logging = original;
  }
  console.log(`# buildCompletenessReport: ${queries} queries over ${ROWS} transactions`);
  assert.ok(
    queries < 60,
    `${queries} queries for one report over ${ROWS} rows — that is per-row, not per-report.`,
  );
});
