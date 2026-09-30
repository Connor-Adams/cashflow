/**
 * Skip reasons for the stage-8 orchestrator. `attempted: false` used to be the
 * only observable outcome, so "no OpenAI configured" and "nothing left to
 * categorise" were the same value — which is how a fallback that had never run
 * in production stayed invisible for months.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ColdRow } from './aiBatchOverColdRows';
import { summarizeReportingCashflow } from '../../reporting/cashflowTotals';
import { aggregateSankey } from '../../summary/aggregateSankey';
import { computeImportConfidence } from '../computeImportConfidence';

let models: typeof import('../../models');
let orch: typeof import('./aiBatchOverColdRows');

before(async () => {
  models = await import('../../models');
  await models.sequelize.sync({ force: true });
  orch = await import('./aiBatchOverColdRows');
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

function coldRow(): ColdRow {
  return {
    txnId: 1,
    signals: [],
    merchantKey: 'SHOPPERS DRUG MART',
    merchantRaw: 'SHOPPERS DRUG MART #1234',
    merchantClean: 'Shoppers Drug Mart',
    merchantCanonical: null,
    amount: -12.34,
    date: '2026-06-01',
    currency: 'CAD',
    memory: null,
    accountVisibility: 'private',
    txnType: 'purchase',
  };
}

test('no OpenAI configuration reports no_openai_config', async () => {
  const summary = await orch.maybeRunAiBatchOverColdRows([coldRow()], 1);
  assert.equal(summary.attempted, false);
  assert.equal(summary.skipReason, 'no_openai_config');
});

test('no cold rows reports no_cold_rows — and is checked before the OpenAI gate', async () => {
  const summary = await orch.maybeRunAiBatchOverColdRows([], 1);
  assert.equal(summary.attempted, false);
  assert.equal(summary.skipReason, 'no_cold_rows');
  assert.equal(summary.coldRowCount, 0);
});

// ---------------------------------------------------------------------------
// final_category persistence (PR #1140 follow-up).
//
// The stage used to write `auto_category` and omit `final_category`, which is
// the column every read path actually aggregates on (spend rollups, the Sankey
// aggregator, the uncategorised bucket). A row this stage resolved therefore
// stayed in the uncategorised bucket forever, making the whole fallback inert.
//
// These tests assert through the REAL read paths rather than the column alone:
// a column-only assertion would have passed even while the feature did nothing
// user-visible.
// ---------------------------------------------------------------------------

async function household() {
  const hh = await models.Household.create({ name: `H-${Math.random()}` } as never);
  const acc = await models.Account.create({
    householdId: hh.id,
    name: 'Card',
    visibility: 'private',
  } as never);
  return { hh, acc };
}

/** A review-flagged row of the shape the import paths hand to this stage. */
async function coldTxnRow(
  hh: { id: number },
  acc: { id: number },
  opts: { categoryOverride?: string | null } = {},
) {
  const fp = `cold-${Math.random()}`;
  const override = opts.categoryOverride ?? null;
  const txn = await models.Transaction.create({
    accountId: acc.id,
    householdId: hh.id,
    visibility: 'private',
    importBatch: 'import',
    date: '2026-06-01',
    amount: '-12.34',
    currency: 'CAD',
    merchantRaw: 'AI CAFE #22',
    merchantClean: 'AI Cafe',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: true,
    finalSplitType: 'me',
    categoryOverride: override,
    // A row carrying an override already has final_category resolved to it.
    finalCategory: override,
  } as never);
  const row: ColdRow = {
    txnId: txn.id,
    signals: [],
    merchantKey: 'AI Cafe',
    merchantRaw: 'AI CAFE #22',
    merchantClean: 'AI Cafe',
    merchantCanonical: null,
    amount: -12.34,
    date: '2026-06-01',
    currency: 'CAD',
    memory: null,
    accountVisibility: 'private',
    txnType: 'purchase',
    categoryOverride: override,
  };
  return { txn, row };
}

/** Stub caller that answers every merchant with a single canned category. */
function callerFor(merchantKey: string, category: string) {
  return async () => ({
    results: {
      [merchantKey]: {
        category,
        business: false,
        splitType: 'me',
        pctMe: 1,
        pctPartner: 0,
        confidence: 'high',
        rationale: 'cafe',
      },
    },
  });
}

/** Re-read the row through the projection the reporting/Sankey routes use. */
async function readBack(txnId: number) {
  const fresh = await models.Transaction.findByPk(txnId);
  assert.ok(fresh);
  return fresh;
}

test('AI-categorised cold row lands in final_category and leaves the uncategorised bucket', async () => {
  const { hh, acc } = await household();
  const { row } = await coldTxnRow(hh, acc);
  process.env.OPENAI_API_KEY = 'test-key';

  const summary = await orch.maybeRunAiBatchOverColdRows([row], hh.id, {
    openaiCaller: callerFor('AI Cafe', 'Dining'),
  });
  assert.equal(summary.enhanced, 1, 'the stage reported it enhanced the row');

  const fresh = await readBack(row.txnId);
  assert.equal(fresh.autoCategory, 'Dining');
  assert.equal(fresh.finalCategory, 'Dining', 'final_category is the column every rollup reads');

  // Read path 1: the reporting spend rollup buckets essential spend off
  // finalCategory. Before the fix this row contributed 0 essential spend.
  const totals = summarizeReportingCashflow(
    [{ amount: fresh.amount, txnType: fresh.txnType, finalCategory: fresh.finalCategory }],
    new Set(['dining']),
  );
  assert.equal(totals.totalSpend, 12.34);
  assert.equal(totals.essentialSpend, 12.34, 'row is attributed to its category, not dropped');

  // Read path 2: the Sankey aggregator's uncategorised bucket.
  const sankey = aggregateSankey(
    [
      {
        id: fresh.id,
        date: fresh.date,
        currency: 'CAD',
        finalCategory: fresh.finalCategory,
        finalBusiness: false,
        merchantRaw: fresh.merchantRaw,
        merchantClean: fresh.merchantClean,
        amount: fresh.amount,
        txnType: fresh.txnType,
        accountType: null,
      },
    ],
    'CAD',
  );
  assert.equal(
    sankey.nodes.some((n) => n.kind === 'uncategorized'),
    false,
    'no uncategorised node remains',
  );
  assert.ok(
    sankey.nodes.some((n) => n.name === 'Dining'),
    'the row renders under its resolved category',
  );
});

