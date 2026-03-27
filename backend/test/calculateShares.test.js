const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  splitAmount,
  businessAmount,
  recomputeTransactionAmounts,
} = require('../src/import/calculateShares');

test('splitAmount: me gets full amount', () => {
  const r = splitAmount(-100, 'me', null, null);
  assert.equal(r.myShareAmount, -100);
  assert.equal(r.partnerShareAmount, 0);
});

test('splitAmount: shared 50/50', () => {
  const r = splitAmount(100, 'shared', 0.5, 0.5);
  assert.equal(r.myShareAmount, 50);
  assert.equal(r.partnerShareAmount, 50);
});

test('businessAmount respects flag', () => {
  assert.equal(businessAmount(-40, true), -40);
  assert.equal(businessAmount(-40, false), 0);
});

test('recomputeTransactionAmounts sets finals', () => {
  const t = {
    amount: -20,
    categoryOverride: null,
    autoCategory: 'Food',
    businessOverride: null,
    autoBusiness: true,
    splitOverride: null,
    autoSplitType: 'me',
    pctMeOverride: null,
    autoPctMe: null,
    pctPartnerOverride: null,
    autoPctPartner: null,
  };
  const out = recomputeTransactionAmounts(t);
  assert.equal(out.finalCategory, 'Food');
  assert.equal(out.finalBusiness, true);
  assert.equal(out.myShareAmount, -20);
});
