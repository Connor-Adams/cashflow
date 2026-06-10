import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { D } from '../util/decimal';
import { RATES_2025 } from '../data/rates-2025';
import type { TaxReturn, TaxYearFacts } from '../engine/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-tax-roll-cf.sqlite');

// Set isolated DB path before any models are imported
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

// Lazy imports — after DATABASE_PATH is set
let Carryforward: typeof import('../../models').Carryforward;
let Entity: typeof import('../../models').Entity;
let Household: typeof import('../../models').Household;
let sequelize: import('../../models').sequelize;
let rollPersonalCarryforwards: typeof import('./rollPersonalCarryforwards').rollPersonalCarryforwards;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const models = await import('../../models/index.js');
  Carryforward = models.Carryforward;
  Entity = models.Entity;
  Household = models.Household;
  sequelize = models.sequelize;
  const rollModule = await import('./rollPersonalCarryforwards.js');
  rollPersonalCarryforwards = rollModule.rollPersonalCarryforwards;

  await sequelize.sync({ force: true });
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

/** Build a minimal TaxReturn shell; netIncome drives the non-cap-loss decrement. */
function makeRet(netIncome: ReturnType<typeof D> | string = D('0')): TaxReturn {
  const zero = D('0');
  return {
    year: 2025,
    lines: [],
    totals: {
      totalIncome: zero,
      // The projection path (projectPersonalFactsFromPrevYear) passes
      // JSON-serialised totals, so netIncome may arrive as a plain string.
      netIncome: netIncome as never,
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
    fhsaContribs: [],
    donations: [],
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
    slips: [],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
    ageAtYearEnd: 40,
    ...overrides,
  };
}

test('roll basic case: no income, no gains — preserves zero balances and writes 5 rows', async () => {
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

  assert.equal(result.written.length, 5);

  const kinds = result.written.map(w => w.kind);
  assert.ok(kinds.includes('cap_loss'));
  assert.ok(kinds.includes('non_cap_loss'));
  assert.ok(kinds.includes('rrsp_room'));
  assert.ok(kinds.includes('fhsa_room'));
  assert.ok(kinds.includes('fhsa_lifetime_contribs'));

  // All balances should be zero with no income (except fhsa_room)
  for (const w of result.written) {
    if (w.kind !== 'fhsa_room') {
      assert.equal(w.amount.toFixed(2), '0.00', `expected zero for ${w.kind}`);
    }
  }

  // FHSA room should equal annual limit (8000) when no lifetime contributions
  const fhsaRow = result.written.find(w => w.kind === 'fhsa_room');
  assert.ok(fhsaRow);
  assert.equal(fhsaRow.amount.toFixed(2), '8000.00');

  // Verify rows were upserted to DB
  const dbRows = await Carryforward.findAll({ where: { entityId: entity.id, asOfYear: 2025 } });
  assert.equal(dbRows.length, 5);
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
      fhsaLifetimeContributions: D('0'),
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
      fhsaLifetimeContributions: D('0'),
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
      fhsaLifetimeContributions: D('0'),
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
      fhsaLifetimeContributions: D('0'),
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

// ---------------------------------------------------------------------------
// Non-capital loss decrement (audit fix): the engine applies
// min(netIncome, nonCapLoss) on L26000 — the roll must subtract that applied
// amount instead of writing the prior balance back unreduced (which made the
// same loss deduct every projected year).
// ---------------------------------------------------------------------------

test('non-cap loss roll: amount applied against net income is decremented', async () => {
  const household = await Household.create({ name: 'Roll test noncap applied' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll NonCap',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('50000'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
  });

  // buildT1 applied min(netIncome=20000, carry=50000) = 20000 on L26000.
  const result = await rollPersonalCarryforwards(
    entity.id, 2025, makeRet(D('20000')), facts, RATES_2025,
  );

  const row = result.written.find(w => w.kind === 'non_cap_loss');
  assert.ok(row);
  assert.equal(row.amount.toFixed(2), '30000.00', 'carry must shrink by the applied amount');
});

test('non-cap loss roll: fully consumed when net income exceeds the carry', async () => {
  const household = await Household.create({ name: 'Roll test noncap consumed' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll NonCap Consumed',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('10000'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
  });

  const result = await rollPersonalCarryforwards(
    entity.id, 2025, makeRet(D('80000')), facts, RATES_2025,
  );

  const row = result.written.find(w => w.kind === 'non_cap_loss');
  assert.ok(row);
  assert.equal(row.amount.toFixed(2), '0.00');
});

test('non-cap loss roll: tolerates serialized string netIncome (projection path)', async () => {
  const household = await Household.create({ name: 'Roll test noncap string' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll NonCap String',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('50000'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
  });

  // projectPersonalFactsFromPrevYear reconstructs the return from JSON, so
  // totals.netIncome arrives as a plain string.
  const result = await rollPersonalCarryforwards(
    entity.id, 2025, makeRet('20000'), facts, RATES_2025,
  );

  const row = result.written.find(w => w.kind === 'non_cap_loss');
  assert.ok(row);
  assert.equal(row.amount.toFixed(2), '30000.00');
});

// ---------------------------------------------------------------------------
// Superficial-loss-denied portion (audit fix): a denied loss is added back to
// the gross gain by the engine (capital-gains.ts) — the roll must mirror that
// instead of banking the denied portion into the carryforward. (CRA: denied
// losses adjust the ACB of the repurchased shares, never the loss carry.)
// ---------------------------------------------------------------------------

test('cap loss roll: superficialLossDenied portion is NOT banked into the carry', async () => {
  const household = await Household.create({ name: 'Roll test superficial' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Roll Superficial',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    capitalGainEvents: [
      {
        source: 'sell XYZ with repurchase',
        securityId: 1,
        proceeds: D('5000'),
        acb: D('15000'),  // raw loss −10000
        outlays: D('0'),
        date: '2025-06-15',
        superficialLossDenied: D('4000'), // only −6000 is claimable
      },
    ],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  const capLossRow = result.written.find(w => w.kind === 'cap_loss');
  assert.ok(capLossRow);
  // adjusted gross = −10000 + 4000 = −6000 → includable −3000 at 0.5 → carry 3000
  assert.equal(capLossRow.amount.toFixed(2), '3000.00', 'denied portion must not grow the carry');
});

// ---------------------------------------------------------------------------
// FHSA lifetime limit tests
// ---------------------------------------------------------------------------

test('FHSA: contributions this year reduce room and accumulate lifetime total', async () => {
  const household = await Household.create({ name: 'FHSA contribs' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'FHSA Contrib',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  const facts = makeFacts({
    fhsaContribs: [{ source: 'FHSA', amount: D('5000'), date: '2025-03-01' }],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  // Lifetime contributions: 0 + 5000 = 5000
  const lifetimeRow = result.written.find(w => w.kind === 'fhsa_lifetime_contribs');
  assert.ok(lifetimeRow);
  assert.equal(lifetimeRow.amount.toFixed(2), '5000.00');

  // Room = min(8000, 40000 - 5000) = min(8000, 35000) = 8000
  const fhsaRow = result.written.find(w => w.kind === 'fhsa_room');
  assert.ok(fhsaRow);
  assert.equal(fhsaRow.amount.toFixed(2), '8000.00');
});

test('FHSA: lifetime contributions approaching cap reduce room below annual limit', async () => {
  const household = await Household.create({ name: 'FHSA near cap' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'FHSA Near Cap',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  // Prior lifetime: $35,000. This year: $8,000. Total = $43,000 but capped at $40k.
  // Effective this-year contribs that count: still $8,000 (we track the full amount).
  // newLifetimeContribs = 35000 + 8000 = 43000
  // lifetimeRemaining = max(0, 40000 - 43000) = 0
  // fhsaRoom = min(8000, 0) = 0
  const facts = makeFacts({
    fhsaContribs: [{ source: 'FHSA', amount: D('8000'), date: '2025-02-01' }],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('35000'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  // Lifetime total = 35000 + 8000 = 43000
  const lifetimeRow = result.written.find(w => w.kind === 'fhsa_lifetime_contribs');
  assert.ok(lifetimeRow);
  assert.equal(lifetimeRow.amount.toFixed(2), '43000.00');

  // Room = min(8000, max(0, 40000 - 43000)) = min(8000, 0) = 0
  const fhsaRow = result.written.find(w => w.kind === 'fhsa_room');
  assert.ok(fhsaRow);
  assert.equal(fhsaRow.amount.toFixed(2), '0.00');
});

test('FHSA: exactly at $40k lifetime cap — room is zero', async () => {
  const household = await Household.create({ name: 'FHSA at cap' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'FHSA At Cap',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  // Prior lifetime = $40,000, no new contribs this year.
  const facts = makeFacts({
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('40000'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  // Room = min(8000, max(0, 40000 - 40000)) = min(8000, 0) = 0
  const fhsaRow = result.written.find(w => w.kind === 'fhsa_room');
  assert.ok(fhsaRow);
  assert.equal(fhsaRow.amount.toFixed(2), '0.00');

  // Lifetime stays at 40000 (no new contribs)
  const lifetimeRow = result.written.find(w => w.kind === 'fhsa_lifetime_contribs');
  assert.ok(lifetimeRow);
  assert.equal(lifetimeRow.amount.toFixed(2), '40000.00');
});

test('FHSA: partial room when near lifetime limit', async () => {
  const household = await Household.create({ name: 'FHSA partial' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'FHSA Partial',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  // Prior lifetime = $35,000, no new contribs this year.
  // Room = min(8000, 40000 - 35000) = min(8000, 5000) = 5000
  const facts = makeFacts({
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('35000'),
    },
  });

  const result = await rollPersonalCarryforwards(entity.id, 2025, makeRet(), facts, RATES_2025);

  // Room = min(8000, 5000) = 5000
  const fhsaRow = result.written.find(w => w.kind === 'fhsa_room');
  assert.ok(fhsaRow);
  assert.equal(fhsaRow.amount.toFixed(2), '5000.00');
});
