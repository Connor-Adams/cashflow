/**
 * Route-level test for the Sankey drill-down at DEPTH.
 *
 * `GET /api/summary/sankey/source-transactions` resolves a clicked
 * `(source, target)` edge back to transaction ids by re-running the
 * aggregation. Once the aggregator emits subcategory levels, the indices the
 * client clicks are no longer "0 → n" — they are parent → child at arbitrary
 * depth. Nothing else in the suite exercises that path end to end, and a
 * regression there fails silently (an empty dialog, not an error).
 *
 * Runs on the unit tier's per-process SQLite DB (backend/test/setup.ts).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import {
  sequelize,
  Account,
  Category,
  Transaction,
  User,
  Household,
  HouseholdMember,
  Session,
} from '../models';
import { hashPassword, hashToken } from '../auth/password';

let testApp: (typeof import('../app.js'))['default'];
let sessionToken: string;
let householdId: number;
let accountId: number;
let userId: number;
const categoryIds = new Map<string, number>();

/** Transaction ids by merchant label, so assertions can name rows. */
const txnIds = new Map<string, number>();

async function makeTxn(
  label: string,
  amount: string,
  opts: {
    category?: string;
    business?: boolean;
    txnType?: string;
  } = {},
): Promise<void> {
  const fp = `sankey-drill-${label}-${crypto.randomBytes(6).toString('hex')}`;
  const created = await Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    importBatch: 'sankey-drill',
    date: '2026-06-01',
    amount,
    currency: 'CAD',
    merchantRaw: label,
    merchantClean: label,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    finalCategory: opts.category ?? null,
    finalCategoryId: opts.category ? (categoryIds.get(opts.category) ?? null) : null,
    finalBusiness: opts.business ?? false,
    txnType: opts.txnType ?? (Number(amount) < 0 ? 'purchase' : 'income'),
    reviewFlag: false,
    finalSplitType: 'me',
  } as never);
  txnIds.set(label, created.id);
}

