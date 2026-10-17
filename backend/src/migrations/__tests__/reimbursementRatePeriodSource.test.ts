/**
 * The interest allocator keys on a rate window, so `reimbursements` needs a
 * rate-window column and a uniqueness rule on it — see the migration's header
 * for why `source_transaction_id` cannot stand in.
 *
 * Also pins the `transaction_id` relaxation: an interest row is owed for a
 * period, not for one outlay, so it has no originating transaction at all.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes, Op } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

const INSERT_INTEREST = (id: number, ratePeriodId: number, contactId: number) =>
  `INSERT INTO reimbursements
     (id, household_id, transaction_id, contact_id, amount, currency, status, kind,
      source_rate_period_id, created_at, updated_at)
   VALUES (${id}, 1, NULL, ${contactId}, 12.3400, 'CAD', 'expected', 'interest',
      ${ratePeriodId}, datetime('now'), datetime('now'))`;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('account_rate_periods', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('reimbursements', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    transaction_id: { type: DataTypes.INTEGER, allowNull: false },
    contact_id: { type: DataTypes.INTEGER, allowNull: true },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'principal' },
    source_transaction_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // The index set the prior migration left behind. Its survival is asserted
  // below: Sequelize's SQLite `changeColumn` rebuilds the table and would
  // otherwise drop it and promote `contact_id` to a column-level UNIQUE.
  await qi.addIndex('reimbursements', ['contact_id'], { name: 'reimbursements_contact_id' });
  await qi.addIndex('reimbursements', ['source_transaction_id', 'contact_id'], {
    unique: true,
    name: 'idx_reimbursements_interest_source',
    where: { source_transaction_id: { [Op.ne]: null } },
  });
  await sequelize.query(`INSERT INTO account_rate_periods (id) VALUES (7), (8)`);
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, kind, created_at, updated_at)
    VALUES (1, 1, 100, 4, 500.0000, 'CAD', 'expected', 'principal', datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260918000002-reimbursement-rate-period-source.js');
});

after(async () => { await sequelize.close(); });

test('up adds the rate-window provenance and leaves principal rows untouched', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.ok(desc.source_rate_period_id, 'the allocator keys on a rate window, not a transaction');
  const [rows] = await sequelize.query(
    'SELECT transaction_id, source_rate_period_id, kind FROM reimbursements WHERE id = 1',
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (rows as any[])[0];
  assert.equal(r.transaction_id, 100, 'a hand-logged claim keeps its outlay');
  assert.equal(r.source_rate_period_id, null);
  assert.equal(r.kind, 'principal');
});

test('the existing indexes survive the transaction_id relaxation', async () => {
  const [indexes] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reimbursements' AND sql IS NOT NULL",
  );
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(names.includes('idx_reimbursements_interest_source'), 'the charge-keyed unique index survives');
  assert.ok(names.includes('reimbursements_contact_id'));
  const [ddl] = await sequelize.query("SELECT sql FROM sqlite_master WHERE name = 'reimbursements'");
  assert.doesNotMatch(
    (ddl as Array<{ sql: string }>)[0].sql,
    /`contact_id`\s+INTEGER\s+UNIQUE/,
    'a composite unique index must not be rebuilt as a column-level UNIQUE — that would allow one claim per contact, ever',
  );
  // Proven by behaviour, not just DDL: two claims for the same contact.
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, kind, created_at, updated_at)
    VALUES (9, 1, 101, 4, 5.0000, 'CAD', 'expected', 'principal', datetime('now'), datetime('now'))`);
});

test('an interest row may have no outlay transaction', async () => {
  await sequelize.query(INSERT_INTEREST(2, 7, 4));
  const [rows] = await sequelize.query('SELECT transaction_id FROM reimbursements WHERE id = 2');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((rows as any[])[0].transaction_id, null);
});

test('the unique index rejects two interest rows for the same window and contact', async () => {
  await sequelize.query(INSERT_INTEREST(3, 7, 4)).then(
    () => assert.fail('expected a unique-index violation — a re-run must not double-charge'),
    () => { /* expected */ },
  );
  // A different window for the same contact is fine: each window bills separately.
  await sequelize.query(INSERT_INTEREST(4, 8, 4));
});

test('down drops the null-outlay interest rows and restores the column', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.equal(desc.source_rate_period_id, undefined);
  const [rows] = await sequelize.query('SELECT id FROM reimbursements');
  assert.deepEqual((rows as Array<{ id: number }>).map((r) => r.id), [1, 9], 'derived rows go, claims stay');
});
