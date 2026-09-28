/**
 * Skip reasons for the stage-8 orchestrator. `attempted: false` used to be the
 * only observable outcome, so "no OpenAI configured" and "nothing left to
 * categorise" were the same value — which is how a fallback that had never run
 * in production stayed invisible for months.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ColdRow } from './aiBatchOverColdRows';

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
