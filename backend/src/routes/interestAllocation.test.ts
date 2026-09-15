/**
 * DB-backed tests for the line-of-credit interest allocator at the HTTP boundary:
 * `POST /api/contacts/interest-allocation` and the two interest figures the
 * contact ledger grew.
 *
 * The invariant these tests exist to protect is the one from the design doc's
 * "Two figures, never merged":
 *
 *   - **charged** interest traces to a printed statement figure. It is persisted,
 *     one row per (rate window, contact), and re-running recomputes it.
 *   - **accrued** interest is an estimate of the days since the last statement. It
 *     changes every single day and is computed on read. It is NEVER written. A
 *     stored estimate would be indistinguishable from a billed fact the next time
 *     anyone read the table, which is exactly the error this feature removes.
 *
 * So `no persisted row may lack a rate window` is asserted directly, not implied.
 *
 * Mounts the contacts router behind a stubbed req.auth on the per-process SQLite
 * test DB, the same bootstrap as ./contactsLedger.test.ts.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };
let otherHousehold: { id: number };
let locAccountId: number;
let stephenId: number;
let caelanId: number;

/** The day the tail is measured to; ten days past the last window's end. */
const AS_OF = '2026-09-13';

/**
 * Two windows, both real shapes from the statements:
 *   w1 predates every tagged loan, so it must allocate nothing;
 *   w2 is the binding case — raw accrual (235.19) exceeds the printed 172.36
 *   because lending exceeds the line, so allocations scale down to the printed
 *   figure exactly and the scaling factor is below 1.
 */
const WINDOWS = [
  { fromDate: '2025-07-08', toDate: '2025-08-04', effectiveRate: '9.4400', applicableInterest: '41.3800' },
  { fromDate: '2026-08-04', toDate: '2026-09-03', effectiveRate: '8.9400', applicableInterest: '172.3600' },
];

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  household = await models.Household.create({ name: 'Interest Test HH' });
  otherHousehold = await models.Household.create({ name: 'No Rates HH' });

  const stephen = await models.Contact.create({
    householdId: household.id, name: 'STEPHEN MASSEUR', loanDefault: false,
  } as never);
  stephenId = stephen.id;
  const caelan = await models.Contact.create({
    householdId: household.id, name: 'Caelan Iten-McGrath', loanDefault: false,
  } as never);
  caelanId = caelan.id;

  const loc = await models.Account.create({
    householdId: household.id, name: 'RBC Royal Credit Line', accountType: 'loan',
  } as never);
  locAccountId = loc.id;
  const chequing = await models.Account.create({
    householdId: household.id, name: 'RBC Day to Day Banking',
  } as never);

  const loans: Array<{ contactId: number; date: string; amount: string }> = [
    { contactId: caelanId, date: '2026-01-01', amount: '-24275.0000' },
    { contactId: stephenId, date: '2026-04-15', amount: '-6700.0000' },
  ];
  let i = 0;
  for (const l of loans) {
    i += 1;
    await models.Transaction.create({
      householdId: household.id,
      accountId: chequing.id,
      importBatch: 'interest-test',
      date: l.date,
      merchantRaw: 'ONLINE BANKING TRANSFER',
      merchantClean: 'Transfer',
      amount: l.amount,
      currency: 'CAD',
      sourceRowFingerprint: `interest-test-row-${i}`,
      sourceIdentityFingerprint: `interest-test-id-${i}`,
      counterpartyContactId: l.contactId,
      counterpartyRole: 'loan',
    } as never);
  }

  for (const w of WINDOWS) {
    await models.AccountRatePeriod.create({
      householdId: household.id, accountId: locAccountId, ...w,
    } as never);
  }

  const contactsRouter = (await import('./contacts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const hid = req.header('x-test-household') === 'other' ? otherHousehold : household;
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household: hid,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api/contacts', contactsRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.Reimbursement.destroy({ where: {}, force: true });
  const { _resetInterestAllocationInFlightForTest } = await import('../contacts/runInterestAllocation');
  _resetInterestAllocationInFlightForTest();
});

const postAllocation = (body: Record<string, unknown> = {}) =>
  request(app).post('/api/contacts/interest-allocation').send({ asOf: AS_OF, ...body });

const getLedger = (id: number) =>
  request(app).get(`/api/contacts/${id}/ledger`).query({ today: AS_OF });

const cadOf = (rows: Array<{ currency: string; balance: string }>) =>
  rows.find((b) => b.currency === 'CAD');

test('POST allocates each rate window and bounds it by the printed interest', async () => {
  const res = await postAllocation();
  assert.equal(res.status, 200);
  assert.equal(res.body.windows, 2, 'both windows are considered');
  assert.equal(res.body.allocations, 2, 'only the second window has any outstanding balance');
  assert.equal(res.body.totalCharged, '172.3600', 'the bound is an identity, not a ceiling to approach');
  assert.equal(res.body.dryRun, false);
});