test('AI stage never clobbers a user categoryOverride in final_category', async () => {
  const { hh, acc } = await household();
  const { row } = await coldTxnRow(hh, acc, { categoryOverride: 'Groceries' });
  process.env.OPENAI_API_KEY = 'test-key';

  const summary = await orch.maybeRunAiBatchOverColdRows([row], hh.id, {
    openaiCaller: callerFor('AI Cafe', 'Dining'),
  });
  assert.equal(summary.enhanced, 1);

  const fresh = await readBack(row.txnId);
  // The AI suggestion is still recorded as the machine's opinion...
  assert.equal(fresh.autoCategory, 'Dining');
  // ...but the human's explicit choice still wins the resolved column.
  assert.equal(fresh.categoryOverride, 'Groceries');
  assert.equal(fresh.finalCategory, 'Groceries', 'user override beats autoCategory');
});

test('import_confidence matches the final_category actually persisted', async () => {
  const { hh, acc } = await household();
  const { row } = await coldTxnRow(hh, acc);
  process.env.OPENAI_API_KEY = 'test-key';

  await orch.maybeRunAiBatchOverColdRows([row], hh.id, {
    openaiCaller: callerFor('AI Cafe', 'Dining'),
  });

  const fresh = await readBack(row.txnId);
  const recomputed = computeImportConfidence({
    reviewFlag: fresh.reviewFlag,
    finalCategory: fresh.finalCategory,
    autoCategory: fresh.autoCategory,
    autoSplitType: fresh.autoSplitType,
    finalSplitType: fresh.finalSplitType,
    txnType: fresh.txnType,
    accountVisibility: 'private',
    linkedTransactionId: fresh.linkedTransactionId,
    amount: -12.34,
  });
  assert.equal(
    fresh.importConfidence,
    recomputed.state,
    'the stored classification is reproducible from the stored columns',
  );

  // The stage tells computeImportConfidence that final_category is set. That
  // claim is only honest if the column really is set, so assert the stored
  // classification still holds with autoCategory blanked out — final_category
  // alone must carry it. `hasCategory` is `finalCategory || autoCategory`, so
  // this is the assertion that actually distinguishes the two.
  const fromFinalCategoryAlone = computeImportConfidence({
    reviewFlag: fresh.reviewFlag,
    finalCategory: fresh.finalCategory,
    autoCategory: null,
    autoSplitType: fresh.autoSplitType,
    finalSplitType: fresh.finalSplitType,
    txnType: fresh.txnType,
    accountVisibility: 'private',
    linkedTransactionId: fresh.linkedTransactionId,
    amount: -12.34,
  });
  assert.equal(
    fromFinalCategoryAlone.flags.includes('missing_category'),
    false,
    'final_category alone satisfies the category check the stage claimed',
  );
  assert.equal(fresh.importConfidence, fromFinalCategoryAlone.state);
});

// ---------------------------------------------------------------------------
// category id + flat name persistence.
//
// `Transaction.update` is a STATIC update, so it bypasses the `beforeSave` hook
// that reconciles `auto_category` / `final_category` into their `*_category_id`
// columns. The writer therefore has to resolve the category itself. It also has
// to write the resolved leaf's FLAT name: `loadCategoryHints` feeds the model
// path-form hints ("Household / Rent") which it echoes back, and every budget
// and spend rollup joins `final_category` as an exact string — so a path form
// in that column matches no budget at all.
// ---------------------------------------------------------------------------

test('persistAiEnhancement writes a flat name and the category id, never a path', async () => {
  const { hh, acc } = await household();
  const houseRoot = await models.Category.create({
    householdId: hh.id,
    name: 'Household',
    parentId: null,
  } as never);
  const rent = await models.Category.create({
    householdId: hh.id,
    name: 'Rent',
    parentId: houseRoot.id,
  } as never);
  const { txn, row } = await coldTxnRow(hh, acc);

  // The model echoes back a hint from loadCategoryHints, which is path-form.
  const persisted = await orch.persistAiEnhancement(
    row,
    { source: 'ai', confidence: 'high', fields: { autoCategory: 'Household / Rent' } },
    hh.id,
  );
  assert.equal(persisted, true);

  await txn.reload();
  assert.equal(txn.finalCategory, 'Rent', 'the path form must never reach final_category');
  assert.equal(txn.finalCategoryId, rent.id);
  assert.equal(txn.autoCategory, 'Rent');
  assert.equal(txn.autoCategoryId, rent.id);
  assert.equal(
    await models.Category.count({ where: { householdId: hh.id } }),
    2,
    'no new category is created',
  );
});
