import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { D } from '../../src/tax/util/decimal';
import { RATES_2025 } from '../../src/tax/data/rates-2025';
import type { TaxReturn, TaxYearFacts } from '../../src/tax/engine/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-tax-roll-cf.sqlite');

// Set isolated DB path before any models are imported
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

// Lazy imports — after DATABASE_PATH is set
let Carryforward: typeof import('../../src/models').Carryforward;
let Entity: typeof import('../../src/models').Entity;
let Household: typeof import('../../src/models').Household;
let sequelize: import('../../src/models').sequelize;
let rollPersonalCarryforwards: typeof import('../../src/tax/services/rollPersonalCarryforwards').rollPersonalCarryforwards;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const models = await import('../../src/models/index.js');
  Carryforward = models.Carryforward;
  Entity = models.Entity;
  Household = models.Household;
  sequelize = models.sequelize;
  const rollModule = await import('../../src/tax/services/rollPersonalCarryforwards.js');
  rollPersonalCarryforwards = rollModule.rollPersonalCarryforwards;

  await sequelize.sync({ force: true });
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

/** Build a minimal TaxReturn shell — roll service doesn't use it in Phase 4 PR 1. */
function makeRet(): TaxReturn {
  const zero = D('0');
  return {
    year: 2025,
    lines: [],
    totals: {
      totalIncome: zero,
      netIncome: zero,
      taxableIncome: zero,
      federalTax: zero,
      provincialTax: zero,
      cppContrib: zero,
      eiPremium: zero,
      totalPayable: zero,
      refundOrOwing: zero,
    },
    warnings: [],
  };
}

/** Build a base TaxYearFacts for testing. */
function makeFacts(overrides: Partial<TaxYearFacts> = {}): TaxYearFacts {
  return {
    year: 2025,
    jurisdiction: 'CA-ON',
    employmentIncome: [],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    slips: [],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
    },
    ageAtYearEnd: 40,
    ...overrides,
  };
}

test('roll basic case: no income, no gains — preserves zero balances and writes 4 rows', async () => {
  const household = await Household.create({ name: 'Roll test basic' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll Basic',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts();
  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  assert.equal(result.written.length, 4);

  const kinds = result.written.map(w => w.kind);
  assert.ok(kinds.includes('cap_loss'));
  assert.ok(kinds.includes('non_cap_loss'));
  assert.ok(kinds.includes('rrsp_room'));
  assert.ok(kinds.includes('fhsa_room'));

  // All balances should be zero with no income (except fhsa_room)
  for (const w of result.written) {
    if (w.kind !== 'fhsa_room') {
      assert.equal(w.amount.toFixed(2), '0.00', `expected zero for ${w.kind}`);
    }
  }

  // FHSA room should equal annual limit (8000 default when fhsaAnnualLimit not on rate)
  const fhsaRow = result.written.find(w => w.kind === 'fhsa_room');
  assert.ok(fhsaRow);
  assert.equal(fhsaRow.amount.toFixed(2), '8000.00');

  // Verify rows were upserted to DB
  const dbRows = await Carryforward.findAll({ where: { entityId: entity.id, asOfYear: 2025 } });
  assert.equal(dbRows.length, 4);
});

test('roll loss year: capital loss event adds to carry', async () => {
  const household = await Household.create({ name: 'Roll test loss' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll Loss',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    capitalGainEvents: [
      {
        source: 'sell XYZ',
        securityId: 1,
        proceeds: D('5000'),
        acb: D('8000'),  // loss of $3000 gross → includable = -1500 at 0.5
        outlays: D('0'),
        date: '2025-06-15',
      },
    ],
    carryforwards: {
      netCapitalLoss: D('500'), // pre-existing $500 carry
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  const capLossRow = result.written.find(w => w.kind === 'cap_loss');
  assert.ok(capLossRow);
  // gross loss = -3000, includable = -3000 * 0.5 = -1500 (negative → adds to carry)
  // prior carry = 500 + 1500 = 2000
  assert.equal(capLossRow.amount.toFixed(2), '2000.00');
});

test('roll gain year: cap gain reduces carry', async () => {
  const household = await Household.create({ name: 'Roll test gain' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll Gain',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    capitalGainEvents: [
      {
        source: 'sell ABC',
        securityId: 2,
        proceeds: D('10000'),
        acb: D('6000'),  // gain of $4000 gross → includable = 2000 at 0.5
        outlays: D('0'),
        date: '2025-09-01',
      },
    ],
    carryforwards: {
      netCapitalLoss: D('1000'), // prior carry = 1000, gain reduces it
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  const capLossRow = result.written.find(w => w.kind === 'cap_loss');
  assert.ok(capLossRow);
  // includable gain = 2000; prior carry = 1000; result = maxZero(1000 - 2000) = 0
  assert.equal(capLossRow.amount.toFixed(2), '0.00');
});

test('roll RRSP room earned: employment income generates room', async () => {
  const household = await Household.create({ name: 'Roll test RRSP' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll RRSP',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    employmentIncome: [
      { source: 'T4', amount: D('100000'), cadAmount: D('100000') },
    ],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('5000'), // prior room
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  const rrspRow = result.written.find(w => w.kind === 'rrsp_room');
  assert.ok(rrspRow);
  // new room = min(100000 * 0.18, 32490) = min(18000, 32490) = 18000
  // total = 5000 + 18000 = 23000
  assert.equal(rrspRow.amount.toFixed(2), '23000.00');
});

test('roll RRSP room: capped at rrspAnnualLimit', async () => {
  const household = await Household.create({ name: 'Roll test RRSP cap' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll RRSP Cap',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    employmentIncome: [
      { source: 'T4 big', amount: D('500000'), cadAmount: D('500000') },
    ],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  const rrspRow = result.written.find(w => w.kind === 'rrsp_room');
  assert.ok(rrspRow);
  // new room = min(500000 * 0.18, 32490) = 32490
  assert.equal(rrspRow.amount.toFixed(2), '32490.00');
});

test('roll upsert: calling twice with different facts updates DB row', async () => {
  const household = await Household.create({ name: 'Roll test upsert' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll Upsert',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  // First roll: no income
  await rollPersonalCarryforwards(entity.id, 2025, makeRet(), makeFacts(), RATES_2025);

  // Second roll: with income
  const facts2 = makeFacts({
    employmentIncome: [{ source: 'T4', amount: D('50000'), cadAmount: D('50000') }],
  });
  await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts2, RATES_2025);

  const rows = await Carryforward.findAll({ where: { entityId: entity.id, asOfYear: 2025, kind: 'rrsp_room' } });
  assert.equal(rows.length, 1, 'upsert should keep only 1 row per kind+year');
  // 50000 * 0.18 = 9000, capped fine; rrsp_room = 9000
  assert.equal(Number(rows[0].amount).toFixed(2), '9000.00');
});
