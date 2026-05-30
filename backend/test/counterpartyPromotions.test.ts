/**
 * Unit tests for the counterparty-promotion detector (#373).
 *
 * The detector queries the database, so these tests boot a one-off
 * in-memory SQLite Sequelize and stub the two tables we need:
 *   - transactions (just the columns the SELECT references)
 *   - ai_suggestions (for the dismissals subquery)
 *
 * They cover the normalizer (pure function), the recurrence threshold
 * gate, the 90-day window, the "already linked" filter, the dismissal
 * filter, and the deterministic ordering.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DataTypes } from 'sequelize';

// The test harness (test/setup.ts) wires DATABASE_PATH for a per-process
// sqlite file. We import the real models singleton and stub just the
// tables the detector reads, so we don't need to spin a real Postgres.

let detector: typeof import('../src/ai/counterpartyPromotions');
let sequelize: import('sequelize').Sequelize;

async function resetDb(): Promise<void> {
  await sequelize.query(`DELETE FROM transactions`);
  await sequelize.query(`DELETE FROM ai_suggestions`);
}

function dateNDaysAgo(n: number, now: Date): string {
  const cutoff = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

before(async () => {
  // Import the modules — this initializes the model registry, which we
  // then mutate by dropping/creating the tables our detector reads.
  const models = await import('../src/models');
  sequelize = models.sequelize;

  await sequelize.getQueryInterface().dropAllTables();

  // Stub `transactions` with just the columns the detector reads. Defining
  // explicit defaults so seed rows below can omit them.
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    counterparty_raw: { type: DataTypes.TEXT, allowNull: true },
    counterparty_contact_id: { type: DataTypes.INTEGER, allowNull: true },
    date: { type: DataTypes.STRING(10), allowNull: false },
  });

  // Stub `ai_suggestions` with the columns the detector's dismissal query
  // references. JSON in SQLite is stored as TEXT; the jsonExtractText
  // helper resolves to json_extract() which sqlite supports natively.
  await sequelize.getQueryInterface().createTable('ai_suggestions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    kind: { type: DataTypes.STRING(32), allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false },
    input_snapshot: { type: DataTypes.JSON, allowNull: true },
  });

  detector = await import('../src/ai/counterpartyPromotions');
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await resetDb();
});

test('normalizeCounterpartyName: lowercases and collapses whitespace', () => {
  assert.equal(detector.normalizeCounterpartyName('  JANE  DOE  '), 'jane doe');
  assert.equal(detector.normalizeCounterpartyName('Jane\tDoe'), 'jane doe');
  assert.equal(detector.normalizeCounterpartyName('   '), null);
  assert.equal(detector.normalizeCounterpartyName(null), null);
  assert.equal(detector.normalizeCounterpartyName(''), null);
});

test('detector: returns rows when counterparty_raw recurs >= threshold within 90 days', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  // 4 unlinked txns from JANE DOE within window, 1 from BOB JONES (below
  // threshold of 3).
  const rows = [
    { hh: 1, raw: 'JANE DOE', linked: null, dayOffset: 5 },
    { hh: 1, raw: 'JANE DOE', linked: null, dayOffset: 30 },
    { hh: 1, raw: 'JANE DOE', linked: null, dayOffset: 60 },
    { hh: 1, raw: 'JANE DOE', linked: null, dayOffset: 89 },
    { hh: 1, raw: 'BOB JONES', linked: null, dayOffset: 10 },
  ];
  for (const r of rows) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      { replacements: [r.hh, r.raw, r.linked, dateNDaysAgo(r.dayOffset, now)] },
    );
  }
  const result = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(result.length, 1);
  assert.equal(result[0].normalizedName, 'jane doe');
  assert.equal(result[0].supportCount, 4);
  assert.equal(result[0].exampleTransactionIds.length, 4);
});

test('detector: skips rows linked to a contact (AC #4)', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  for (let i = 0; i < 4; i++) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      // First three are linked to contact 99; the fourth is unlinked.
      // Below threshold of 3 once linked rows drop out.
      { replacements: [1, 'JANE DOE', i < 3 ? 99 : null, dateNDaysAgo(5, now)] },
    );
  }
  const result = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(result.length, 0, 'linked rows should not count toward threshold');
});

test('detector: skips rows older than 90 days', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  // 5 txns at 100 days ago — outside the 90-day window.
  for (let i = 0; i < 5; i++) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      { replacements: [1, 'JANE DOE', null, dateNDaysAgo(100, now)] },
    );
  }
  const result = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(result.length, 0, 'stale rows outside 90-day window should not surface');
});

test('detector: ignores dismissed normalized names (AC #3)', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  for (let i = 0; i < 4; i++) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      { replacements: [1, 'JANE DOE', null, dateNDaysAgo(10 + i, now)] },
    );
  }
  await sequelize.query(
    `INSERT INTO ai_suggestions (household_id, kind, status, input_snapshot)
     VALUES (?, 'counterparty_promotion', 'rejected', ?)`,
    { replacements: [1, JSON.stringify({ normalizedName: 'jane doe' })] },
  );
  const result = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(result.length, 0, 'dismissed rows should not surface');
});

test('detector: respects householdId scope (no cross-household leak)', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  for (let i = 0; i < 4; i++) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      { replacements: [2, 'JANE DOE', null, dateNDaysAgo(5, now)] },
    );
  }
  const result = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(result.length, 0, 'should not see other-household txns');

  const otherResult = await detector.findCounterpartyPromotions(2, { now, threshold: 3 });
  assert.equal(otherResult.length, 1, 'should see same-household txns');
  assert.equal(otherResult[0].normalizedName, 'jane doe');
});

test('detector: groups across casing/whitespace variants via normalizeCounterpartyName', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  const variants = ['JANE DOE', 'Jane Doe', '  jane  doe ', 'jane doe'];
  for (const raw of variants) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      { replacements: [1, raw, null, dateNDaysAgo(10, now)] },
    );
  }
  const result = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(result.length, 1, 'casing/whitespace variants should collapse to one group');
  assert.equal(result[0].normalizedName, 'jane doe');
  assert.equal(result[0].supportCount, 4);
});

test('detector: respects configurable threshold (AC #5)', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  for (let i = 0; i < 4; i++) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      { replacements: [1, 'JANE DOE', null, dateNDaysAgo(5 + i, now)] },
    );
  }
  const at3 = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(at3.length, 1, 'threshold=3 matches a group of 4');
  const at5 = await detector.findCounterpartyPromotions(1, { now, threshold: 5 });
  assert.equal(at5.length, 0, 'threshold=5 does not match a group of 4');
});

test('detector: orders results by supportCount DESC then normalizedName ASC', async () => {
  const now = new Date('2026-09-01T12:00:00Z');
  // ALICE has 5 hits, BOB has 4 hits, CAROL has 4 hits.
  const seeds = [
    ...Array.from({ length: 5 }, () => 'ALICE'),
    ...Array.from({ length: 4 }, () => 'CAROL'),
    ...Array.from({ length: 4 }, () => 'BOB'),
  ];
  for (const raw of seeds) {
    await sequelize.query(
      `INSERT INTO transactions (household_id, counterparty_raw, counterparty_contact_id, date)
       VALUES (?, ?, ?, ?)`,
      { replacements: [1, raw, null, dateNDaysAgo(20, now)] },
    );
  }
  const result = await detector.findCounterpartyPromotions(1, { now, threshold: 3 });
  assert.equal(result.length, 3);
  assert.equal(result[0].normalizedName, 'alice');
  assert.equal(result[0].supportCount, 5);
  // Tied at supportCount=4; bob < carol lexicographically.
  assert.equal(result[1].normalizedName, 'bob');
  assert.equal(result[2].normalizedName, 'carol');
});
