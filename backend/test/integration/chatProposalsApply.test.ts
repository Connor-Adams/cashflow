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

test('applyProposal transaction_edit recomputes finals and share columns', async () => {
  // Seed a txn whose finalCategory was driven by autoCategory (no override).
  // After applying an edit that sets categoryOverride, finalCategory must
  // reflect the override — proves recomputeTransactionAmounts ran.
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    merchantClean: 'STARBUCKS',
    amount: '-10.00',
    autoCategory: 'AutoCat',
    categoryOverride: null,
    finalCategory: 'AutoCat',
    autoSplitType: 'shared',
    autoPctMe: '0.5',
    autoPctPartner: '0.5',
    finalSplitType: 'shared',
    finalPctMe: '0.5',
    finalPctPartner: '0.5',
    myShareAmount: '-5.00',
    partnerShareAmount: '-5.00',
    sourceRowFingerprint: 'ape-recompute-1',
  });

  const built = await proposals.buildTransactionEditPreview(
    txnId,
    { category_override: 'NewCat' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, true);

  const txn = await models.Transaction.findByPk(txnId);
  assert.ok(txn);
  // Override column took the patch value.
  assert.equal(txn!.categoryOverride, 'NewCat');
  // Final column reflects the override (would have stayed 'AutoCat' without
  // the recompute call). This is the load-bearing assertion for C2.
  assert.equal(txn!.finalCategory, 'NewCat');
});

test('applyProposal bulk_patch recomputes finals and share columns', async () => {
  // Mirror of the transaction_edit recompute test, for the bulk path.
  const ctx = await makeCtx();
  const ids: number[] = [];
  for (let i = 0; i < 2; i++) {
    ids.push(
      await seedTxn(models, ctx.accountId, ctx.householdId, {
        merchantClean: `STARBUCKS ${i}`,
        amount: '-8.00',
        autoCategory: 'AutoBulkCat',
        categoryOverride: null,
        finalCategory: 'AutoBulkCat',
        autoSplitType: 'me',
        finalSplitType: 'me',
        myShareAmount: '-8.00',
        partnerShareAmount: '0',
        sourceRowFingerprint: `apbp-recompute-${i}`,
        date: `2026-05-${20 + i}`,
      })
    );
  }

  const built = await proposals.buildBulkPatchPreview(
    { merchant_pattern: 'starbucks' },
    { category_override: 'NewBulkCat' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const res = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(res.ok, true);

  const after = await models.Transaction.findAll({ where: { id: ids } });
  assert.equal(after.length, 2);
  for (const row of after) {
    assert.equal(row.categoryOverride, 'NewBulkCat');
    assert.equal(row.finalCategory, 'NewBulkCat');
  }
});

test('buildRuleUpdatePreview rejects non-whitelisted patch keys', async () => {
  // C1: a patch that tries to forge household_id, id, or createdByUserId
  // must be rejected at proposal-build time. No proposal row is created.
  const ctx = await makeCtx();
  const ruleId = await seedRule(models, ctx.householdId, {
    merchantPattern: 'OG',
    category: 'Original',
  });

  for (const badKey of ['household_id', 'id', 'created_by_user_id']) {
    const res = await proposals.buildRuleUpdatePreview(
      ruleId,
      { [badKey]: 999, category: 'Tries' },
      ctx
    );
    assert.ok('error' in res, `expected error for key ${badKey}`);
    if (!('error' in res)) return;
    assert.match(res.error, /not in the rule patch whitelist/);
    assert.match(res.error, new RegExp(badKey));
  }

  // No proposal should have been persisted.
  const proposalCount = await models.ChatProposal.count();
  assert.equal(proposalCount, 0);

  // And the rule itself must be untouched.
  const rule = await models.Rule.findByPk(ruleId);
  assert.equal(rule!.category, 'Original');
});

test('applyRuleUpdate defense-in-depth rejects bad patch persisted on the proposal row', async () => {
  // Defense-in-depth: even if a bad patch somehow lands in the payload
  // (manual DB edit, older buggy code path), applyProposal must throw rather
  // than write a forged field. We tamper with the payload after the preview
  // is built to simulate this.
  const ctx = await makeCtx();
  const ruleId = await seedRule(models, ctx.householdId, {
    merchantPattern: 'DEFENSE',
    category: 'Old',
  });
  const built = await proposals.buildRuleUpdatePreview(
    ruleId,
    { category: 'New' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  // Inject a non-whitelisted key directly into the persisted payload.
  await models.ChatProposal.update(
    {
      payload: { rule_id: ruleId, patch: { household_id: 999, category: 'New' } },
    },
    { where: { id: built.proposal_id } }
  );

  await assert.rejects(
    () => proposals.applyProposal(built.proposal_id, ctx),
    /rule patch validation failed/
  );

  // The rule must NOT have been mutated.
  const rule = await models.Rule.findByPk(ruleId);
  assert.equal(rule!.category, 'Old');
  assert.equal(rule!.householdId, ctx.householdId);
});

test('applyProposal does not downgrade applied status to expired when expiresAt is past', async () => {
  // I1: regression test. An already-applied proposal whose expiresAt is in
  // the past must stay 'applied' and return not_pending — NOT 'expired'.
  const ctx = await makeCtx();
  const txnId = await seedTxn(models, ctx.accountId, ctx.householdId, {
    sourceRowFingerprint: 'ape-i1-1',
  });
  const built = await proposals.buildTransactionEditPreview(
    txnId,
    { notes: 'first apply' },
    ctx
  );
  assert.ok('proposal_id' in built);
  if (!('proposal_id' in built)) return;

  const first = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(first.ok, true);

  // Now rewind expiresAt to the past.
  await models.ChatProposal.update(
    { expiresAt: new Date(Date.now() - 60_000) },
    { where: { id: built.proposal_id } }
  );

  // Second call should be not_pending (because status is 'applied'), NOT
  // 'expired'. And the persisted status must stay 'applied'.
  const second = await proposals.applyProposal(built.proposal_id, ctx);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.code, 'not_pending');

  const proposal = await models.ChatProposal.findByPk(built.proposal_id);
  assert.equal(proposal!.status, 'applied');
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
