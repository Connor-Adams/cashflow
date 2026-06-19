/**
 * Integration tests for generalized rule actions (issue #795):
 *  - POST/PATCH /api/rules accept/validate `actions[]`, derive scalar columns.
 *  - set_label attaches a TransactionLabel during import (AC #4).
 *  - set_alert writes a `rule_action_fired` Notification (AC #5).
 *  - a multi-action rule fires all effects on one match (AC #7).
 *  - a set_label to a deleted label is skipped, not fatal (AC #9).
 *  - validation 400 codes (AC #8).
 *  - export emits actions[]; importing a scalars-only v1 file derives them and
 *    importing a file WITH actions applies + syncs scalars (AC #10, #11).
 *
 * Runs in isolation (`yarn test:integration`) against Postgres.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let accountId: number;
let householdId: number;
let userId: number;
let models: typeof import('../../src/models/index.js');

async function importTxns(batchLabel: string, lines: string): Promise<number[]> {
  const csv = `Date,Description,Amount\n${lines}`;
  const imp = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .field('batchLabel', batchLabel)
    .attach('file', Buffer.from(csv, 'utf8'), { filename: `${batchLabel}.csv`, contentType: 'text/csv' });
  assert.equal(imp.status, 200, `import failed: ${JSON.stringify(imp.body)}`);
  const list = await authed.get(
    `/api/transactions?pageSize=100&importBatch=${encodeURIComponent(batchLabel)}`,
  );
  assert.equal(list.status, 200);
  return (list.body.data as { id: number }[]).map((t) => t.id);
}

async function createLabel(name: string): Promise<number> {
  const r = await authed.post('/api/labels').send({ name });
  assert.equal(r.status, 201, `createLabel failed: ${JSON.stringify(r.body)}`);
  return r.body.id as number;
}

before(async () => {
  testDb = await setupPgTestDb('rule-actions');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'ruleactions@example.com',
    displayName: 'Rule Actions',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  userId = register.body.user.id as number;

  const acc = await authed.post('/api/accounts').send({
    name: 'Rule Actions Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  accountId = acc.body.id as number;
  const accountRow = await models.Account.findByPk(accountId);
  householdId = accountRow!.householdId as number;
});

beforeEach(async () => {
  await models.Rule.destroy({ where: { householdId } });
  await models.Notification.destroy({ where: { userId } });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// AC #3 — legacy scalar-only body derives actions; actions[] body derives scalars.
test('POST /api/rules: scalar-only body derives actions; actions[] body derives scalars', async () => {
  const legacy = await authed.post('/api/rules').send({
    merchantPattern: 'SCALAR-ONLY',
    category: 'Groceries',
    isBusiness: true,
  });
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.body.actions, [
    { type: 'set_category', payload: { category: 'Groceries' } },
    { type: 'set_business', payload: { isBusiness: true } },
  ]);

  const withActions = await authed.post('/api/rules').send({
    merchantPattern: 'WITH-ACTIONS',
    actions: [{ type: 'set_category', payload: { category: 'Dining' } }],
  });
  assert.equal(withActions.status, 201);
  assert.equal(withActions.body.category, 'Dining');
});

// AC #4 + #5 + #7 — multi-action rule attaches a label + raises an alert on import.
test('import: rule with set_label + set_alert fires both on a match', async () => {
  const labelId = await createLabel('reimbursable');
  const create = await authed.post('/api/rules').send({
    merchantPattern: 'ACME',
    matchKind: 'substring',
    actions: [
      { type: 'set_category', payload: { category: 'Office' } },
      { type: 'set_label', payload: { labelId } },
      { type: 'set_alert', payload: { severity: 'warn', title: 'ACME charge', body: 'A charge from ACME landed' } },
    ],
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const ruleId = create.body.id as number;

  const [txnId] = await importTxns('acme-batch', '2026-06-01,ACME SUPPLIES,-42.00\n');

  // set_category flowed through the scalar Signal path.
  const txn = await models.Transaction.findByPk(txnId);
  assert.equal(txn!.appliedRuleId, ruleId);
  assert.equal(txn!.autoCategory, 'Office');

  // set_label attached the label via TransactionLabel.
  const link = await models.TransactionLabel.findOne({ where: { transactionId: txnId, labelId } });
  assert.ok(link, 'expected a TransactionLabel row');

  // set_alert wrote a rule_action_fired notification to the rule owner.
  const notif = await models.Notification.findOne({
    where: { userId, type: 'rule_action_fired' },
  });
  assert.ok(notif, 'expected a rule_action_fired notification');
  assert.equal(notif!.severity, 'warn');
  assert.equal(notif!.title, 'ACME charge');
  assert.equal(notif!.body, 'A charge from ACME landed');
  assert.deepEqual(notif!.dataJson, { ruleId, transactionId: txnId });
});

// AC #9 — a set_label to a since-deleted label is skipped, no throw, no link.
test('import: dangling set_label is skipped, not fatal', async () => {
  const labelId = await createLabel('temp-label');
  const create = await authed.post('/api/rules').send({
    merchantPattern: 'DANGLE',
    actions: [{ type: 'set_label', payload: { labelId } }],
  });
  assert.equal(create.status, 201);
  // Delete the label out from under the rule (DB-level; the rule still
  // references it so we exercise the apply-time skip, not the editor guard).
  await models.Label.destroy({ where: { id: labelId } });

  const [txnId] = await importTxns('dangle-batch', '2026-06-02,DANGLE CO,-10.00\n');
  assert.ok(txnId, 'import must still succeed');
  const link = await models.TransactionLabel.findOne({ where: { transactionId: txnId } });
  assert.equal(link, null, 'no link should be written for a dangling label');
});

// AC #8 — validation rejects each bad-input case with the documented 400 codes.
test('POST /api/rules: validation 400 codes', async () => {
  const otherLabelId = 999999; // not in household

  const cases: Array<{ actions: unknown; error: string }> = [
    { actions: [{ type: 'bogus', payload: {} }], error: 'INVALID_ACTION_TYPE' },
    { actions: [{ type: 'set_split', payload: { splitType: 'thirds' } }], error: 'INVALID_SPLIT' },
    { actions: [{ type: 'set_label', payload: { labelId: otherLabelId } }], error: 'INVALID_TAG' },
    { actions: [{ type: 'set_alert', payload: { severity: 'nope' } }], error: 'INVALID_ALERT' },
    {
      actions: [
        { type: 'set_category', payload: { category: 'A' } },
        { type: 'set_category', payload: { category: 'B' } },
      ],
      error: 'DUPLICATE_ACTION',
    },
  ];

  for (const c of cases) {
    const res = await authed.post('/api/rules').send({ merchantPattern: `BAD-${c.error}`, actions: c.actions });
    assert.equal(res.status, 400, `expected 400 for ${c.error}`);
    assert.equal(res.body.error, c.error);
  }
});

// AC #10 — export emits actions[]; a scalars-only v1 file imports with derived actions.
test('export emits actions[]; pre-#795 scalars-only file imports with derived actions', async () => {
  await authed.post('/api/rules').send({ merchantPattern: 'EXPO', category: 'Travel', isBusiness: true });

  const exported = await authed.get('/api/rules/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.schemaVersion, 1);
  const expRule = exported.body.rules.find((r: { merchantPattern: string }) => r.merchantPattern === 'EXPO');
  assert.ok(Array.isArray(expRule.actions));
  assert.deepEqual(expRule.actions, [
    { type: 'set_category', payload: { category: 'Travel' } },
    { type: 'set_business', payload: { isBusiness: true } },
  ]);

  // Simulate a pre-#795 v1 file: strip the actions key entirely.
  const legacyFile = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    rules: exported.body.rules.map((r: Record<string, unknown>) => {
      const { actions, ...rest } = r;
      void actions;
      return rest;
    }),
  };
  const imp = await authed.post('/api/rules/import').send({ mode: 'replace', json: legacyFile });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const reimported = await models.Rule.findOne({ where: { householdId, merchantPattern: 'EXPO' } });
  assert.equal(reimported!.category, 'Travel');
  assert.equal(reimported!.isBusiness, true);
  assert.deepEqual(reimported!.actions, [
    { type: 'set_category', payload: { category: 'Travel' } },
    { type: 'set_business', payload: { isBusiness: true } },
  ]);
});

// AC #11 — importing a file WITH actions applies them and keeps scalars in sync.
test('import: file with actions applies them and syncs scalar columns', async () => {
  const labelId = await createLabel('imported-label');
  const file = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    rules: [
      {
        merchantPattern: 'HASACTIONS',
        matchKind: 'substring',
        priority: 0,
        category: null,
        isBusiness: false,
        splitType: 'me',
        pctMe: null,
        pctPartner: null,
        effectiveFrom: null,
        effectiveTo: null,
        actions: [
          { type: 'set_category', payload: { category: 'Subscriptions' } },
          { type: 'set_label', payload: { labelId } },
        ],
      },
    ],
  };
  const imp = await authed.post('/api/rules/import').send({ mode: 'replace', json: file });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.imported, 1);
  const row = await models.Rule.findOne({ where: { householdId, merchantPattern: 'HASACTIONS' } });
  // scalar synced from set_category
  assert.equal(row!.category, 'Subscriptions');
  // actions persisted including set_label
  assert.equal(row!.actions.some((a) => a.type === 'set_label'), true);
});
