import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainMonth } from './explainMonth';
import { buildExplainMonthAiSummary } from './explainMonthAiSummary';

function baseResult() {
  return explainMonth({
    month: '2026-05',
    currentTxns: [],
    previousTxns: [],
    subscriptions: [],
    currency: null,
  });
}

const CFG = { apiKey: 'test-key', model: 'gpt-test', baseUrl: 'http://localhost' };

test('buildExplainMonthAiSummary reports not_configured when no key is set', async () => {
  let called = false;
  const out = await buildExplainMonthAiSummary(baseResult(), {
    getConfig: () => null,
    callJson: async () => {
      called = true;
      return { summary: 'never' };
    },
  });
  assert.deepEqual(out, { aiSummary: null, aiSummaryStatus: 'not_configured' });
  assert.equal(called, false);
});

test('buildExplainMonthAiSummary reports ok with the trimmed summary', async () => {
  const out = await buildExplainMonthAiSummary(baseResult(), {
    getConfig: () => CFG,
    callJson: async () => ({ summary: '  Spend was flat.  ' }),
  });
  assert.deepEqual(out, { aiSummary: 'Spend was flat.', aiSummaryStatus: 'ok' });
});

test('buildExplainMonthAiSummary reports failed when the key is set but the call throws', async () => {
  const out = await buildExplainMonthAiSummary(baseResult(), {
    getConfig: () => CFG,
    callJson: async () => {
      throw new Error('timeout');
    },
  });
  assert.deepEqual(out, { aiSummary: null, aiSummaryStatus: 'failed' });
});

test('buildExplainMonthAiSummary reports failed when the model returns no usable summary', async () => {
  const out = await buildExplainMonthAiSummary(baseResult(), {
    getConfig: () => CFG,
    callJson: async () => ({ summary: '   ' }),
  });
  assert.deepEqual(out, { aiSummary: null, aiSummaryStatus: 'failed' });
});

test('explainMonth defaults aiSummaryStatus to not_requested', () => {
  assert.equal(baseResult().aiSummaryStatus, 'not_requested');
});
