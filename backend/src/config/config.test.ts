import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getChatConfig } from './chat';

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CHAT_')) delete process.env[k];
  }
  delete process.env.OPENAI_MODEL;
});

test('getChatConfig model precedence: CHAT_MODEL > OPENAI_MODEL > default', () => {
  delete process.env.OPENAI_MODEL;
  assert.equal(getChatConfig().model, 'gpt-4o-mini');
  process.env.OPENAI_MODEL = 'gpt-4.1';
  assert.equal(getChatConfig().model, 'gpt-4.1');
  process.env.CHAT_MODEL = 'gpt-4o';
  assert.equal(getChatConfig().model, 'gpt-4o');
});

test('getChatConfig numeric env vars parse and have sensible defaults', () => {
  const d = getChatConfig();
  assert.equal(d.dailyTokenBudget, 200_000);
  assert.equal(d.maxToolCallsPerTurn, 8);
  assert.equal(d.proposalDriftPct, 0.2);
  assert.equal(d.proposalExpiryHours, 24);
  assert.equal(d.perThreadMessagesPerHour, 30);
  assert.equal(d.historyWindowMessages, 20);

  process.env.CHAT_DAILY_TOKEN_BUDGET = '50000';
  process.env.CHAT_MAX_TOOL_CALLS_PER_TURN = '4';
  process.env.CHAT_PROPOSAL_DRIFT_PCT = '0.5';
  const c = getChatConfig();
  assert.equal(c.dailyTokenBudget, 50_000);
  assert.equal(c.maxToolCallsPerTurn, 4);
  assert.equal(c.proposalDriftPct, 0.5);
});

test('getChatConfig rejects invalid numerics by falling back to defaults', () => {
  process.env.CHAT_DAILY_TOKEN_BUDGET = 'foo';
  process.env.CHAT_PROPOSAL_DRIFT_PCT = '5';
  const c = getChatConfig();
  assert.equal(c.dailyTokenBudget, 200_000);
  assert.equal(c.proposalDriftPct, 0.2);
});
