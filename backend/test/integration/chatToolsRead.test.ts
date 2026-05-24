/**
 * Integration tests for the chat read tools and dispatcher (PR2 Task 8).
 *
 * Spins up an isolated SQLite DB via migrations, seeds a household + a few
 * transactions/rules/contacts, then exercises dispatchTool against each of the
 * five read tools.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-chat-tools-read.sqlite');

let models: typeof import('../../src/models/index.js');
let dispatchTool: typeof import('../../src/ai/chat/tools.js').dispatchTool;

const ctx = { userId: 1, householdId: 1, threadId: 1, messageId: 1 };

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  models = await import('../../src/models/index.js');
  const toolsMod = await import('../../src/ai/chat/tools.js');
  dispatchTool = toolsMod.dispatchTool;
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

async function seedHousehold(): Promise<{ householdId: number; accountId: number }> {
  const household = await models.Household.create({ name: 'Tools House' } as never);
  const account = await models.Account.create({
    name: 'Checking',
    owner: 'me',
    householdId: household.id,
  } as never);
  return { householdId: household.id, accountId: account.id };
}

async function seedUser(label: string): Promise<number> {
  const user = await models.User.create({
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: label,
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  return user.id;
}

async function seedTxn(
  accountId: number,
  householdId: number,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await models.Transaction.create({
    accountId,
    householdId,
    // Default to shared visibility so the read tools' visibility scoping
    // (mirrors visibleTransactionWhere) does not silently exclude seeds in
    // tests that aren't specifically exercising visibility. Tests that need
    // private rows override this.
    visibility: 'shared',
    importBatch: 'seed',
    date: '2026-05-10',
    merchantRaw: 'COFFEE SHOP',
    merchantClean: 'COFFEE SHOP',
    amount: '5.00',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${Math.random()}`,
    finalCategory: 'Dining',
    finalSplitType: 'me',
    finalBusiness: false,
    myShareAmount: '5.00',
    partnerShareAmount: '0',
    businessAmount: '0',
    reviewFlag: false,
    ...overrides,
  } as never);
}

beforeEach(async () => {
  // Wipe all rows between tests but keep schema. Order matters for FKs.
  await models.Transaction.destroy({ where: {} });
  await models.Rule.destroy({ where: {} });
  await models.Contact.destroy({ where: {} });
  await models.Account.destroy({ where: {} });
  await models.HouseholdMember.destroy({ where: {} });
  await models.Household.destroy({ where: {} });
  await models.User.destroy({ where: {} });
});

test('query_transactions returns matching rows + count and respects limit', async () => {
  const { householdId, accountId } = await seedHousehold();
  for (let i = 0; i < 5; i++) {
    await seedTxn(accountId, householdId, {
      merchantClean: `STORE ${i}`,
      sourceRowFingerprint: `q-${i}`,
      date: `2026-05-${10 + i}`,
    });
  }
  const res = await dispatchTool(
    'query_transactions',
    JSON.stringify({ limit: 2 }),
    { ...ctx, householdId }
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as { matched_count: number; rows: unknown[] };
  assert.equal(data.matched_count, 5);
  assert.equal(data.rows.length, 2);
});

test('query_transactions honors date_from, date_to, and merchant_pattern', async () => {
  const { householdId, accountId } = await seedHousehold();
  await seedTxn(accountId, householdId, {
    merchantClean: 'STARBUCKS CAFE',
    date: '2026-01-15',
    sourceRowFingerprint: 'sb-1',
  });
  await seedTxn(accountId, householdId, {
    merchantClean: 'STARBUCKS DOWNTOWN',
    date: '2026-03-15',
    sourceRowFingerprint: 'sb-2',
  });
  await seedTxn(accountId, householdId, {
    merchantClean: 'TIM HORTONS',
    date: '2026-03-15',
    sourceRowFingerprint: 'th-1',
  });

  const res = await dispatchTool(
    'query_transactions',
    JSON.stringify({
      merchant_pattern: 'starbucks',
      date_from: '2026-02-01',
      date_to: '2026-04-01',
    }),
    { ...ctx, householdId }
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    matched_count: number;
    rows: Array<{ merchant_clean: string }>;
  };
  assert.equal(data.matched_count, 1, 'only the March STARBUCKS row should match');
  assert.equal(data.rows[0].merchant_clean, 'STARBUCKS DOWNTOWN');
});

test('get_summary scope=dashboard returns count and totals', async () => {
  const { householdId, accountId } = await seedHousehold();
  await seedTxn(accountId, householdId, {
    amount: '10.00',
    myShareAmount: '10.00',
    sourceRowFingerprint: 'd-1',
  });
  await seedTxn(accountId, householdId, {
    amount: '20.00',
    myShareAmount: '15.00',
    partnerShareAmount: '5.00',
    sourceRowFingerprint: 'd-2',
  });
  const res = await dispatchTool(
    'get_summary',
    JSON.stringify({ scope: 'dashboard' }),
    { ...ctx, householdId }
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const d = res.data as Record<string, unknown>;
  assert.equal(d.count, 2);
  // Aggregates come back as strings under SQLite — coerce to compare.
  assert.equal(Number(d.total_amount), 30);
  assert.equal(Number(d.total_my_share), 25);
  assert.equal(Number(d.total_partner_share), 5);
});

test('get_summary rejects missing or unknown scope', async () => {
  const { householdId } = await seedHousehold();
  const missing = await dispatchTool('get_summary', '{}', { ...ctx, householdId });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /scope is required/);

  const unknown = await dispatchTool(
    'get_summary',
    JSON.stringify({ scope: 'nope' }),
    { ...ctx, householdId }
  );
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /unknown scope/);
});

test('get_rules returns all rules; with active_on filters by effective bounds', async () => {
  const { householdId } = await seedHousehold();
  await models.Rule.create({
    merchantPattern: 'ALWAYS',
    householdId,
    matchKind: 'substring',
    priority: 1,
    category: 'Misc',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  } as never);
  await models.Rule.create({
    merchantPattern: 'JAN ONLY',
    householdId,
    matchKind: 'substring',
    priority: 2,
    category: 'Sub',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-02-01',
  } as never);
  await models.Rule.create({
    merchantPattern: 'FUTURE',
    householdId,
    matchKind: 'substring',
    priority: 3,
    category: 'X',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: '2026-12-01',
    effectiveTo: null,
  } as never);

  const all = await dispatchTool('get_rules', '{}', { ...ctx, householdId });
  assert.equal(all.ok, true);
  if (!all.ok) return;
  assert.equal((all.data as unknown[]).length, 3);

  const onJan15 = await dispatchTool(
    'get_rules',
    JSON.stringify({ active_on: '2026-01-15' }),
    { ...ctx, householdId }
  );
  assert.equal(onJan15.ok, true);
  if (!onJan15.ok) return;
  const names = (onJan15.data as Array<{ merchantPattern: string }>).map(
    (r) => r.merchantPattern
  );
  assert.ok(names.includes('ALWAYS'));
  assert.ok(names.includes('JAN ONLY'));
  assert.ok(!names.includes('FUTURE'));
});

test('get_contacts returns the household contacts', async () => {
  const { householdId } = await seedHousehold();
  await models.Contact.create({
    householdId,
    name: 'Alice',
    notes: null,
  } as never);
  await models.Contact.create({
    householdId,
    name: 'Bob',
    notes: null,
  } as never);

  const res = await dispatchTool('get_contacts', '{}', { ...ctx, householdId });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const rows = res.data as Array<{ id: number; name: string; currency: string | null }>;
  assert.equal(rows.length, 2);
  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['Alice', 'Bob']);
  for (const r of rows) assert.equal(r.currency, null);
});

test('get_categories deduplicates between rules and transactions', async () => {
  const { householdId, accountId } = await seedHousehold();
  await seedTxn(accountId, householdId, {
    finalCategory: 'Dining',
    sourceRowFingerprint: 'c-1',
  });
  await seedTxn(accountId, householdId, {
    finalCategory: 'Groceries',
    sourceRowFingerprint: 'c-2',
  });
  await models.Rule.create({
    merchantPattern: 'X',
    householdId,
    matchKind: 'substring',
    priority: 1,
    category: 'Dining', // duplicates a transaction category
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  } as never);
  await models.Rule.create({
    merchantPattern: 'Y',
    householdId,
    matchKind: 'substring',
    priority: 1,
    category: 'Subscriptions', // unique to rules
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  } as never);

  const res = await dispatchTool('get_categories', '{}', { ...ctx, householdId });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as { categories: string[] };
  assert.deepEqual(data.categories, ['Dining', 'Groceries', 'Subscriptions']);
});

test('query_transactions excludes private rows from other household members', async () => {
  const { householdId, accountId } = await seedHousehold();
  const thisUserId = await seedUser('this-user');
  const otherUserId = await seedUser('other-user');
  // thisUser: one shared, one private
  await seedTxn(accountId, householdId, {
    visibility: 'shared',
    createdByUserId: thisUserId,
    merchantClean: 'OWN SHARED',
    sourceRowFingerprint: 'vis-own-shared',
  });
  await seedTxn(accountId, householdId, {
    visibility: 'private',
    createdByUserId: thisUserId,
    merchantClean: 'OWN PRIVATE',
    sourceRowFingerprint: 'vis-own-private',
  });
  // otherUser: one private (should be hidden), one shared (should be visible)
  await seedTxn(accountId, householdId, {
    visibility: 'private',
    createdByUserId: otherUserId,
    merchantClean: 'OTHER PRIVATE',
    sourceRowFingerprint: 'vis-other-private',
  });
  await seedTxn(accountId, householdId, {
    visibility: 'shared',
    createdByUserId: otherUserId,
    merchantClean: 'OTHER SHARED',
    sourceRowFingerprint: 'vis-other-shared',
  });

  const res = await dispatchTool(
    'query_transactions',
    JSON.stringify({ limit: 50 }),
    { ...ctx, householdId, userId: thisUserId }
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    matched_count: number;
    rows: Array<{ merchant_clean: string }>;
  };
  const names = data.rows.map((r) => r.merchant_clean).sort();
  assert.deepEqual(names, ['OTHER SHARED', 'OWN PRIVATE', 'OWN SHARED']);
  assert.equal(data.matched_count, 3);
  assert.ok(!names.includes('OTHER PRIVATE'), 'other member private row leaked');
});

test('query_transactions is case-insensitive on merchant_pattern (SQLite Op.like; Postgres uses Op.iLike)', async () => {
  const { householdId, accountId } = await seedHousehold();
  await seedTxn(accountId, householdId, {
    merchantClean: 'Whole Foods Market',
    sourceRowFingerprint: 'ci-1',
  });
  const res = await dispatchTool(
    'query_transactions',
    JSON.stringify({ merchant_pattern: 'whole foods' }),
    { ...ctx, householdId }
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    matched_count: number;
    rows: Array<{ merchant_clean: string }>;
  };
  assert.equal(data.matched_count, 1);
  assert.equal(data.rows[0].merchant_clean, 'Whole Foods Market');
});

test('get_summary scope=dashboard excludes private rows from other household members', async () => {
  const { householdId, accountId } = await seedHousehold();
  const thisUserId = await seedUser('sum-this');
  const otherUserId = await seedUser('sum-other');
  await seedTxn(accountId, householdId, {
    visibility: 'shared',
    createdByUserId: thisUserId,
    amount: '10.00',
    myShareAmount: '10.00',
    sourceRowFingerprint: 'sum-own-shared',
  });
  await seedTxn(accountId, householdId, {
    visibility: 'private',
    createdByUserId: thisUserId,
    amount: '20.00',
    myShareAmount: '20.00',
    sourceRowFingerprint: 'sum-own-private',
  });
  // Excluded: other member's private row
  await seedTxn(accountId, householdId, {
    visibility: 'private',
    createdByUserId: otherUserId,
    amount: '1000.00',
    myShareAmount: '1000.00',
    sourceRowFingerprint: 'sum-other-private',
  });
  const res = await dispatchTool(
    'get_summary',
    JSON.stringify({ scope: 'dashboard' }),
    { ...ctx, householdId, userId: thisUserId }
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const d = res.data as Record<string, unknown>;
  assert.equal(d.count, 2, 'only own-shared + own-private should count');
  assert.equal(Number(d.total_amount), 30, 'other member private row must be excluded');
});

test('dispatchTool with unknown tool name returns error', async () => {
  const res = await dispatchTool('not_a_tool', '{}', ctx);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /unknown/);
});

test('dispatchTool with malformed JSON args returns error', async () => {
  const res = await dispatchTool('query_transactions', '{not json', ctx);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /valid JSON/);
});
