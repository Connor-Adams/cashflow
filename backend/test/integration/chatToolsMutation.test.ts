/**
 * Integration tests for the 5 mutation tools (PR2 Task 9).
 *
 * Verifies each propose_* tool creates the correct ChatProposal row with the
 * right `kind`, `payload`, and `preview` shape, and returns `{ proposal_id }`
 * to the caller. Also exercises the patch whitelist + bulk_patch limit.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupChatTestDb,
  teardownChatTestDb,
  wipeChatTestTables,
  seedHousehold,
  seedUser,
  seedTxn,
  seedRule,
  seedThreadWithMessage,
} from './chat/_helpers';

let models: Awaited<ReturnType<typeof setupChatTestDb>>['models'];
let dbPath: string;
let dispatchTool: typeof import('../../src/ai/chat/tools.js').dispatchTool;

before(async () => {
  const setup = await setupChatTestDb('test-integration-chat-tools-mutation.sqlite');
  models = setup.models;
  dbPath = setup.dbPath;
  const toolsMod = await import('../../src/ai/chat/tools.js');
  dispatchTool = toolsMod.dispatchTool;
});

after(async () => {
  // Restore the bulk-patch limit env (some tests override it).
  delete process.env.CHAT_BULK_PATCH_LIMIT;
  await teardownChatTestDb(models, dbPath);
});

beforeEach(async () => {
  delete process.env.CHAT_BULK_PATCH_LIMIT;
  await wipeChatTestTables(models);
});

async function makeCtx() {
  const { householdId, accountId } = await seedHousehold(models);
  const userId = await seedUser(models, 'mut');
  const { threadId, messageId } = await seedThreadWithMessage(models, userId);
  return { userId, householdId, threadId, messageId, accountId };
}

test('propose_transaction_edit creates pending ChatProposal with before/after preview', async () => {
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    createdByUserId: ctx.userId,
    visibility: 'shared',
    merchantClean: 'BLUE BOTTLE',
    categoryOverride: null,
    sourceRowFingerprint: 'pte-1',
  });

  const res = await dispatchTool(
    'propose_transaction_edit',
    JSON.stringify({
      transaction_id: txnId,
      patch: { category_override: 'Coffee', notes: 'love it' },
    }),
    ctx
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as { proposal_id: number; preview: Record<string, unknown> };
  assert.ok(typeof data.proposal_id === 'number');
  const before = (data.preview as { before: Record<string, unknown> }).before;
  const after = (data.preview as { after: Record<string, unknown> }).after;
  assert.equal(before.categoryOverride, null);
  assert.equal(after.categoryOverride, 'Coffee');
  assert.equal(after.notes, 'love it');

  const row = await models.ChatProposal.findByPk(data.proposal_id);
  assert.ok(row);
  assert.equal(row!.kind, 'transaction_edit');
  assert.equal(row!.status, 'pending');
  assert.equal(row!.threadId, ctx.threadId);
  assert.equal(row!.messageId, ctx.messageId);
  const payload = row!.payload as { transaction_id: number; patch: Record<string, unknown> };
  assert.equal(payload.transaction_id, txnId);
  assert.equal(payload.patch.category_override, 'Coffee');
});

test('propose_transaction_edit rejects nonexistent transaction id', async () => {
  const ctx = await makeCtx();
  const res = await dispatchTool(
    'propose_transaction_edit',
    JSON.stringify({
      transaction_id: 999999,
      patch: { notes: 'will not stick' },
    }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /not visible/);
});

test('propose_transaction_edit rejects non-whitelisted patch field (auto_category)', async () => {
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    sourceRowFingerprint: 'pte-w-1',
  });
  const res = await dispatchTool(
    'propose_transaction_edit',
    JSON.stringify({
      transaction_id: txnId,
      patch: { auto_category: 'Sneaky' },
    }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /not in the patch whitelist/);
  // No ChatProposal row should have been created.
  const count = await models.ChatProposal.count();
  assert.equal(count, 0);
});

test('propose_transaction_edit rejects empty patch', async () => {
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    sourceRowFingerprint: 'pte-empty-1',
  });
  const res = await dispatchTool(
    'propose_transaction_edit',
    JSON.stringify({ transaction_id: txnId, patch: {} }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /at least one whitelisted field/);
});

test('propose_transaction_edit does not see cross-member private rows', async () => {
  const ctx = await makeCtx();
  const otherUserId = await seedUser(models, 'other');
  const privateTxnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    visibility: 'private',
    createdByUserId: otherUserId,
    merchantClean: 'OTHER PRIVATE',
    sourceRowFingerprint: 'pte-private-1',
  });
  const res = await dispatchTool(
    'propose_transaction_edit',
    JSON.stringify({
      transaction_id: privateTxnId,
      patch: { notes: 'should not see' },
    }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /not visible/);
});

test('propose_bulk_patch returns matched_count + sample (≤10) and persists proposal', async () => {
  const ctx = await makeCtx();
  for (let i = 0; i < 6; i++) {
    await seedTxn(models, ctx.accountId, ctx.householdId, {
      merchantClean: `COFFEE ${i}`,
      categoryOverride: null,
      sourceRowFingerprint: `pbp-${i}`,
      date: `2026-05-${10 + i}`,
    });
  }
  const res = await dispatchTool(
    'propose_bulk_patch',
    JSON.stringify({
      filter: { merchant_pattern: 'coffee' },
      patch: { category_override: 'Dining' },
    }),
    ctx
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    proposal_id: number;
    preview: { matched_count: number; sample: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> };
  };
  assert.equal(data.preview.matched_count, 6);
  assert.ok(data.preview.sample.length <= 10);
  assert.equal(data.preview.sample.length, 6);
  for (const s of data.preview.sample) {
    assert.equal(s.before.categoryOverride, null);
    assert.equal(s.after.categoryOverride, 'Dining');
  }
  const row = await models.ChatProposal.findByPk(data.proposal_id);
  assert.ok(row);
  assert.equal(row!.kind, 'bulk_patch');
  assert.equal(row!.status, 'pending');
});

test('propose_bulk_patch caps sample at 10 even when more match', async () => {
  const ctx = await makeCtx();
  for (let i = 0; i < 15; i++) {
    await seedTxn(models, ctx.accountId, ctx.householdId, {
      merchantClean: `TIM HORTONS ${i}`,
      sourceRowFingerprint: `pbp-cap-${i}`,
      date: `2026-05-${10 + (i % 20)}`,
    });
  }
  const res = await dispatchTool(
    'propose_bulk_patch',
    JSON.stringify({
      filter: { merchant_pattern: 'tim horto' },
      patch: { category_override: 'Coffee' },
    }),
    ctx
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    preview: { matched_count: number; sample: unknown[] };
  };
  assert.equal(data.preview.matched_count, 15);
  assert.equal(data.preview.sample.length, 10);
});

test('propose_bulk_patch returns filter_too_broad when matched_count > limit', async () => {
  // Lower the limit so we only need to seed a few rows.
  process.env.CHAT_BULK_PATCH_LIMIT = '3';
  const ctx = await makeCtx();
  for (let i = 0; i < 5; i++) {
    await seedTxn(models, ctx.accountId, ctx.householdId, {
      merchantClean: `STARBUCKS ${i}`,
      sourceRowFingerprint: `pbp-too-${i}`,
      date: `2026-05-${10 + i}`,
    });
  }
  const res = await dispatchTool(
    'propose_bulk_patch',
    JSON.stringify({
      filter: { merchant_pattern: 'starbucks' },
      patch: { category_override: 'Coffee' },
    }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /filter_too_broad/);
  assert.match(res.error, /5 rows match/);
  // No proposal row should have been created.
  const count = await models.ChatProposal.count();
  assert.equal(count, 0);
});

test('propose_bulk_patch rejects non-whitelisted patch field', async () => {
  const ctx = await makeCtx();
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    merchantClean: 'STORE',
    sourceRowFingerprint: 'pbp-w-1',
  });
  const res = await dispatchTool(
    'propose_bulk_patch',
    JSON.stringify({
      filter: { merchant_pattern: 'store' },
      patch: { auto_category: 'Bad' },
    }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /not in the patch whitelist/);
});

test('propose_rule_create creates pending proposal with rule_preview + would_affect_count', async () => {
  const ctx = await makeCtx();
  // Seed transactions that would match the rule's pattern.
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    merchantClean: 'NETFLIX SUB',
    sourceRowFingerprint: 'prc-1',
  });
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    merchantClean: 'NETFLIX RENEW',
    sourceRowFingerprint: 'prc-2',
  });
  // Non-matching row.
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    merchantClean: 'AMAZON',
    sourceRowFingerprint: 'prc-3',
  });
  const res = await dispatchTool(
    'propose_rule_create',
    JSON.stringify({
      merchant_pattern: 'netflix',
      category: 'Streaming',
      split_type: 'shared',
    }),
    ctx
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    proposal_id: number;
    preview: {
      rule_preview: Record<string, unknown>;
      would_affect_existing_count: number;
    };
  };
  assert.equal(data.preview.would_affect_existing_count, 2);
  assert.equal(data.preview.rule_preview.merchant_pattern, 'netflix');
  assert.equal(data.preview.rule_preview.category, 'Streaming');
  const row = await models.ChatProposal.findByPk(data.proposal_id);
  assert.ok(row);
  assert.equal(row!.kind, 'rule_create');
  assert.equal(row!.status, 'pending');
});

test('propose_rule_create rejects missing merchant_pattern', async () => {
  const ctx = await makeCtx();
  const res = await dispatchTool(
    'propose_rule_create',
    JSON.stringify({ category: 'Streaming' }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /merchant_pattern is required/);
});

test('propose_rule_update creates pending proposal with before/after + would_affect_count', async () => {
  const ctx = await makeCtx();
  const ruleId = await seedRule(models, ctx.householdId, {
    merchantPattern: 'COSTCO',
    category: 'Groceries',
  });
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    merchantClean: 'COSTCO WHOLESALE',
    sourceRowFingerprint: 'pru-1',
  });
  const res = await dispatchTool(
    'propose_rule_update',
    JSON.stringify({
      rule_id: ruleId,
      patch: { category: 'Warehouse' },
    }),
    ctx
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    proposal_id: number;
    preview: {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      would_affect_existing_count: number;
    };
  };
  assert.equal(data.preview.before.category, 'Groceries');
  assert.equal(data.preview.after.category, 'Warehouse');
  assert.equal(data.preview.would_affect_existing_count, 1);
  const row = await models.ChatProposal.findByPk(data.proposal_id);
  assert.ok(row);
  assert.equal(row!.kind, 'rule_update');
  const payload = row!.payload as { rule_id: number; patch: Record<string, unknown> };
  assert.equal(payload.rule_id, ruleId);
  assert.equal(payload.patch.category, 'Warehouse');
});

test('propose_rule_update rejects unknown rule id', async () => {
  const ctx = await makeCtx();
  const res = await dispatchTool(
    'propose_rule_update',
    JSON.stringify({ rule_id: 999999, patch: { category: 'X' } }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /not visible/);
});

test('propose_rule_delete creates pending proposal with rule_summary', async () => {
  const ctx = await makeCtx();
  const ruleId = await seedRule(models, ctx.householdId, {
    merchantPattern: 'DOOMED',
    category: 'Dying',
  });
  const res = await dispatchTool(
    'propose_rule_delete',
    JSON.stringify({ rule_id: ruleId }),
    ctx
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const data = res.data as {
    proposal_id: number;
    preview: { rule_summary: Record<string, unknown> };
  };
  assert.equal(data.preview.rule_summary.merchantPattern, 'DOOMED');
  const row = await models.ChatProposal.findByPk(data.proposal_id);
  assert.ok(row);
  assert.equal(row!.kind, 'rule_delete');
  const payload = row!.payload as { rule_id: number };
  assert.equal(payload.rule_id, ruleId);
  // The rule itself should still exist (delete happens at apply-time).
  const rule = await models.Rule.findByPk(ruleId);
  assert.ok(rule);
});

test('propose_rule_delete rejects unknown rule id', async () => {
  const ctx = await makeCtx();
  const res = await dispatchTool(
    'propose_rule_delete',
    JSON.stringify({ rule_id: 999999 }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /not visible/);
});

test('propose_transaction_edit rejects missing transaction_id', async () => {
  const ctx = await makeCtx();
  const res = await dispatchTool(
    'propose_transaction_edit',
    JSON.stringify({ patch: { notes: 'x' } }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /transaction_id is required/);
});

test('propose_rule_update rejects missing rule_id', async () => {
  const ctx = await makeCtx();
  const res = await dispatchTool(
    'propose_rule_update',
    JSON.stringify({ patch: { category: 'X' } }),
    ctx
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /rule_id is required/);
});