test('POST surfaces the per-window scaling factor rather than hiding it', async () => {
  const res = await postAllocation();
  const bound = res.body.windowSummaries.find((w: { bound: boolean }) => w.bound);
  assert.ok(bound, 'the second window binds — lending exceeds the line');
  assert.equal(bound.applicableInterest, '172.3600');
  // 6700 x 8.94% x 31/365 = 50.8723, 24275 likewise = 184.3171.
  assert.equal(Number(bound.rawTotal).toFixed(2), '235.19', 'raw accrual before the bound');
  assert.ok(
    Number(bound.scalingFactor) > 0 && Number(bound.scalingFactor) < 1,
    `expected a sub-unit scaling factor, got ${bound.scalingFactor}`,
  );
  const idle = res.body.windowSummaries.find((w: { rateWindowId: number }) => w.rateWindowId !== bound.rateWindowId);
  assert.equal(idle.rawTotal, '0.0000', 'a window predating every loan allocates nothing');
});

test('the allocation lands on the ledger as charged interest, never folded into principal', async () => {
  await postAllocation();
  const res = await getLedger(stephenId);
  assert.equal(res.status, 200);
  const charged = cadOf(res.body.interestCharged);
  assert.ok(charged, 'Stephen carries charged interest');
  // 50.8723 raw of a 235.1894 raw total, scaled to the printed 172.36.
  assert.equal(Number(charged.balance).toFixed(2), '37.28');
  const principal = cadOf(res.body.loanBalance);
  assert.equal(principal?.balance, '6700.0000', 'interest must not inflate principal');
});

test('the accrued tail is served beside the charged figure and is not the same number', async () => {
  await postAllocation();
  const res = await getLedger(stephenId);
  const accrued = cadOf(res.body.interestAccrued);
  assert.ok(accrued, 'the ten days since the last statement accrue something');
  // 6700 x 8.94% x 10/365 = 16.4077. Unbounded: nothing has been billed for it.
  assert.equal(Number(accrued.balance).toFixed(2), '16.41');
});

test('the accrued estimate is never persisted', async () => {
  await postAllocation();
  const rows = await models.Reimbursement.findAll({ where: { kind: 'interest' } });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.notEqual(
      r.sourceRatePeriodId, null,
      'every persisted interest row traces to a printed rate window; an estimate has none',
    );
  }
  const total = rows.reduce((n, r) => n + Number(r.amount), 0);
  assert.equal(total.toFixed(4), '172.3600', 'only charged interest is stored, never the tail');
});

test('re-running recomputes rather than double-charging', async () => {
  await postAllocation();
  const first = await models.Reimbursement.findAll({
    where: { kind: 'interest' }, order: [['contact_id', 'ASC']],
  });
  await postAllocation();
  const second = await models.Reimbursement.findAll({
    where: { kind: 'interest' }, order: [['contact_id', 'ASC']],
  });
  assert.equal(second.length, first.length, 'delete-then-insert, never accumulate');
  assert.deepEqual(
    second.map((r) => [r.contactId, r.sourceRatePeriodId, Number(r.amount).toFixed(4)]),
    first.map((r) => [r.contactId, r.sourceRatePeriodId, Number(r.amount).toFixed(4)]),
  );
  const ledger = await getLedger(stephenId);
  assert.equal(Number(cadOf(ledger.body.interestCharged)!.balance).toFixed(2), '37.28');
});

test('dryRun reports what it would do and writes nothing', async () => {
  const res = await postAllocation({ dryRun: true });
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.allocations, 2);
  assert.equal(res.body.totalCharged, '172.3600');
  assert.equal(await models.Reimbursement.count({ where: { kind: 'interest' } }), 0);
  const ledger = await getLedger(stephenId);
  assert.deepEqual(ledger.body.interestCharged, []);
});

test('charged interest does not leak into the tracked reimbursement outstanding', async () => {
  await postAllocation();
  const res = await getLedger(caelanId);
  assert.deepEqual(
    res.body.trackedOutstandingByCurrency, {},
    'generated interest rows are not hand-logged claims',
  );
});

test('a household with no rate windows allocates nothing and does not throw', async () => {
  const res = await request(app)
    .post('/api/contacts/interest-allocation')
    .set('x-test-household', 'other')
    .send({ asOf: AS_OF });
  assert.equal(res.status, 200);
  assert.equal(res.body.windows, 0);
  assert.equal(res.body.allocations, 0);
  assert.equal(res.body.totalCharged, '0.0000');
});
