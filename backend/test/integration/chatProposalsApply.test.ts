/**
 * Integration tests for applyProposal (PR2 Task 9).
 *
 * Verifies the proposal-apply lifecycle across all five kinds:
 *   - transaction_edit: updates the row + writes role=tool message
 *   - bulk_patch: drift detection + cross-row update
 *   - rule_create / rule_update / rule_delete: mutate the Rule table
 * Also tests state transitions: not_pending, expired, count_drifted, not_found.
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
let proposals: typeof import('../../src/ai/chat/proposals.js');

before(async () => {
  const setup = await setupChatTestDb('test-integration-chat-proposals-apply.sqlite');
  models = setup.models;
  dbPath = setup.dbPath;
  proposals = await import('../../src/ai/chat/proposals.js');
});

after(async () => {
  delete process.env.CHAT_BULK_PATCH_LIMIT;
  delete process.env.CHAT_PROPOSAL_DRIFT_PCT;
  delete process.env.CHAT_PROPOSAL_EXPIRY_HOURS;
  await teardownChatTestDb(models, dbPath);
});

beforeEach(async () => {
  delete process.env.CHAT_BULK_PATCH_LIMIT;
  delete process.env.CHAT_PROPOSAL_DRIFT_PCT;
  delete process.env.CHAT_PROPOSAL_EXPIRY_HOURS;
  await wipeChatTestTables(models);
});

async function makeCtx() {
  const { householdId, accountId } = await seedHousehold(models);
  const userId = await seedUser(models, 'apply');
  const { threadId, messageId } = await seedThreadWithMessage(models, userId);
  return { userId, householdId, threadId, messageId, accountId };
}

test('applyProposal returns not_found for unknown proposal id', async () => {
  const ctx = await makeCtx();
  const res = await proposals.applyProposal(999999, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'not_found');
});

test('applyProposal applies transaction_edit, marks applied, writes role=tool message', async () => {
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    createdByUserId: ctx.userId,
    visibility: 'shared',
    merchantClean: 'COFFEE PLACE',
    categoryOverride: null,
    notes: null,
    sourceRowFingerprint: 'ape-1',
  });
  const built = await proposals.buildTransactionEditPreview(
    txnId,
    { category_override: 'Coffee', notes: 'morning fuel' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.status, 'applied');
  assert.equal((res.result as { updated_id: number }).updated_id, txnId);

  // Row was patched.
  const txn = await models.Transaction.findByPk(txnId);
  assert.ok(txn);
  assert.equal(txn!.categoryOverride, 'Coffee');
  assert.equal(txn!.notes, 'morning fuel');

  // Proposal status -> applied.
  const proposal = await models.ChatProposal.findByPk(built.proposal_id);
  assert.equal(proposal!.status, 'applied');
  assert.ok(proposal!.appliedAt instanceof Date);
  assert.deepEqual(proposal!.appliedResult, { updated_id: txnId });

  // role=tool message appended.
  const messages = await models.ChatMessage.findAll({
    where: { threadId: ctx.threadId, role: 'tool' },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].toolCallId, `proposal_${built.proposal_id}`);
  assert.equal(messages[0].toolName, 'apply_transaction_edit');
  const parsed = JSON.parse(messages[0].contentText ?? '');
  assert.equal(parsed.applied, 'transaction_edit');
  assert.equal(parsed.result.updated_id, txnId);
});

test('applyProposal twice on same proposal returns not_pending second time', async () => {
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    sourceRowFingerprint: 'ape-2x-1',
  });
  const built = await proposals.buildTransactionEditPreview(
    txnId,
    { notes: 'first' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;
  const first = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(first.ok, true);

  const second = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.code, 'not_pending');
  assert.match(second.message, /applied/);
});

test('applyProposal returns expired and marks status=expired when past expiresAt', async () => {
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    sourceRowFingerprint: 'ape-exp-1',
  });
  const built = await proposals.buildTransactionEditPreview(
    txnId,
    { notes: 'too late' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;
  // Force expiry by rewinding expiresAt.
  await models.ChatProposal.update(
    { expiresAt: new Date(Date.now() - 60_000) },
    { where: { id: built.proposal_id } }
  );

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'expired');

  const proposal = await models.ChatProposal.findByPk(built.proposal_id);
  assert.equal(proposal!.status, 'expired');

  // Source row should NOT have been mutated.
  const txn = await models.Transaction.findByPk(txnId);
  assert.notEqual(txn!.notes, 'too late');
});

test('applyProposal bulk_patch updates all matching rows + writes role=tool message', async () => {
  const ctx = await makeCtx();
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    ids.push(
      await seedTxn(models, ctx.accountId, ctx.householdId, {
        merchantClean: `WHOLE FOODS ${i}`,
        categoryOverride: null,
        sourceRowFingerprint: `apbp-${i}`,
        date: `2026-05-${10 + i}`,
      })
    );
  }
  const built = await proposals.buildBulkPatchPreview(
    { merchant_pattern: 'whole foods' },
    { category_override: 'Groceries' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const r = res.result as { updated_count: number; ids: number[] };
  assert.equal(r.updated_count, 4);
  assert.deepEqual([...r.ids].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));

  // All rows were patched.
  const after = await models.Transaction.findAll({ where: { id: ids } });
  assert.equal(after.length, 4);
  for (const row of after) {
    assert.equal(row.categoryOverride, 'Groceries');
  }

  // role=tool message exists.
  const msgs = await models.ChatMessage.findAll({
    where: { threadId: ctx.threadId, role: 'tool' },
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].toolName, 'apply_bulk_patch');
});

test('applyProposal bulk_patch returns count_drifted when matched set grows past threshold', async () => {
  process.env.CHAT_PROPOSAL_DRIFT_PCT = '0.1'; // 10% threshold
  const ctx = await makeCtx();
  // Seed 2 rows initially.
  for (let i = 0; i < 2; i++) {
    await seedTxn(models, ctx.accountId, ctx.householdId, {
      merchantClean: `LOBLAWS ${i}`,
      sourceRowFingerprint: `apbp-d-${i}`,
      date: `2026-05-${10 + i}`,
    });
  }
  const built = await proposals.buildBulkPatchPreview(
    { merchant_pattern: 'loblaws' },
    { category_override: 'Groceries' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  // Insert 4 more matching rows between preview and apply.
  for (let i = 0; i < 4; i++) {
    await seedTxn(models, ctx.accountId, ctx.householdId, {
      merchantClean: `LOBLAWS LATE ${i}`,
      sourceRowFingerprint: `apbp-d-late-${i}`,
      date: `2026-06-${10 + i}`,
    });
  }

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'count_drifted');
  assert.equal((res.extra as { preview_count: number }).preview_count, 2);
  assert.equal((res.extra as { current_count: number }).current_count, 6);

  // Proposal should still be pending (drift halts the apply but doesn't mark
  // it applied or rejected — user can re-issue the proposal with a refined
  // filter).
  const proposal = await models.ChatProposal.findByPk(built.proposal_id);
  assert.equal(proposal!.status, 'pending');
});

test('applyProposal rule_create inserts a Rule with ctx fields', async () => {
  const ctx = await makeCtx();
  const built = await proposals.buildRuleCreatePreview(
    {
      merchant_pattern: 'SPOTIFY',
      category: 'Streaming',
      split_type: 'shared',
      pct_me: 0.5,
      pct_partner: 0.5,
      effective_from: '2026-01-01',
    },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const ruleId = (res.result as { rule_id: number }).rule_id;
  const rule = await models.Rule.findByPk(ruleId);
  assert.ok(rule);
  assert.equal(rule!.merchantPattern, 'SPOTIFY');
  assert.equal(rule!.category, 'Streaming');
  assert.equal(rule!.splitType, 'shared');
  assert.equal(rule!.effectiveFrom, '2026-01-01');
  assert.equal(rule!.householdId, ctx.householdId);
  assert.equal(rule!.createdByUserId, ctx.userId);
});

test('applyProposal rule_update patches the Rule', async () => {
  const ctx = await makeCtx();
  const ruleId = await seedRule(models, ctx.householdId, {
    merchantPattern: 'OLDNAME',
    category: 'OldCat',
  });
  const built = await proposals.buildRuleUpdatePreview(
    ruleId,
    { category: 'NewCat', priority: 99 },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal((res.result as { rule_id: number }).rule_id, ruleId);

  const updated = await models.Rule.findByPk(ruleId);
  assert.equal(updated!.category, 'NewCat');
  assert.equal(updated!.priority, 99);
  // Untouched fields preserved.
  assert.equal(updated!.merchantPattern, 'OLDNAME');
});

test('applyProposal rule_delete removes the Rule', async () => {
  const ctx = await makeCtx();
  const ruleId = await seedRule(models, ctx.householdId, {
    merchantPattern: 'GOODBYE',
  });
  const built = await proposals.buildRuleDeletePreview(ruleId, ctx);
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal((res.result as { deleted_rule_id: number }).deleted_rule_id, ruleId);

  const gone = await models.Rule.findByPk(ruleId);
  assert.equal(gone, null);
});

test('applyProposal returns not_found when proposal is in a different thread', async () => {
  const ctx = await makeCtx();
  // Build a proposal in thread A.
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    sourceRowFingerprint: 'ape-other-1',
  });
  const built = await proposals.buildTransactionEditPreview(
    txnId,
    { notes: 'in other thread' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  // Create thread B for the same user.
  const otherThread = await seedThreadWithMessage(models, ctx.userId);
  const res = await proposals.applyProposal(built.proposal_id, {
    ...ctx,
    threadId: otherThread.threadId,
    messageId: otherThread.messageId,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'not_found');
});

test('applyProposal applied result contains discriminated kind in message contentText', async () => {
  const ctx = await makeCtx();
  const ruleId = await seedRule(models, ctx.householdId, {
    merchantPattern: 'TARGET',
    category: 'Misc',
  });
  const built = await proposals.buildRuleDeletePreview(ruleId, ctx);
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;
  await proposals.applyProposal(built.proposal_id, ctx);
  const msgs = await models.ChatMessage.findAll({
    where: { threadId: ctx.threadId, role: 'tool' },
  });
  assert.equal(msgs.length, 1);
  const parsed = JSON.parse(msgs[0].contentText ?? '');
  assert.equal(parsed.applied, 'rule_delete');
  assert.equal(parsed.result.deleted_rule_id, ruleId);
});
