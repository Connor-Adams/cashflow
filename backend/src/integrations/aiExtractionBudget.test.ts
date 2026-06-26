import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ProcessedEmailMessage, Household } from '../models';
import {
  startOfUtcDay,
  countTodaysAiExtractions,
  makeAiExtractionBudget,
  openDailyAiBudget,
} from './aiExtractionBudget';

const HH = 1;

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ id: HH, name: 'HH' } as never);
});

beforeEach(async () => {
  await ProcessedEmailMessage.destroy({ where: {} });
  delete process.env.EMAIL_AI_EXTRACTIONS_PER_DAY;
});

afterEach(() => {
  delete process.env.EMAIL_AI_EXTRACTIONS_PER_DAY;
});

async function logRow(over: { parser: string | null; scannedAt: Date; messageId: string }) {
  await ProcessedEmailMessage.create({
    householdId: HH,
    provider: 'google',
    messageId: over.messageId,
    status: 'extracted',
    parser: over.parser,
    scannedAt: over.scannedAt,
  } as never);
}

test('startOfUtcDay zeroes the time in UTC', () => {
  const d = startOfUtcDay(new Date('2026-06-26T17:45:12.345Z'));
  assert.equal(d.toISOString(), '2026-06-26T00:00:00.000Z');
});

test('countTodaysAiExtractions counts only ai-parser rows from today', async () => {
  const now = new Date('2026-06-26T12:00:00.000Z');
  await logRow({ parser: 'ai', scannedAt: now, messageId: 'a1' });
  await logRow({ parser: 'ai', scannedAt: now, messageId: 'a2' });
  // deterministic parser — free, not counted
  await logRow({ parser: 'apple', scannedAt: now, messageId: 'd1' });
  // yesterday's ai extraction — not counted
  await logRow({ parser: 'ai', scannedAt: new Date('2026-06-25T23:59:00.000Z'), messageId: 'y1' });

  assert.equal(await countTodaysAiExtractions(HH, now), 2);
});

test('makeAiExtractionBudget consumes down to zero then caps', () => {
  const b = makeAiExtractionBudget(2);
  assert.equal(b.remaining(), 2);
  assert.equal(b.tryConsume(), true);
  assert.equal(b.tryConsume(), true);
  assert.equal(b.exhausted(), true);
  assert.equal(b.tryConsume(), false);
  assert.equal(b.tryConsume(), false);
  assert.equal(b.capped(), 2);
  assert.equal(b.remaining(), 0);
});

test('makeAiExtractionBudget floors a negative remaining at zero', () => {
  const b = makeAiExtractionBudget(-5);
  assert.equal(b.remaining(), 0);
  assert.equal(b.tryConsume(), false);
});

test('openDailyAiBudget = cap minus today spend', async () => {
  process.env.EMAIL_AI_EXTRACTIONS_PER_DAY = '5';
  const now = new Date('2026-06-26T12:00:00.000Z');
  await logRow({ parser: 'ai', scannedAt: now, messageId: 'a1' });
  await logRow({ parser: 'ai', scannedAt: now, messageId: 'a2' });
  const b = await openDailyAiBudget(HH, now);
  assert.equal(b.remaining(), 3);
});

test('openDailyAiBudget gives full cap for null household', async () => {
  process.env.EMAIL_AI_EXTRACTIONS_PER_DAY = '7';
  const b = await openDailyAiBudget(null);
  assert.equal(b.remaining(), 7);
});
