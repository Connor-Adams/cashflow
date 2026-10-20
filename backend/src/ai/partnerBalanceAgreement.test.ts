/**
 * The AI partner-balance answer (`POST /api/ai/query` → `partner_balance`)
 * must report the same balance as the Reports partner card
 * (`GET /api/summary/partner`) for the same household data.
 *
 * Both have to attribute splits with `partnerMath.attributeSplitContact`
 * (stamped contact wins, an unstamped split goes to the sole partner) and
 * match settlements the same way (a settlement that matches no split spend is
 * surfaced, not turned into a balance). This seeds one of each case and
 * asserts the two answers agree row for row.
 *
 * Uses the per-process SQLite test DB (backend/test/setup.ts).
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import {
  sequelize,
  Account,
  Contact,
  Household,
  PartnerSettlement,
  Transaction,
  User,
} from '../models';
import summaryRouter from '../routes/summary';
import { executeIntent } from './queryBuilders';

let householdId: number;
let userId: number;
let partnerId: number;
let friendId: number;

function auth() {
  return {
    user: { id: userId, globalRole: 'user' },
    household: { id: householdId },
    role: 'owner',
  };
}

function fakeReq(): Request {
  return { auth: auth(), query: {} } as unknown as Request;
}

function reportsApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = auth();
    next();
  });
  app.use('/api/summary', summaryRouter);
  return app;
}

async function txn(opts: {
  accountId: number;
  ownershipType: string;
  ownershipContactId: number | null;
  amount: number;
  partnerShare: number;
  currency?: string;
}): Promise<void> {
  const fp = crypto.randomBytes(16).toString('hex');
  await Transaction.create({
    accountId: opts.accountId,
    householdId,
    visibility: 'shared',
    createdByUserId: userId,
    importBatch: 'partner-balance-agreement-test',
    date: '2026-03-10',
    amount: opts.amount.toFixed(4),
    currency: opts.currency ?? 'CAD',
    merchantRaw: 'Grocer',
    merchantClean: 'Grocer',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: false,
    ownershipType: opts.ownershipType,
    ownershipContactId: opts.ownershipContactId,
    myShareAmount: (opts.amount - opts.partnerShare).toFixed(4),
    partnerShareAmount: opts.partnerShare.toFixed(4),
  } as never);
}

before(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: `partner-agree-${Date.now()}@example.com`,
    displayName: 'Agree',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  const household = await Household.create({ name: 'Agreement HH' } as never);
  householdId = household.id;
  const account = await Account.create({
    householdId,
    name: 'Shared Card',
    accountType: 'credit_card',
    visibility: 'shared',
    defaultCurrency: 'CAD',
  } as never);
  const partner = await Contact.create({ householdId, name: 'Pat', isPartner: true } as never);
  partnerId = partner.id;
  const friend = await Contact.create({ householdId, name: 'Fran', isPartner: false } as never);
  friendId = friend.id;

  // Unstamped partner split (legacy import) → belongs to the sole partner.
  await txn({ accountId: account.id, ownershipType: 'partner', ownershipContactId: null, amount: -100, partnerShare: -60 });
  // Stamped split for the same partner.
  await txn({ accountId: account.id, ownershipType: 'shared', ownershipContactId: partnerId, amount: -100, partnerShare: -50 });
  // Split with a non-partner contact.
  await txn({ accountId: account.id, ownershipType: 'contact', ownershipContactId: friendId, amount: -60, partnerShare: -30 });
  // My own spend — never a balance.
  await txn({ accountId: account.id, ownershipType: 'me', ownershipContactId: null, amount: -500, partnerShare: 0 });

  // Partner paid me 80 against the 110 they owed.
  await PartnerSettlement.create({
    householdId,
    contactId: partnerId,
    direction: 'partner_paid_me',
    amount: '80.0000',
    currency: 'CAD',
    settledDate: '2026-03-20',
  } as never);
  // A USD settlement with no USD split spend: Reports surfaces it as unmatched.
  await PartnerSettlement.create({
    householdId,
    contactId: friendId,
    direction: 'i_paid_partner',
    amount: '25.0000',
    currency: 'USD',
    settledDate: '2026-03-21',
  } as never);
});

test('AI partner_balance agrees with the Reports partner balance', async () => {
  const reports = await request(reportsApp()).get('/api/summary/partner');
  assert.equal(reports.status, 200);
  type Row = { contactName: string | null; currency: string; net: number };
  const reportsByKey = new Map<string, number>();
  for (const r of reports.body.byCurrency as Row[]) {
    if (Math.abs(r.net) < 0.005) continue;
    reportsByKey.set(`${r.contactName}\0${r.currency}`, Math.round(r.net * 100) / 100);
  }

  const ai = await executeIntent(fakeReq(), { intent: 'partner_balance' });
  const aiByKey = new Map<string, number>();
  for (const b of ai.answer.partnerBalances ?? []) {
    if (b.direction === 'settled') continue;
    aiByKey.set(`${b.contactName}\0${b.currency}`, b.netBalance);
  }

  assert.deepEqual(
    Object.fromEntries(aiByKey),
    Object.fromEntries(reportsByKey),
  );
  // 60 (unstamped) + 50 (stamped) − 80 settled.
  assert.equal(aiByKey.get('Pat\0CAD'), 30);
  assert.equal(aiByKey.get('Fran\0CAD'), 30);
  // The unmatched USD settlement is not a balance in either answer…
  assert.equal(aiByKey.has('Fran\0USD'), false);
  assert.equal(reports.body.unmatchedSettlements.length, 1);
  // …but the AI headline does not silently drop it.
  assert.match(ai.answer.headline, /1 settlement could not be matched/);
});