before(async () => {
  await sequelize.sync({ force: true });

  const password = await hashPassword('password123');
  const user = await User.create({
    email: `sankey-drill-${Date.now()}@example.com`,
    displayName: 'Sankey Drill',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  userId = user.id;

  const household = await Household.create({ name: 'Sankey Drill HH' } as never);
  householdId = household.id;
  await HouseholdMember.create({
    householdId,
    userId,
    role: 'owner',
  } as never);

  sessionToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId,
    tokenHash: hashToken(sessionToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const account = await Account.create({
    householdId,
    name: 'Drill Card',
    accountType: 'credit',
    visibility: 'shared',
  } as never);
  accountId = account.id;

  // Hobbies → Golf → Clublink, the real three-deep production chain.
  const hobbies = await Category.create({ householdId, parentId: null, name: 'Hobbies' } as never);
  categoryIds.set('Hobbies', hobbies.id);
  const golf = await Category.create({ householdId, parentId: hobbies.id, name: 'Golf' } as never);
  categoryIds.set('Golf', golf.id);
  const clublink = await Category.create({
    householdId,
    parentId: golf.id,
    name: 'Clublink',
  } as never);
  categoryIds.set('Clublink', clublink.id);
  const health = await Category.create({
    householdId,
    parentId: null,
    name: 'Healthcare',
  } as never);
  categoryIds.set('Healthcare', health.id);
  const diabetes = await Category.create({
    householdId,
    parentId: health.id,
    name: 'Diabetes',
  } as never);
  categoryIds.set('Diabetes', diabetes.id);

  await makeTxn('CDG LABS', '132734.00', { txnType: 'income' });
  await makeTxn('CLUBLINK DUES', '-34308.00', { category: 'Clublink' });
  await makeTxn('PRO SHOP', '-4938.00', { category: 'Golf' });
  await makeTxn('DIABETES SUPPLY', '-3997.00', { category: 'Diabetes' });
  await makeTxn('HOSTING', '-2878.00', { business: true });

  const { default: app } = await import('../app.js');
  testApp = app;
});

type SankeyBody = {
  nodes: Array<{ name: string; kind: string; categoryId?: number | null }>;
  links: Array<{ source: number; target: number; value: number }>;
  totalIncome: number;
  totalSpend: number;
  surplus: number;
  balanced: boolean;
};

async function fetchSankey(): Promise<SankeyBody> {
  const res = await request(testApp)
    .get('/api/summary/sankey')
    .query({ currency: 'CAD' })
    .set('Cookie', `cashflow_session=${sessionToken}`);
  assert.equal(res.status, 200);
  return res.body as SankeyBody;
}

function findLink(body: SankeyBody, from: string, to: string) {
  const link = body.links.find(
    (l) => body.nodes[l.source]?.name === from && body.nodes[l.target]?.name === to,
  );
  assert.ok(link, `expected a ${from} → ${to} link, got: ${body.links
    .map((l) => `${body.nodes[l.source]?.name}→${body.nodes[l.target]?.name}`)
    .join(', ')}`);
  return link;
}

async function drill(source: number, target: number) {
  const res = await request(testApp)
    .get('/api/summary/sankey/source-transactions')
    .query({ currency: 'CAD', source, target })
    .set('Cookie', `cashflow_session=${sessionToken}`);
  assert.equal(res.status, 200);
  return res.body as {
    transactionCount: number;
    transactions: Array<{ id: number; merchant: string }>;
  };
}

test('GET /api/summary/sankey: emits the full chain from the real category tree', async () => {
  const body = await fetchSankey();
  const names = body.nodes.map((n) => n.name);
  assert.ok(names.includes('Income'));
  assert.ok(names.includes('Corporate expenses'));
  assert.ok(names.includes('Owner draws'));
  assert.ok(names.includes('Surplus'));
  // Hobbies is 93% of personal spend → splits; Golf splits again.
  findLink(body, 'Owner draws', 'Hobbies');
  findLink(body, 'Hobbies', 'Golf');
  findLink(body, 'Golf', 'Clublink');
  // Healthcare is ~10% of spend here, but it has a single child carrying all
  // of it — it may split or not; either way the money is accounted for.
  assert.equal(body.totalSpend, 34308 + 4938 + 3997 + 2878);
  assert.equal(body.balanced, true);
  assert.equal(body.surplus, 132734 - body.totalSpend);
});

test('GET /source-transactions: resolves a depth-3 subcategory edge', async () => {
  const body = await fetchSankey();
  const link = findLink(body, 'Golf', 'Clublink');
  const res = await drill(link.source, link.target);
  assert.equal(res.transactionCount, 1);
  assert.deepEqual(
    res.transactions.map((t) => t.id),
    [txnIds.get('CLUBLINK DUES')],
  );
});

test('GET /source-transactions: a mid-chain edge returns its whole subtree', async () => {
  const body = await fetchSankey();
  const link = findLink(body, 'Hobbies', 'Golf');
  const res = await drill(link.source, link.target);
  assert.equal(res.transactionCount, 2);
  assert.deepEqual(
    res.transactions.map((t) => t.id).sort((a, b) => a - b),
    [txnIds.get('CLUBLINK DUES')!, txnIds.get('PRO SHOP')!].sort((a, b) => a - b),
  );
});

test('GET /source-transactions: the corporate edge returns the business rows', async () => {
  const body = await fetchSankey();
  const link = findLink(body, 'Income', 'Corporate expenses');
  const res = await drill(link.source, link.target);
  assert.equal(res.transactionCount, 1);
  assert.deepEqual(res.transactions.map((t) => t.merchant), ['HOSTING']);
});

test('GET /source-transactions: the surplus edge carries no transactions', async () => {
  const body = await fetchSankey();
  const link = findLink(body, 'Owner draws', 'Surplus');
  const res = await drill(link.source, link.target);
  assert.equal(res.transactionCount, 0);
  assert.deepEqual(res.transactions, []);
});
