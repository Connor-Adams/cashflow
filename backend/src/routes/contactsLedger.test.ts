/**
 * DB-backed tests for GET /api/contacts/:id/ledger, the per-person loan ledger.
 *
 * The route used to hand the UI `transferNet` — the raw sum of every linked
 * transaction — under the label "owed to you". In production that reported
 * ~79,406 owed across four contacts, almost none of it debt: purchases,
 * business flows and cancelled e-transfer legs all counted. These tests lock
 * down the replacement at the HTTP boundary:
 *
 *   - `loanBalance` is signed and only loan/repayment-tagged rows move it;
 *   - both legs of a cancelled e-transfer pair are still LISTED (so the user
 *     can see why the pair counted for nothing) but carry ledgerEffect 'none';
 *   - `merchant` is the raw bank text, because `merchant_clean` strips the
 *     counterparty name off RBC transfers and made 157 rows for one contact
 *     render as the identical string.
 *
 * Mounts the contacts router behind a stubbed req.auth (matching the pattern in
 * ./reviewItems.test.ts and ./items.test.ts) on the per-process SQLite test DB.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };
let contactId: number;

/** Evan-shaped fixture: the exact mix that made the old number meaningless. */
const ROWS: Array<{
  amount: string;
  counterpartyRole: string | null;
  merchantRaw: string;
  merchantClean: string;
}> = [
  {
    amount: '-4550.0000',
    counterpartyRole: 'purchase',
    merchantRaw: 'E-TRANSFER SENT EVAN PHONE NUMBER YAMRKV',
    merchantClean: 'E-TRANSFER SENT',
  },
  {
    amount: '-3648.0000',
    counterpartyRole: 'loan',
    merchantRaw: 'CHEXY*ARVIND MALLYA   HAMILTON',
    merchantClean: 'Chexy',
  },
  {
    amount: '-2081.3100',
    counterpartyRole: 'business',
    merchantRaw: 'Sent money to Evan Adcock',
    merchantClean: 'Sent money to',
  },
  {
    amount: '3904.1700',
    counterpartyRole: 'repayment',
    merchantRaw: 'Cash received',
    merchantClean: 'Cash received',
  },
  {
    amount: '-40.0000',
    counterpartyRole: null,
    merchantRaw: 'E-TRANSFER SENT EVAN LEROSE DPKGQG',
    merchantClean: 'E-TRANSFER SENT',
  },
  {
    amount: '40.0000',
    counterpartyRole: null,
    merchantRaw: 'E-TRANSFER CANCEL EVAN LEROSE DPKGQG',
    merchantClean: 'E-TRANSFER CANCEL',
  },
];

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  household = await models.Household.create({ name: 'Ledger Test HH' });
  const contact = await models.Contact.create({
    householdId: household.id,
    name: 'Evan Adcock',
    loanDefault: true,
  } as never);
  contactId = contact.id;
  const account = await models.Account.create({
    householdId: household.id,
    name: 'Ledger Test Chequing',
  } as never);

  let i = 0;
  for (const r of ROWS) {
    i += 1;
    await models.Transaction.create({
      householdId: household.id,
      accountId: account.id,
      importBatch: 'ledger-test',
      date: `2026-01-0${i}`,
      merchantRaw: r.merchantRaw,
      merchantClean: r.merchantClean,
      amount: r.amount,
      currency: 'CAD',
      sourceRowFingerprint: `ledger-test-row-${i}`,
      sourceIdentityFingerprint: `ledger-test-id-${i}`,
      counterpartyContactId: contactId,
      counterpartyRole: r.counterpartyRole,
    } as never);
  }

  const contactsRouter = (await import('./contacts')).default;
  app = express();
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api/contacts', contactsRouter);
});

after(async () => {
  await models.sequelize.close();
});

const getLedger = (id: number) => request(app).get(`/api/contacts/${id}/ledger`);

test('GET /:id/ledger returns a signed balance excluding non-debt roles', async () => {
  const res = await getLedger(contactId);
  assert.equal(res.status, 200);
  const cad = res.body.loanBalance.find((b: { currency: string }) => b.currency === 'CAD');
  assert.equal(cad.balance, '-256.1700', 'purchase and business legs must not create a debt');
});

test('GET /:id/ledger excludes both legs of a cancelled e-transfer', async () => {
  const res = await getLedger(contactId);
  const legs = res.body.transfers.filter((t: { cancelled: boolean }) => t.cancelled);
  assert.equal(legs.length, 2, 'both legs are listed so the user can see why they count for nothing');
  for (const leg of legs) assert.equal(leg.ledgerEffect, 'none');
});

test('GET /:id/ledger returns raw bank text, not the stripped merchant', async () => {
  const res = await getLedger(contactId);
  // Matched as the exact string: DECIMAL(14,4) round-trips as a JS number under
  // SQLite (these tests) and as a fixed-4 string under Postgres (production),
  // and the handler's `Number(t.amount).toFixed(4)` normalizes both to this.
  const row = res.body.transfers.find((t: { amount: string }) => t.amount === '-3648.0000');
  assert.match(row.merchant, /ARVIND MALLYA/, 'merchant_clean would hide the counterparty');
});

test('GET /:id/ledger echoes the contact loan default', async () => {
  const res = await getLedger(contactId);
  assert.equal(res.body.loanDefault, true);
});
