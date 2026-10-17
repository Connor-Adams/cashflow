import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCards } from './summarizeCards';
import { makeCadConverter } from '../fx/cadConverter';
import type { FxLookup } from '../networth/unifyToCad';

const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.4, ratedDate: asOf };
  return null;
};
const toCad = makeCadConverter('2026-02-01', stubFx);

const card = (over: Partial<Parameters<typeof summarizeCards>[0][number]>) => ({
  currency: 'CAD',
  currentBalance: 0,
  statementBalance: null,
  minimumPayment: 0,
  closed: false,
  ...over,
});

test('summarizeCards: USD and CAD cards total in CAD (not labelled with the first card currency)', async () => {
  const totals = await summarizeCards(
    [
      card({ currency: 'USD', currentBalance: 2000, minimumPayment: 50 }),
      card({ currency: 'CAD', currentBalance: 999, statementBalance: 10000, minimumPayment: 200 }),
    ],
    toCad,
  );
  assert.deepEqual(totals, {
    currency: 'CAD',
    statementOwed: 12800,
    minimumDue: 270,
    unconvertedCurrencies: [],
  });
});

test('summarizeCards: closed cards and unconvertible currencies are left out of the totals', async () => {
  const totals = await summarizeCards(
    [
      card({ currency: 'CAD', currentBalance: 100, minimumPayment: 10 }),
      card({ currency: 'CAD', statementBalance: 5000, minimumPayment: 100, closed: true }),
      card({ currency: 'EUR', currentBalance: 300, minimumPayment: 20 }),
    ],
    toCad,
  );
  assert.deepEqual(totals, {
    currency: 'CAD',
    statementOwed: 100,
    minimumDue: 10,
    unconvertedCurrencies: ['EUR'],
  });
});
