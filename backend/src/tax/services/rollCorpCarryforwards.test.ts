import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { D } from '../util/decimal';
import type { CorpTaxReturn } from '../engine/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-tax-roll-corp-cf.sqlite');

// Set isolated DB path before any models are imported
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

// Lazy imports — after DATABASE_PATH is set
let Carryforward: typeof import('../../models').Carryforward;
let Entity: typeof import('../../models').Entity;
let Household: typeof import('../../models').Household;
let sequelize: import('../../models').sequelize;
let rollCorpCarryforwards: typeof import('./rollCorpCarryforwards').rollCorpCarryforwards;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const models = await import('../../models/index.js');
  Carryforward = models.Carryforward;
  Entity = models.Entity;
  Household = models.Household;
  sequelize = models.sequelize;
  const rollModule = await import('./rollCorpCarryforwards.js');
  rollCorpCarryforwards = rollModule.rollCorpCarryforwards;

  await sequelize.sync({ force: true });
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

/** Build a minimal CorpTaxReturn for testing. */
function makeCorpRet(overrides: Partial<CorpTaxReturn['totals']> = {}): CorpTaxReturn {
  const zero = D('0');
  return {
    fiscalYear: { startDate: '2025-01-01', endDate: '2025-12-31' },
    lines: [],
    totals: {
      activeBusinessIncome: zero,
      sbdEligibleIncome: zero,
      generalRateIncome: zero,
      aii: zero,
      taxableIncome: zero,
      federalTax: zero,
      provincialTax: zero,
      refundableTaxOnAii: zero,
      dividendRefund: zero,
      netTaxPayable: zero,
      gripEnding: zero,
      cdaEnding: zero,
      erdtohEnding: zero,
      nerdtohEnding: zero,
      ...overrides,
    },
    warnings: [],
  };
}

test('roll corp: zero balances writes 4 rows with 0.0000', async () => {
  const household = await Household.create({ name: 'Corp Roll Basic' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Acme Corp',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  } as never);

  const result = await rollCorpCarryforwards(entity.id, 2025, makeCorpRet());

  assert.equal(result.written.length, 4);

  const kinds = result.written.map(w => w.kind);
  assert.ok(kinds.includes('grip'));
  assert.ok(kinds.includes('cda'));
  assert.ok(kinds.includes('erdtoh'));
  assert.ok(kinds.includes('nerdtoh'));

  for (const w of result.written) {
    assert.equal(w.amount, '0.0000', `expected 0.0000 for ${w.kind}, got ${w.amount}`);
  }

  // Verify rows persisted to DB
  const dbRows = await Carryforward.findAll({ where: { entityId: entity.id, asOfYear: 2025 } });
  assert.equal(dbRows.length, 4);
});

test('roll corp: nonzero GRIP and CDA are persisted correctly', async () => {
  const household = await Household.create({ name: 'Corp Roll Nonzero' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Nonzero Corp',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  } as never);

  const ret = makeCorpRet({
    gripEnding: D('125000.50'),
    cdaEnding: D('30000'),
    erdtohEnding: D('5000.1234'),
    nerdtohEnding: D('2500'),
  });

  const result = await rollCorpCarryforwards(entity.id, 2025, ret);

  const grip = result.written.find(w => w.kind === 'grip');
  assert.ok(grip);
  assert.equal(grip.amount, '125000.5000');

  const cda = result.written.find(w => w.kind === 'cda');
  assert.ok(cda);
  assert.equal(cda.amount, '30000.0000');

  const erdtoh = result.written.find(w => w.kind === 'erdtoh');
  assert.ok(erdtoh);
  assert.equal(erdtoh.amount, '5000.1234');

  const nerdtoh = result.written.find(w => w.kind === 'nerdtoh');
  assert.ok(nerdtoh);
  assert.equal(nerdtoh.amount, '2500.0000');

  // Verify values in DB
  const gripRow = await Carryforward.findOne({
    where: { entityId: entity.id, asOfYear: 2025, kind: 'grip' },
  });
  assert.ok(gripRow);
  assert.equal(Number(gripRow.amount).toFixed(4), '125000.5000');
});

test('roll corp: upsert updates existing rows', async () => {
  const household = await Household.create({ name: 'Corp Roll Upsert' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Upsert Corp',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  } as never);

  // First roll: GRIP = 10000
  await rollCorpCarryforwards(entity.id, 2025, makeCorpRet({ gripEnding: D('10000') }));

  // Second roll: GRIP = 50000 (updated)
  await rollCorpCarryforwards(entity.id, 2025, makeCorpRet({ gripEnding: D('50000') }));

  const gripRows = await Carryforward.findAll({
    where: { entityId: entity.id, asOfYear: 2025, kind: 'grip' },
  });
  assert.equal(gripRows.length, 1, 'upsert should keep only 1 row per kind+year');
  assert.equal(Number(gripRows[0].amount).toFixed(4), '50000.0000');
});

test('roll corp: amount stored with 4 decimal precision', async () => {
  const household = await Household.create({ name: 'Corp Roll Precision' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Precision Corp',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  } as never);

  const ret = makeCorpRet({ cdaEnding: D('12345.6789') });
  const result = await rollCorpCarryforwards(entity.id, 2025, ret);

  const cda = result.written.find(w => w.kind === 'cda');
  assert.ok(cda);
  assert.equal(cda.amount, '12345.6789');
});
